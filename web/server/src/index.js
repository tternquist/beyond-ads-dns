import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient as createRedisClient } from "redis";
import { createClient as createClickhouseClient } from "@clickhouse/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(options = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const redisUrl = options.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
  const clickhouseEnabled =
    options.clickhouseEnabled ??
    parseBoolean(process.env.CLICKHOUSE_ENABLED, false);
  const clickhouseUrl =
    options.clickhouseUrl ||
    process.env.CLICKHOUSE_URL ||
    "http://localhost:8123";
  const clickhouseDatabase =
    options.clickhouseDatabase ||
    process.env.CLICKHOUSE_DATABASE ||
    "beyond_ads";
  const clickhouseTable =
    options.clickhouseTable || process.env.CLICKHOUSE_TABLE || "dns_queries";
  const clickhouseUser =
    options.clickhouseUser || process.env.CLICKHOUSE_USER || "default";
  const clickhousePassword =
    options.clickhousePassword || process.env.CLICKHOUSE_PASSWORD || "";

  const redisClient = createRedisClient({ url: redisUrl });
  redisClient.on("error", (err) => {
    console.error("Redis client error:", err);
  });

  let clickhouseClient = null;
  if (clickhouseEnabled) {
    clickhouseClient = createClickhouseClient({
      url: clickhouseUrl,
      database: clickhouseDatabase,
      username: clickhouseUser,
      password: clickhousePassword,
    });
  }

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      redisUrl,
      clickhouseEnabled,
    });
  });

  app.get("/api/redis/summary", async (_req, res) => {
    try {
      const info = await redisClient.info();
      const parsed = parseRedisInfo(info);
      const hits = toNumber(parsed.keyspace_hits);
      const misses = toNumber(parsed.keyspace_misses);
      const totalRequests = hits + misses;
      const hitRate = totalRequests > 0 ? hits / totalRequests : null;
      const keyspace = parseKeyspace(parsed.db0);

      res.json({
        hits,
        misses,
        totalRequests,
        hitRate,
        evictedKeys: toNumber(parsed.evicted_keys),
        usedMemory: toNumber(parsed.used_memory),
        usedMemoryHuman: parsed.used_memory_human || null,
        connectedClients: toNumber(parsed.connected_clients),
        keyspace,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to fetch Redis info" });
    }
  });

  app.get("/api/queries/recent", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, rows: [] });
      return;
    }
    const limit = clampNumber(req.query.limit, 50, 1, 500);
    const query = `
      SELECT ts, client_ip, protocol, qname, qtype, qclass, outcome, rcode, duration_ms
      FROM ${clickhouseDatabase}.${clickhouseTable}
      ORDER BY ts DESC
      LIMIT {limit: UInt32}
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { limit },
      });
      const rows = await result.json();
      res.json({ enabled: true, rows: rows.data || [] });
    } catch (err) {
      res.status(500).json({ enabled: true, error: err.message || "Query failed" });
    }
  });

  app.get("/api/queries/summary", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, windowMinutes: null, total: 0, statuses: [] });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT outcome, count() as count
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
      GROUP BY outcome
      ORDER BY count DESC
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const statuses = (rows.data || []).map((row) => ({
        outcome: row.outcome,
        count: toNumber(row.count),
      }));
      const total = statuses.reduce((sum, row) => sum + row.count, 0);
      res.json({ enabled: true, windowMinutes, total, statuses });
    } catch (err) {
      res.status(500).json({ enabled: true, error: err.message || "Query failed" });
    }
  });

  app.get("/api/queries/latency", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        windowMinutes: null,
        count: 0,
        avgMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT
        count() as count,
        avg(duration_ms) as avg,
        min(duration_ms) as min,
        max(duration_ms) as max,
        quantile(0.5)(duration_ms) as p50,
        quantile(0.95)(duration_ms) as p95,
        quantile(0.99)(duration_ms) as p99
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const stats = rows.data && rows.data.length > 0 ? rows.data[0] : {};
      const count = toNumber(stats.count);
      res.json({
        enabled: true,
        windowMinutes,
        count,
        avgMs: count ? toNumber(stats.avg) : null,
        minMs: count ? toNumber(stats.min) : null,
        maxMs: count ? toNumber(stats.max) : null,
        p50Ms: count ? toNumber(stats.p50) : null,
        p95Ms: count ? toNumber(stats.p95) : null,
        p99Ms: count ? toNumber(stats.p99) : null,
      });
    } catch (err) {
      res.status(500).json({ enabled: true, error: err.message || "Query failed" });
    }
  });

  const staticDir =
    options.staticDir ||
    process.env.STATIC_DIR ||
    path.join(__dirname, "..", "public");

  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      if (req.path.startsWith("/api/")) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return { app, redisClient };
}

export async function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 3001);
  const { app, redisClient } = createApp(options);
  await redisClient.connect();
  const server = app.listen(port, () => {
    console.log(`Metrics API listening on :${port}`);
  });
  return { app, server, redisClient };
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["true", "1", "yes", "y"].includes(String(value).toLowerCase());
}

function parseRedisInfo(info) {
  const lines = info.split("\n");
  const data = {};
  for (const line of lines) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) {
      continue;
    }
    data[key] = rest.join(":").trim();
  }
  return data;
}

function parseKeyspace(value) {
  if (!value) {
    return { keys: 0, expires: 0, avgTtlMs: 0 };
  }
  const parts = value.split(",");
  const parsed = {};
  for (const part of parts) {
    const [key, val] = part.split("=");
    parsed[key] = toNumber(val);
  }
  return {
    keys: parsed.keys || 0,
    expires: parsed.expires || 0,
    avgTtlMs: parsed.avg_ttl || 0,
  };
}

function toNumber(value) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return 0;
  }
  return num;
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}
