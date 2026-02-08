import express from "express";
import cors from "cors";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient as createRedisClient } from "redis";
import { createClient as createClickhouseClient } from "@clickhouse/client";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(options = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const redisUrl =
    options.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
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
  const configPath =
    options.configPath || process.env.CONFIG_PATH || "";
  const defaultConfigPath =
    options.defaultConfigPath || process.env.DEFAULT_CONFIG_PATH || "";
  const dnsControlUrl =
    options.dnsControlUrl || process.env.DNS_CONTROL_URL || "";
  const dnsControlToken =
    options.dnsControlToken || process.env.DNS_CONTROL_TOKEN || "";

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

  app.get("/api/blocklists", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const blocklists = config.blocklists || {};
      res.json({
        refreshInterval: blocklists.refresh_interval || "6h",
        sources: blocklists.sources || [],
        allowlist: blocklists.allowlist || [],
        denylist: blocklists.denylist || [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.put("/api/blocklists", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const refreshInterval = String(req.body?.refreshInterval || "6h").trim();
    const sourcesInput = Array.isArray(req.body?.sources) ? req.body.sources : [];
    const allowlistInput = Array.isArray(req.body?.allowlist)
      ? req.body.allowlist
      : [];
    const denylistInput = Array.isArray(req.body?.denylist) ? req.body.denylist : [];

    const sources = normalizeSources(sourcesInput);
    const allowlist = normalizeDomains(allowlistInput);
    const denylist = normalizeDomains(denylistInput);

    if (sources.length === 0) {
      res.status(400).json({ error: "At least one blocklist source is required" });
      return;
    }

    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.blocklists = {
        ...(overrideConfig.blocklists || {}),
        refresh_interval: refreshInterval,
        sources,
        allowlist,
        denylist,
      };
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, blocklists: overrideConfig.blocklists });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update config" });
    }
  });

  app.post("/api/blocklists/apply", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/reload`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Reload failed: ${response.status}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to reload blocklists" });
    }
  });

  app.get("/api/blocklists/stats", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/stats`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Stats failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load stats" });
    }
  });

  app.get("/api/cache/refresh/stats", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/cache/refresh/stats`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res
          .status(502)
          .json({ error: body || `Stats failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load stats" });
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
  const port = Number(options.port || process.env.PORT || 80);
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

async function readYamlFile(path) {
  if (!path) {
    return {};
  }
  try {
    const data = await fsPromises.readFile(path, "utf8");
    const parsed = YAML.parse(data);
    return parsed || {};
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function readMergedConfig(defaultPath, overridePath) {
  const base = await readYamlFile(defaultPath);
  const override = await readYamlFile(overridePath);
  return mergeDeep(base, override);
}

async function readOverrideConfig(overridePath) {
  return readYamlFile(overridePath);
}

async function writeConfig(configPath, config) {
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const content = YAML.stringify(config);
  await fsPromises.writeFile(configPath, content, "utf8");
}

function mergeDeep(base, override) {
  if (Array.isArray(override)) {
    return override;
  }
  if (!isObject(base) || !isObject(override)) {
    return override ?? base;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = mergeDeep(base[key], value);
  }
  return merged;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSources(sources) {
  const result = [];
  const seen = new Set();
  for (const source of sources) {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const name = String(source?.name || "").trim() || url;
    result.push({ name, url });
  }
  return result;
}

function normalizeDomains(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const domain = String(value || "").trim().toLowerCase();
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(domain);
  }
  return result;
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
