/**
 * Usage Statistics webhook: collects 24h stats and POSTs to a target URL.
 * Stats include: query distribution (cached, forwarded, stale, error, etc.),
 * latency statistics, refresh window stats, uptime, host IP, hostname, and release tag.
 */
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toNumber, getWindowStartForClickHouse } from "../utils/helpers.js";

const WINDOW_MINUTES = 1440; // 24 hours
const SEND_TIMEOUT_MS = 30000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Returns the first non-internal IPv4 address from network interfaces.
 * @returns {string|null} Primary IP or null if none found
 */
function getPrimaryIP() {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

/**
 * Parses the default gateway IP from /proc/net/route content.
 * Gateway is stored as little-endian hex (e.g. 010011AC = 172.17.0.1).
 * @param {string} content - Content of /proc/net/route
 * @returns {string|null}
 */
export function parseDefaultGatewayFromRoute(content) {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return null;
  const header = lines[0];
  const destIdx = header.split(/\s+/).indexOf("Destination");
  const gwIdx = header.split(/\s+/).indexOf("Gateway");
  if (destIdx < 0 || gwIdx < 0) return null;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    const dest = cols[destIdx];
    const gwHex = cols[gwIdx];
    if (dest === "00000000" && gwHex && gwHex !== "00000000") {
      const parsed = parseInt(gwHex, 16);
      if (Number.isNaN(parsed)) return null;
      const o1 = parsed & 0xff;
      const o2 = (parsed >> 8) & 0xff;
      const o3 = (parsed >> 16) & 0xff;
      const o4 = (parsed >> 24) & 0xff;
      const ip = `${o1}.${o2}.${o3}.${o4}`;
      if (!ip.startsWith("127.")) return ip;
      return null;
    }
  }
  return null;
}

/**
 * Reads the default gateway from /proc/net/route (Linux).
 * The gateway is the Docker host from a container's perspective.
 * @returns {Promise<string|null>}
 */
async function getDefaultGatewayFromRoute() {
  const routePath = process.env.PROC_NET_ROUTE_PATH || "/proc/net/route";
  try {
    const content = await fs.readFile(routePath, "utf8");
    return parseDefaultGatewayFromRoute(content);
  } catch {
    /* /proc/net/route not available (non-Linux, permissions) */
  }
  return null;
}

/**
 * Resolves host IP address, with Docker support.
 * Order: HOST_IP env → host.docker.internal → /proc/net/route default gateway → network interfaces.
 * @returns {Promise<string|null>}
 */
async function getIPAddress() {
  const envIp = (process.env.HOST_IP || process.env.HOST_IP_ADDRESS || "").trim();
  if (envIp) return envIp;
  try {
    const { address } = await dns.lookup("host.docker.internal", { family: 4 });
    if (address && !address.startsWith("127.")) return address;
  } catch {
    // host.docker.internal not available (e.g. extra_hosts not working)
  }
  const gateway = await getDefaultGatewayFromRoute();
  if (gateway) return gateway;
  return getPrimaryIP();
}

/**
 * Resolves the release tag of the running Metrics UI server.
 * Priority: RELEASE_TAG env → release-tag.txt next to build artifacts.
 * @returns {Promise<string|null>}
 */
async function getReleaseTag() {
  const envTag = (process.env.RELEASE_TAG || "").trim();
  if (envTag) return envTag;
  try {
    const tagPath = path.join(__dirname, "..", "..", "release-tag.txt");
    const content = await fs.readFile(tagPath, "utf8");
    const tag = (content || "").trim();
    return tag || null;
  } catch {
    /* release-tag.txt not present in dev or non-container environments */
  }
  return null;
}

/**
 * Resolves hostname: UI_HOSTNAME (explicit) → config.ui.hostname (Settings) → HOSTNAME env → os.hostname().
 * Config overrides HOSTNAME so hostname set in Settings takes effect even when HOSTNAME env is set (e.g. by Docker).
 * @param {object} ctx - App context with readMergedConfig, defaultConfigPath, configPath
 * @returns {Promise<string>}
 */
async function getHostname(ctx) {
  const uiEnv = (process.env.UI_HOSTNAME || "").trim();
  if (uiEnv) return uiEnv;
  const { readMergedConfig, defaultConfigPath, configPath } = ctx || {};
  if (readMergedConfig && (defaultConfigPath || configPath)) {
    try {
      const cfg = await readMergedConfig(defaultConfigPath, configPath);
      const cfgHost = (cfg?.ui?.hostname ?? "").trim();
      if (cfgHost) return cfgHost;
    } catch {
      /* config not available */
    }
  }
  const envHost = (process.env.HOSTNAME || "").trim();
  return envHost || os.hostname();
}

/**
 * Formats seconds into a human-readable uptime string (e.g. "3d 5h 12m").
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600) % 24;
  const d = Math.floor(seconds / 86400);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

/**
 * Collects usage statistics for the last 24 hours.
 * @param {object} ctx - App context with clickhouseClient, dnsControlUrl, etc.
 * @returns {Promise<object>} Usage stats payload
 */
export async function collectUsageStats(ctx) {
  const {
    clickhouseEnabled,
    clickhouseClient,
    clickhouseDatabase,
    clickhouseTable,
    dnsControlUrl,
    dnsControlToken,
  } = ctx || {};

  const periodStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const periodEnd = new Date().toISOString();

  const [ipAddress, hostname, releaseTag] = await Promise.all([
    getIPAddress(),
    getHostname(ctx),
    getReleaseTag(),
  ]);

  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: periodStart,
    period_end: periodEnd,
    window_minutes: WINDOW_MINUTES,
    collected_at: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    ip_address: ipAddress,
    hostname: (hostname || os.hostname()).trim(),
    release_tag: releaseTag,
    query_distribution: {},
    latency: null,
    refresh_stats: null,
    cache_stats: null,
  };

  // Query distribution and latency from ClickHouse
  if (clickhouseEnabled && clickhouseClient) {
    const windowStart = getWindowStartForClickHouse(WINDOW_MINUTES);
    try {
      const [summaryRes, latencyRes] = await Promise.all([
        clickhouseClient.query({
          query: `
            SELECT outcome, count() as count
            FROM ${clickhouseDatabase}.${clickhouseTable}
            WHERE ts >= {window_start: DateTime}
            GROUP BY outcome
            ORDER BY count DESC
          `,
          query_params: { window_start: windowStart },
        }),
        clickhouseClient.query({
          query: `
            SELECT
              count() as count,
              avg(duration_ms) as avg,
              min(duration_ms) as min,
              max(duration_ms) as max,
              quantile(0.5)(duration_ms) as p50,
              quantile(0.95)(duration_ms) as p95,
              quantile(0.99)(duration_ms) as p99
            FROM ${clickhouseDatabase}.${clickhouseTable}
            WHERE ts >= {window_start: DateTime}
          `,
          query_params: { window_start: windowStart },
        }),
      ]);

      const summaryRows = (await summaryRes.json()).data || [];
      const total = summaryRows.reduce((s, r) => s + toNumber(r.count), 0);
      const distribution = {};
      const distributionPct = {};
      for (const row of summaryRows) {
        const count = toNumber(row.count);
        const key = row.outcome || "other";
        distribution[key] = count;
        distributionPct[key] = total > 0 ? (count / total) * 100 : 0;
      }
      payload.query_distribution = { ...distribution, total };
      payload.query_distribution_pct = distributionPct;

      const latRows = (await latencyRes.json()).data || [];
      const lat = latRows[0];
      const count = toNumber(lat?.count);
      if (count > 0) {
        payload.latency = {
          count,
          avg_ms: toNumber(lat.avg),
          min_ms: toNumber(lat.min),
          max_ms: toNumber(lat.max),
          p50_ms: toNumber(lat.p50),
          p95_ms: toNumber(lat.p95),
          p99_ms: toNumber(lat.p99),
        };
      }
    } catch (err) {
      payload.query_error = err.message || "Failed to query ClickHouse";
    }
  } else {
    payload.query_distribution.enabled = false;
  }

  // Refresh stats and cache stats from DNS control
  if (dnsControlUrl) {
    const headers = {};
    if (dnsControlToken) {
      headers.Authorization = `Bearer ${dnsControlToken}`;
    }
    try {
      const [refreshRes, cacheRes] = await Promise.all([
        fetch(`${dnsControlUrl}/cache/refresh/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/cache/stats`, { method: "GET", headers }),
      ]);
      if (refreshRes.ok) {
        payload.refresh_stats = await refreshRes.json();
      }
      if (cacheRes.ok) {
        payload.cache_stats = await cacheRes.json();
      }
    } catch (err) {
      payload.control_error = err.message || "Failed to fetch DNS control stats";
    }
  }

  return payload;
}

/**
 * Formats usage stats payload for the target service.
 * @param {object} payload - Usage stats payload from collectUsageStats
 * @param {string} target - "default" or "discord"
 * @returns {string} JSON string to send
 */
export function formatUsageStatsPayload(payload, target) {
  const t = (String(target || "default").trim().toLowerCase()) || "default";
  if (t === "discord") {
    const dist = payload.query_distribution || {};
    const distPct = payload.query_distribution_pct || {};
    const total = dist.total ?? 0;
    const distLines = Object.entries(dist)
      .filter(([k]) => k !== "total" && k !== "enabled")
      .map(([k, v]) => {
        const pct = distPct[k];
        const pctStr = pct != null ? ` (${pct.toFixed(1)}%)` : "";
        return `${k}: ${Number(v).toLocaleString()}${pctStr}`;
      })
      .join("\n") || "—";
    const lat = payload.latency;
    const latStr = lat
      ? `Avg: ${lat.avg_ms?.toFixed(1)}ms | P95: ${lat.p95_ms?.toFixed(1)}ms | P99: ${lat.p99_ms?.toFixed(1)}ms`
      : "—";
    const refresh = payload.refresh_stats;
    const refreshStr = refresh
      ? `Sweeps: ${refresh.sweeps_24h ?? "—"} | Refreshed: ${(refresh.refreshed_24h ?? 0).toLocaleString()} | Entries removed: ${(refresh.removed_24h ?? 0).toLocaleString()} | Sweep hit window: ${refresh.sweep_hit_window ?? "—"} | Sweep min hits: ${refresh.sweep_min_hits ?? "—"}`
      : "—";
    const cache = payload.cache_stats?.lru;
    const cacheStr = cache
      ? `Entries: ${(cache.entries ?? 0).toLocaleString()}/${(cache.max_entries ?? 0).toLocaleString()} | Fresh: ${(cache.fresh ?? 0).toLocaleString()} | Stale: ${(cache.stale ?? 0).toLocaleString()}`
      : "—";
    const hitRate = payload.cache_stats?.hit_rate;
    const hitRateStr = hitRate != null ? `${hitRate.toFixed(1)}%` : "—";
    const uptimeSec = payload.uptime_seconds ?? 0;
    const uptimeStr = formatUptime(uptimeSec);
    const ipStr = payload.ip_address ?? "—";
    const hostnameStr = payload.hostname ?? "—";
    const releaseStr = payload.release_tag ?? payload.releaseTag ?? payload.release ?? "—";

    const body = {
      content: null,
      embeds: [{
        title: "Usage Statistics (24h)",
        color: 3447003,
        fields: [
          { name: "Period", value: `${payload.period_start?.slice(0, 10)} → ${payload.period_end?.slice(0, 10)}`, inline: false },
          { name: "Hostname", value: hostnameStr, inline: true },
          { name: "Release", value: String(releaseStr || "—"), inline: true },
          { name: "Uptime", value: uptimeStr, inline: true },
          { name: "IP Address", value: ipStr, inline: true },
          { name: "Query Distribution", value: distLines.length > 1024 ? distLines.slice(0, 1021) + "…" : distLines, inline: false },
          { name: "Total Queries", value: total.toLocaleString(), inline: true },
          { name: "Latency", value: latStr, inline: false },
          { name: "Refresh Stats", value: refreshStr.length > 1024 ? refreshStr.slice(0, 1021) + "…" : refreshStr, inline: false },
          { name: "Cache (LRU)", value: cacheStr.length > 1024 ? cacheStr.slice(0, 1021) + "…" : cacheStr, inline: false },
          { name: "Hit Rate", value: hitRateStr, inline: true },
        ],
        timestamp: payload.collected_at,
      }],
    };
    return JSON.stringify(body);
  }
  return JSON.stringify(payload);
}

/**
 * Collects full 24h stats and sends to the target URL.
 * Used by both the scheduled run and the UI Test/Send now actions.
 * Always uses the same full stats collection—no sample or abbreviated payload.
 * @param {string} url - Webhook target URL
 * @param {string} target - "default" or "discord" for payload format
 * @param {object} ctx - App context (clickhouseClient, dnsControlUrl, etc.)
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function collectAndSendUsageStats(url, target, ctx) {
  const payload = await collectUsageStats(ctx);
  return sendUsageStatsWebhook(url, payload, target);
}

/**
 * Sends usage stats to the target URL.
 * @param {string} url - Webhook target URL
 * @param {object} payload - Usage stats payload from collectUsageStats
 * @param {string} [target] - "default" or "discord" for payload format
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function sendUsageStatsWebhook(url, payload, target = "default") {
  const body = formatUsageStatsPayload(payload, target);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `${response.status}: ${(await response.text()).slice(0, 200)}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: null,
      error: err.name === "AbortError" ? "Request timed out" : err.message,
    };
  }
}
