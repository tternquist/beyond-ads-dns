import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatUsageStatsPayload,
  collectUsageStats,
} from "../src/services/usageStatsWebhook.js";

test("formatUsageStatsPayload discord includes query distribution with percentages", () => {
  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: "2025-02-21T08:00:00.000Z",
    period_end: "2025-02-22T08:00:00.000Z",
    collected_at: "2025-02-22T08:00:05.123Z",
    query_distribution: {
      cached: 1000,
      forwarded: 500,
      stale: 100,
      total: 1600,
    },
    query_distribution_pct: {
      cached: 62.5,
      forwarded: 31.25,
      stale: 6.25,
    },
    latency: null,
    refresh_stats: null,
    cache_stats: null,
  };

  const result = formatUsageStatsPayload(payload, "discord");
  const body = JSON.parse(result);

  assert.ok(body.embeds?.[0]);
  const queryDistField = body.embeds[0].fields.find((f) => f.name === "Query Distribution");
  assert.ok(queryDistField);
  assert.ok(queryDistField.value.includes("cached: 1,000 (62.5%)"));
  assert.ok(queryDistField.value.includes("forwarded: 500 (31.3%)"));
  assert.ok(queryDistField.value.includes("stale: 100 (6.3%)"));
});

test("formatUsageStatsPayload discord includes uptime and ip_address", () => {
  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: "2025-02-21T08:00:00.000Z",
    period_end: "2025-02-22T08:00:00.000Z",
    collected_at: "2025-02-22T08:00:05.123Z",
    uptime_seconds: 259200, // 3 days
    ip_address: "192.168.1.10",
    query_distribution: { total: 0 },
    latency: null,
    refresh_stats: null,
    cache_stats: null,
  };

  const result = formatUsageStatsPayload(payload, "discord");
  const body = JSON.parse(result);

  const uptimeField = body.embeds?.[0]?.fields?.find((f) => f.name === "Uptime");
  const ipField = body.embeds?.[0]?.fields?.find((f) => f.name === "IP Address");
  assert.ok(uptimeField, "Uptime field should exist");
  assert.ok(ipField, "IP Address field should exist");
  assert.equal(uptimeField.value, "3d 0m");
  assert.equal(ipField.value, "192.168.1.10");
});

test("formatUsageStatsPayload default includes query_distribution_pct in JSON", () => {
  const payload = {
    type: "usage_statistics",
    query_distribution: { cached: 100, forwarded: 50, total: 150 },
    query_distribution_pct: { cached: 66.67, forwarded: 33.33 },
  };

  const result = formatUsageStatsPayload(payload, "default");
  const parsed = JSON.parse(result);

  assert.deepEqual(parsed.query_distribution_pct, { cached: 66.67, forwarded: 33.33 });
});

test("formatUsageStatsPayload default includes uptime_seconds and ip_address in JSON", () => {
  const payload = {
    type: "usage_statistics",
    uptime_seconds: 86400,
    ip_address: "10.0.0.1",
  };

  const result = formatUsageStatsPayload(payload, "default");
  const parsed = JSON.parse(result);

  assert.equal(parsed.uptime_seconds, 86400);
  assert.equal(parsed.ip_address, "10.0.0.1");
});

test("collectUsageStats includes uptime_seconds and ip_address", async () => {
  const payload = await collectUsageStats({});
  assert.ok(typeof payload.uptime_seconds === "number");
  assert.ok(payload.uptime_seconds >= 0);
  assert.ok(payload.ip_address === null || typeof payload.ip_address === "string");
});
