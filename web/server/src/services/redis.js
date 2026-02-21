/**
 * Redis client creation and connection helpers.
 * Supports standalone, sentinel, and cluster modes.
 */
import { createClient as createRedisClient, createCluster, createSentinel } from "redis";

/**
 * Parses "host:port" into { host, port }. Defaults port to 26379 for Sentinel.
 */
function parseAddr(addr, defaultPort = 26379) {
  const trimmed = String(addr).trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) {
    return { host: trimmed || "localhost", port: defaultPort };
  }
  const host = trimmed.slice(0, colon);
  const port = parseInt(trimmed.slice(colon + 1), 10) || defaultPort;
  return { host: host || "localhost", port };
}

/**
 * Creates a Redis client (standalone, sentinel, or cluster) based on environment/config.
 * - REDIS_MODE=sentinel + REDIS_SENTINEL_ADDRS + REDIS_MASTER_NAME → createSentinel
 * - REDIS_MODE=cluster + REDIS_CLUSTER_ADDRS → createCluster
 * - Otherwise → createClient with REDIS_URL (default: redis://localhost:6379)
 */
export function createRedisClientFromEnv({
  redisUrl,
  redisMode,
  redisSentinelAddrs,
  redisMasterName,
  redisClusterAddrs,
  redisPassword,
}) {
  const useSentinel =
    redisMode === "sentinel" &&
    typeof redisSentinelAddrs === "string" &&
    redisSentinelAddrs.trim().length > 0 &&
    typeof redisMasterName === "string" &&
    redisMasterName.trim().length > 0;

  const useCluster =
    redisMode === "cluster" &&
    typeof redisClusterAddrs === "string" &&
    redisClusterAddrs.trim().length > 0;

  if (useSentinel) {
    const addrs = redisSentinelAddrs
      .split(",")
      .map((s) => parseAddr(s, 26379))
      .filter((n) => n.host);
    if (addrs.length === 0) {
      console.warn("Redis sentinel mode requested but REDIS_SENTINEL_ADDRS (or sentinel_addrs in config) is empty; falling back to standalone", redisUrl);
      return createRedisClient({ url: redisUrl });
    }
    const nodeClientOptions = redisPassword ? { password: redisPassword } : undefined;
    return createSentinel({
      name: redisMasterName.trim(),
      sentinelRootNodes: addrs,
      nodeClientOptions,
    });
  }

  if (useCluster) {
    const addrs = redisClusterAddrs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (addrs.length === 0) {
      console.warn("Redis cluster mode requested but REDIS_CLUSTER_ADDRS (or cluster_addrs in config) is empty; falling back to standalone", redisUrl);
      return createRedisClient({ url: redisUrl });
    }
    const rootNodes = addrs.map((addr) => ({
      url: addr.includes("://") ? addr : `redis://${addr}`,
    }));
    const defaults = {};
    if (redisPassword) {
      defaults.password = redisPassword;
    }
    return createCluster({ rootNodes, defaults });
  }

  if (redisMode === "cluster" || redisMode === "sentinel") {
    console.warn(`Redis ${redisMode} mode requested but required addrs are missing; using standalone`, redisUrl);
  }
  return createRedisClient({ url: redisUrl });
}

export function parseRedisInfo(info) {
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

export function parseKeyspace(value) {
  if (!value) {
    return { keys: 0, expires: 0, avgTtlMs: 0 };
  }
  const parts = value.split(",");
  const parsed = {};
  for (const part of parts) {
    const [key, val] = part.split("=");
    parsed[key] = Number(val) || 0;
  }
  return {
    keys: parsed.keys || 0,
    expires: parsed.expires || 0,
    avgTtlMs: parsed.avg_ttl || 0,
  };
}

const KEYS_COUNT_CACHE_TTL_MS = 30_000; // 30s to avoid O(N) KEYS/SCAN on every poll
const keysCountCache = new Map(); // pattern -> { count, until }

export async function countKeysByPrefix(client, pattern) {
  const now = Date.now();
  const cached = keysCountCache.get(pattern);
  if (cached && now < cached.until) {
    return cached.count;
  }
  const keys = await client.keys(pattern);
  const count = Array.isArray(keys) ? keys.length : 0;
  keysCountCache.set(pattern, { count, until: now + KEYS_COUNT_CACHE_TTL_MS });
  return count;
}
