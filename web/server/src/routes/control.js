/**
 * Control API proxy routes: errors, trace-events, instances, restart, docs.
 */
import path from "node:path";
import fsPromises from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import {
  readMergedConfig,
  readOverrideConfig,
  writeConfig,
  normalizeErrorLogLevel,
} from "../utils/config.js";
import { toNumber } from "../utils/helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCtx(req) {
  return req.app.locals.ctx ?? {};
}

export function registerControlRoutes(app) {
  app.post("/api/restart", async (req, res) => {
    const { dnsControlToken } = getCtx(req);
    if (dnsControlToken) {
      const auth = req.headers.authorization || "";
      const headerToken = req.headers["x-auth-token"] || "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (bearer !== dnsControlToken && headerToken !== dnsControlToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    res.json({ ok: true, message: "Restarting..." });
    res.on("finish", () => {
      setTimeout(() => process.exit(0), 100);
    });
  });

  app.get("/api/errors", async (req, res) => {
    const { defaultConfigPath, configPath, dnsControlUrl, dnsControlToken } = getCtx(req);
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/errors`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Errors fetch failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      let logLevel = "warning";
      if (defaultConfigPath || configPath) {
        try {
          const merged = await readMergedConfig(defaultConfigPath, configPath);
          const configuredLevel = normalizeErrorLogLevel(merged?.logging?.level || merged?.control?.errors?.log_level);
          if (configuredLevel) {
            logLevel = configuredLevel;
          } else if (data.log_level && ["error", "warning", "info", "debug"].includes(data.log_level)) {
            logLevel = data.log_level;
          }
        } catch {
          if (data.log_level && ["error", "warning", "info", "debug"].includes(data.log_level)) {
            logLevel = data.log_level;
          }
        }
      } else if (data.log_level && ["error", "warning", "info", "debug"].includes(data.log_level)) {
        logLevel = data.log_level;
      }
      res.json({ ...data, log_level: logLevel });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load errors" });
    }
  });

  app.put("/api/errors/log-level", async (req, res) => {
    const { configPath } = getCtx(req);
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const level = String(req.body?.log_level ?? "warning").toLowerCase();
      if (!["error", "warning", "info", "debug"].includes(level)) {
        res.status(400).json({ error: "log_level must be error, warning, info, or debug" });
        return;
      }
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.logging = overrideConfig.logging || {};
      overrideConfig.logging.level = level;
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, log_level: level, message: "Saved. Restart the DNS service to apply." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update log level" });
    }
  });

  app.get("/api/trace-events", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = getCtx(req);
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/trace-events`, { method: "GET", headers });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Trace events fetch failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load trace events" });
    }
  });

  app.put("/api/trace-events", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = getCtx(req);
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = { "Content-Type": "application/json" };
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const body = req.body?.events !== undefined ? { events: req.body.events } : { events: [] };
      const response = await fetch(`${dnsControlUrl}/trace-events`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        res.status(response.status).json({ error: data.error || `Trace events update failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update trace events" });
    }
  });

  app.get("/api/docs/errors", async (_req, res) => {
    try {
      const candidates = [
        path.join(process.cwd(), "docs", "errors.md"),
        path.join(__dirname, "..", "..", "..", "docs", "errors.md"),
        "/app/docs/errors.md",
      ];
      let content = null;
      for (const p of candidates) {
        try {
          content = await fsPromises.readFile(p, "utf8");
          break;
        } catch {
          continue;
        }
      }
      if (!content) {
        res.status(404).json({ error: "Error documentation not found" });
        return;
      }
      res.type("text/markdown").send(content);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load error documentation" });
    }
  });

  app.get("/api/docs/errors.html", async (_req, res) => {
    try {
      const candidates = [
        path.join(process.cwd(), "docs", "errors.md"),
        path.join(__dirname, "..", "..", "..", "docs", "errors.md"),
        "/app/docs/errors.md",
      ];
      let content = null;
      for (const p of candidates) {
        try {
          content = await fsPromises.readFile(p, "utf8");
          break;
        } catch {
          continue;
        }
      }
      if (!content) {
        res.status(404).send("Error documentation not found");
        return;
      }
      const rawHtml = marked.parse(content);
      const html = rawHtml.replace(
        /<h([12])>([^<]+)<\/h\1>/g,
        (_, level, text) => {
          const t = text.trim();
          const id = t.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          return `<h${level} id="${id}">${t}</h${level}>`;
        }
      );
      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Error Documentation</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 1.5rem; line-height: 1.6; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.2rem; margin-top: 1.5rem; padding-top: 0.5rem; border-top: 1px solid #e5e7eb; }
    code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f3f4f6; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    a { color: #2563eb; }
  </style>
</head>
<body>
${html}
</body>
</html>`;
      res.type("text/html").send(fullHtml);
    } catch (err) {
      res.status(500).send(err.message || "Failed to load error documentation");
    }
  });

  app.get("/api/instances/stats", async (req, res) => {
    const { dnsControlUrl, dnsControlToken, clickhouseEnabled, clickhouseClient, clickhouseDatabase, clickhouseTable } = getCtx(req);
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      let primaryRelease = process.env.RELEASE_TAG || null;
      let primaryBuildTime = process.env.BUILD_TIMESTAMP || null;
      if (!primaryBuildTime || !primaryRelease) {
        try {
          if (!primaryBuildTime) {
            const buildPath = path.join(__dirname, "..", "build-timestamp.txt");
            primaryBuildTime = (await fsPromises.readFile(buildPath, "utf8"))?.trim() || null;
          }
          if (!primaryRelease) {
            const tagPath = path.join(__dirname, "..", "release-tag.txt");
            primaryRelease = (await fsPromises.readFile(tagPath, "utf8"))?.trim() || null;
          }
        } catch {
          // Files not present in dev
        }
      }
      const primaryUrl = req.protocol && req.get("host")
        ? `${req.protocol}://${req.get("host")}`
        : null;
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const fetches = [
        fetch(`${dnsControlUrl}/blocklists/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/cache/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/cache/refresh/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/sync/replica-stats`, { method: "GET", headers }),
      ];
      let primaryResponseDistribution = null;
      let primaryResponseTime = null;
      if (clickhouseEnabled && clickhouseClient) {
        const windowMinutes = 60;
        try {
          const [summaryRes, latencyRes] = await Promise.all([
            clickhouseClient.query({
              query: `SELECT outcome, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY outcome ORDER BY count DESC`,
              query_params: { window: windowMinutes },
            }),
            clickhouseClient.query({
              query: `SELECT count() as count, avg(duration_ms) as avg, quantile(0.5)(duration_ms) as p50, quantile(0.95)(duration_ms) as p95, quantile(0.99)(duration_ms) as p99 FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE`,
              query_params: { window: windowMinutes },
            }),
          ]);
          const summaryRows = (await summaryRes.json()).data || [];
          const latencyRows = (await latencyRes.json()).data || [];
          const summaryStats = summaryRows.reduce((acc, row) => {
            acc[row.outcome] = toNumber(row.count);
            return acc;
          }, {});
          primaryResponseDistribution = { ...summaryStats, total: summaryRows.reduce((s, r) => s + toNumber(r.count), 0) };
          const lat = latencyRows[0];
          const count = toNumber(lat?.count);
          if (count > 0) {
            primaryResponseTime = {
              count,
              avg_ms: toNumber(lat.avg),
              p50_ms: toNumber(lat.p50),
              p95_ms: toNumber(lat.p95),
              p99_ms: toNumber(lat.p99),
            };
          }
        } catch {
          // ClickHouse query failed
        }
      }
      const [primaryBlocklistRes, primaryCacheRes, primaryRefreshRes, replicaStatsRes] = await Promise.all(fetches);
      let primary = null;
      if (primaryBlocklistRes.ok && primaryCacheRes.ok && primaryRefreshRes.ok) {
        const [blocklist, cache, refresh] = await Promise.all([
          primaryBlocklistRes.json(),
          primaryCacheRes.json(),
          primaryRefreshRes.json(),
        ]);
        primary = { blocklist, cache, refresh };
        if (primaryResponseDistribution) primary.response_distribution = primaryResponseDistribution;
        if (primaryResponseTime) primary.response_time = primaryResponseTime;
        if (primaryRelease) primary.release = primaryRelease;
        if (primaryBuildTime) primary.build_time = primaryBuildTime;
        if (primaryUrl) primary.url = primaryUrl;
      }
      let replicas = [];
      if (replicaStatsRes.ok) {
        const data = await replicaStatsRes.json();
        replicas = data.replicas || [];
      }
      res.json({ primary, replicas });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load instance stats" });
    }
  });
}
