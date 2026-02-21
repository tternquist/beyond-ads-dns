import os from "node:os";
import path from "node:path";
import fsPromises from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerSystemRoutes(app, ctx) {
  const { redisUrl, clickhouseEnabled, startTimestamp, formatBytes,
          readMergedConfig, defaultConfigPath, configPath,
          getContainerMemoryLimitBytes, getRaspberryPiModel, getRaspberryPiDebugInfo } = ctx;

  app.get("/api/health", async (_req, res) => {
    res.json({ ok: true, redisUrl, clickhouseEnabled });
  });

  app.get("/api/system/cpu-count", (_req, res) => {
    try {
      const n = typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;
      const count = Math.max(1, Math.min(64, n || 1));
      res.json({ cpuCount: count });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to get CPU count" });
    }
  });

  app.get("/api/system/resources", (_req, res) => {
    try {
      const cpuCount = Math.max(
        1,
        Math.min(
          64,
          typeof os.availableParallelism === "function"
            ? os.availableParallelism()
            : (os.cpus()?.length || 1)
        )
      );
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const totalMemoryMB = Math.round(totalMemBytes / (1024 * 1024));
      const freeMemoryMB = Math.round(freeMemBytes / (1024 * 1024));

      const containerMemBytes = getContainerMemoryLimitBytes();
      const containerMemoryLimitMB =
        containerMemBytes != null ? Math.round(containerMemBytes / (1024 * 1024)) : null;
      const effectiveMemoryMB = containerMemoryLimitMB ?? totalMemoryMB;

      const raspberryPiModel = getRaspberryPiModel();

      let redisLruSize, maxInflight, maxBatchSize, queryStoreBatchSize;
      if (raspberryPiModel === "pi4" || raspberryPiModel === "pi_other") {
        redisLruSize = 10000;
        maxInflight = 25;
        maxBatchSize = 2000;
        queryStoreBatchSize = 2000;
      } else if (raspberryPiModel === "pi5") {
        if (effectiveMemoryMB <= 2048) {
          redisLruSize = 3000;
          maxInflight = 30;
          maxBatchSize = 1500;
          queryStoreBatchSize = 1500;
        } else {
          redisLruSize = 10000;
          maxInflight = 50;
          maxBatchSize = 2000;
          queryStoreBatchSize = 2000;
        }
      } else if (cpuCount <= 2 && effectiveMemoryMB <= 1024) {
        redisLruSize = 3000;
        maxInflight = 30;
        maxBatchSize = 1000;
        queryStoreBatchSize = 1000;
      } else if (cpuCount <= 4 && effectiveMemoryMB <= 4096) {
        redisLruSize = 15000;
        maxInflight = 60;
        maxBatchSize = 2000;
        queryStoreBatchSize = 2000;
      } else if (cpuCount <= 8 && effectiveMemoryMB <= 8192) {
        redisLruSize = 50000;
        maxInflight = 125;
        maxBatchSize = 2000;
        queryStoreBatchSize = 2000;
      } else {
        redisLruSize = 100000;
        maxInflight = 175;
        maxBatchSize = 2000;
        queryStoreBatchSize = 2000;
      }

      res.json({
        cpuCount,
        totalMemoryMB,
        freeMemoryMB,
        containerMemoryLimitMB,
        raspberryPiModel,
        recommended: {
          reuse_port_listeners: cpuCount,
          redis_lru_size: redisLruSize,
          max_inflight: maxInflight,
          max_batch_size: maxBatchSize,
          query_store_batch_size: queryStoreBatchSize,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to detect resources" });
    }
  });

  app.get("/api/system/debug/raspberry-pi", (_req, res) => {
    try {
      res.json(getRaspberryPiDebugInfo());
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to get debug info" });
    }
  });

  app.get("/api/info", async (_req, res) => {
    try {
      const hostname =
        process.env.UI_HOSTNAME ||
        process.env.HOSTNAME ||
        (await readMergedConfig(defaultConfigPath, configPath))?.ui?.hostname ||
        os.hostname();

      const mem = process.memoryUsage();
      const memoryUsage = formatBytes(mem.heapUsed);

      let buildTimestamp = process.env.BUILD_TIMESTAMP || null;
      if (!buildTimestamp) {
        try {
          const buildPath = path.join(__dirname, "..", "..", "build-timestamp.txt");
          const ts = await fsPromises.readFile(buildPath, "utf8");
          buildTimestamp = ts?.trim() || null;
        } catch { /* File not present in dev */ }
      }

      let releaseTag = process.env.RELEASE_TAG || null;
      if (!releaseTag) {
        try {
          const tagPath = path.join(__dirname, "..", "..", "release-tag.txt");
          const tag = await fsPromises.readFile(tagPath, "utf8");
          releaseTag = tag?.trim() || null;
        } catch { /* File not present in dev */ }
      }

      const loadavg = os.loadavg();
      const load1 = loadavg && loadavg[0] != null && (loadavg[0] > 0 || loadavg[1] > 0 || loadavg[2] > 0)
        ? loadavg[0].toFixed(2)
        : null;

      res.json({
        hostname: hostname.trim() || os.hostname(),
        memoryUsage,
        buildTimestamp,
        startTimestamp,
        releaseTag,
        load1,
      });
    } catch (err) {
      const hostname =
        process.env.UI_HOSTNAME || process.env.HOSTNAME || os.hostname();
      const mem = process.memoryUsage();
      const loadavg = os.loadavg();
      const load1 = loadavg && loadavg[0] != null && (loadavg[0] > 0 || loadavg[1] > 0 || loadavg[2] > 0)
        ? loadavg[0].toFixed(2)
        : null;

      res.json({
        hostname: hostname.trim() || os.hostname(),
        memoryUsage: formatBytes(mem.heapUsed),
        buildTimestamp: process.env.BUILD_TIMESTAMP || null,
        startTimestamp,
        releaseTag: process.env.RELEASE_TAG || null,
        load1,
      });
    }
  });
}
