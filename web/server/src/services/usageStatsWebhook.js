/**
 * Usage Statistics webhook: collects 24h stats and POSTs to a target URL.
 * Stats include: query distribution (cached, forwarded, stale, error, etc.),
 * latency statistics, and refresh window stats.
 */
import { toNumber } from "../utils/helpers.js";

const WINDOW_MINUTES = 1440; // 24 hours
const SEND_TIMEOUT_MS = 30000;

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

  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: periodStart,
    period_end: periodEnd,
    window_minutes: WINDOW_MINUTES,
    collected_at: new Date().toISOString(),
    query_distribution: {},
    latency: null,
    refresh_stats: null,
    cache_stats: null,
  };

  // Query distribution and latency from ClickHouse
  if (clickhouseEnabled && clickhouseClient) {
    try {
      const [summaryRes, latencyRes] = await Promise.all([
        clickhouseClient.query({
          query: `
            SELECT outcome, count() as count
            FROM ${clickhouseDatabase}.${clickhouseTable}
            WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
            GROUP BY outcome
            ORDER BY count DESC
          `,
          query_params: { window: WINDOW_MINUTES },
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
            WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
          `,
          query_params: { window: WINDOW_MINUTES },
        }),
      ]);

      const summaryRows = (await summaryRes.json()).data || [];
      const total = summaryRows.reduce((s, r) => s + toNumber(r.count), 0);
      const distribution = {};
      for (const row of summaryRows) {
        distribution[row.outcome || "other"] = toNumber(row.count);
      }
      payload.query_distribution = { ...distribution, total };

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
 * Sends usage stats to the target URL.
 * @param {string} url - Webhook target URL
 * @param {object} payload - Usage stats payload from collectUsageStats
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function sendUsageStatsWebhook(url, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
