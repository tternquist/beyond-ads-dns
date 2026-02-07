import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient as createRedisClient } from "redis";
import { createClient as createClickhouseClient } from "@clickhouse/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const clickhouseEnabled = parseBoolean(process.env.CLICKHOUSE_ENABLED, false);
const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const clickhouseDatabase = process.env.CLICKHOUSE_DATABASE || "beyond_ads";
const clickhouseTable = process.env.CLICKHOUSE_TABLE || "dns_queries";

const redisClient = createRedisClient({ url: redisUrl });
redisClient.on("error", (err) => {
  console.error("Redis client error:", err);
});

let clickhouseClient = null;
if (clickhouseEnabled) {
  clickhouseClient = createClickhouseClient({
    url: clickhouseUrl,
    database: clickhouseDatabase,
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

const staticDir =
  process.env.STATIC_DIR || path.join(__dirname, "..", "public");

if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get("/*", (req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

async function start() {
  await redisClient.connect();
  app.listen(port, () => {
    console.log(`Metrics API listening on :${port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

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
