import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatUsageStatsPayload,
  collectUsageStats,
  parseDefaultGatewayFromRoute,
} from "../src/services/usageStatsWebhook.js";
import { readMergedConfig } from "../src/utils/config.js";

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

test("formatUsageStatsPayload discord includes hostname, uptime and ip_address", () => {
  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: "2025-02-21T08:00:00.000Z",
    period_end: "2025-02-22T08:00:00.000Z",
    collected_at: "2025-02-22T08:00:05.123Z",
    hostname: "my-dns-server",
    release_tag: "v1.2.3",
    uptime_seconds: 259200, // 3 days
    ip_address: "192.168.1.10",
    query_distribution: { total: 0 },
    latency: null,
    refresh_stats: null,
    cache_stats: null,
  };

  const result = formatUsageStatsPayload(payload, "discord");
  const body = JSON.parse(result);

  const hostnameField = body.embeds?.[0]?.fields?.find((f) => f.name === "Hostname");
  const releaseField = body.embeds?.[0]?.fields?.find((f) => f.name === "Release");
  const uptimeField = body.embeds?.[0]?.fields?.find((f) => f.name === "Uptime");
  const ipField = body.embeds?.[0]?.fields?.find((f) => f.name === "IP Address");
  assert.ok(hostnameField, "Hostname field should exist");
  assert.ok(releaseField, "Release field should exist");
  assert.ok(uptimeField, "Uptime field should exist");
  assert.ok(ipField, "IP Address field should exist");
  assert.equal(hostnameField.value, "my-dns-server");
  assert.equal(releaseField.value, "v1.2.3");
  assert.equal(uptimeField.value, "3d 0m");
  assert.equal(ipField.value, "192.168.1.10");
});

test("formatUsageStatsPayload discord includes refresh removal breakdown details", () => {
  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: "2025-02-21T08:00:00.000Z",
    period_end: "2025-02-22T08:00:00.000Z",
    collected_at: "2025-02-22T08:00:05.123Z",
    query_distribution: { total: 0 },
    refresh_stats: {
      sweeps_24h: 10,
      refreshed_24h: 5678,
      removed_24h: 1234,
      removed_24h_breakdown: {
        cold_keys: 1000,
        cap_evicted: 200,
        index_orphans: 30,
        reconcile: 4,
      },
      sweep_hit_window: "15m",
      sweep_min_hits: 3,
    },
  };

  const result = formatUsageStatsPayload(payload, "discord");
  const body = JSON.parse(result);
  const refreshField = body.embeds?.[0]?.fields?.find((f) => f.name === "Refresh Stats");
  assert.ok(refreshField, "Refresh Stats field should exist");
  assert.ok(refreshField.value.includes("Entries removed: 1,234"));
  assert.ok(refreshField.value.includes("(cold: 1,000, cap: 200, orphans: 30, reconcile: 4)"));
  assert.ok(refreshField.value.includes("Sweep hit window: 15m"));
  assert.ok(refreshField.value.includes("Sweep min hits: 3"));
});

test("formatUsageStatsPayload discord omits zero-value refresh breakdown details", () => {
  const payload = {
    type: "usage_statistics",
    period: "24h",
    period_start: "2025-02-21T08:00:00.000Z",
    period_end: "2025-02-22T08:00:00.000Z",
    collected_at: "2025-02-22T08:00:05.123Z",
    query_distribution: { total: 0 },
    refresh_stats: {
      sweeps_24h: 2,
      refreshed_24h: 20,
      removed_24h: 0,
      removed_24h_breakdown: {
        cold_keys: 0,
        cap_evicted: 0,
        index_orphans: 0,
        reconcile: 0,
      },
      sweep_hit_window: "10m",
      sweep_min_hits: 2,
    },
  };

  const result = formatUsageStatsPayload(payload, "discord");
  const body = JSON.parse(result);
  const refreshField = body.embeds?.[0]?.fields?.find((f) => f.name === "Refresh Stats");
  assert.ok(refreshField, "Refresh Stats field should exist");
  assert.ok(refreshField.value.includes("Entries removed: 0"));
  assert.equal(refreshField.value.includes("cold:"), false);
  assert.equal(refreshField.value.includes("cap:"), false);
  assert.equal(refreshField.value.includes("orphans:"), false);
  assert.equal(refreshField.value.includes("reconcile:"), false);
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

test("formatUsageStatsPayload default includes hostname, uptime_seconds and ip_address in JSON", () => {
  const payload = {
    type: "usage_statistics",
    hostname: "dns.example.com",
    uptime_seconds: 86400,
    ip_address: "10.0.0.1",
  };

  const result = formatUsageStatsPayload(payload, "default");
  const parsed = JSON.parse(result);

  assert.equal(parsed.hostname, "dns.example.com");
  assert.equal(parsed.uptime_seconds, 86400);
  assert.equal(parsed.ip_address, "10.0.0.1");
});

test("formatUsageStatsPayload discord includes refresh_config in Refresh Stats when present", () => {
  const payload = {
    type: "usage_statistics",
    period: "24h",
    query_distribution: { total: 100 },
    refresh_stats: {
      sweeps_24h: 100,
      refreshed_24h: 500,
      removed_24h: 10,
      sweep_hit_window: "48h",
      sweep_min_hits: 1,
      hot_warm_entry_stats: {
        hot_count: 150,
        warm_count: 200,
        cold_count: 650,
        sampled_count: 1000,
        hot_pct: 15,
        warm_pct: 20,
      },
      refresh_config: {
        cache_min_ttl: "300s",
        refresh_min_ttl: "1h",
        refresh_past_auth_ttl: true,
        client_ttl_cap: "5m",
        hot_threshold_rate: 2,
        hot_ttl_fraction: 0.3,
        warm_threshold: 2,
        warm_ttl: "5m",
      },
    },
  };

  const result = formatUsageStatsPayload(payload, "discord");
  const body = JSON.parse(result);
  const refreshField = body.embeds?.[0]?.fields?.find((f) => f.name === "Refresh Stats");
  assert.ok(refreshField, "Refresh Stats field should exist");
  assert.ok(refreshField.value.includes("cache_min_ttl: 300s (stored/returned)"), "should include cache_min_ttl (stored/returned)");
  assert.ok(refreshField.value.includes("refresh_min_ttl: 1h"), "should include refresh_min_ttl");
  assert.ok(refreshField.value.includes("refresh_past_auth_ttl: true"), "should include refresh_past_auth_ttl");
  assert.ok(refreshField.value.includes("client_ttl_cap: 5m"), "should include client_ttl_cap");
  assert.ok(refreshField.value.includes("warm_threshold: 2"), "should include warm_threshold");
  assert.ok(refreshField.value.includes("warm_ttl: 5m"), "should include warm_ttl");
  assert.ok(refreshField.value.includes("Entries hot: 15.0%"), "should include hot entry pct");
  assert.ok(refreshField.value.includes("warm: 20.0%"), "should include warm entry pct");
  assert.ok(refreshField.value.includes("sampled 1,000"), "should include sampled count");
});

test("collectUsageStats includes hostname, uptime_seconds and ip_address", async () => {
  const payload = await collectUsageStats({});
  assert.ok(typeof payload.hostname === "string");
  assert.ok(payload.hostname.length > 0);
  assert.ok(typeof payload.uptime_seconds === "number");
  assert.ok(payload.uptime_seconds >= 0);
  assert.ok(payload.ip_address === null || typeof payload.ip_address === "string");
  assert.ok(payload.release_tag === null || typeof payload.release_tag === "string");
});

test("collectUsageStats includes release_tag from RELEASE_TAG env when set", async () => {
  const origTag = process.env.RELEASE_TAG;
  process.env.RELEASE_TAG = "test-release-tag";
  try {
    const payload = await collectUsageStats({});
    assert.equal(payload.release_tag, "test-release-tag");
  } finally {
    if (origTag !== undefined) process.env.RELEASE_TAG = origTag;
    else delete process.env.RELEASE_TAG;
  }
});

test("collectUsageStats uses HOST_IP when set", async () => {
  const orig = process.env.HOST_IP;
  process.env.HOST_IP = "10.99.88.77";
  try {
    const payload = await collectUsageStats({});
    assert.equal(payload.ip_address, "10.99.88.77");
  } finally {
    if (orig !== undefined) process.env.HOST_IP = orig;
    else delete process.env.HOST_IP;
  }
});

test("parseDefaultGatewayFromRoute extracts gateway from /proc/net/route format", () => {
  const routeContent = [
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  ].join("\n");
  const ip = parseDefaultGatewayFromRoute(routeContent);
  assert.equal(ip, "172.17.0.1", "010011AC little-endian = 172.17.0.1");
});

test("parseDefaultGatewayFromRoute returns null for missing or invalid content", () => {
  assert.equal(parseDefaultGatewayFromRoute(""), null);
  assert.equal(parseDefaultGatewayFromRoute("Iface\tDestination\tGateway\n"), null);
  assert.equal(parseDefaultGatewayFromRoute("single line"), null);
});

test("collectUsageStats uses config hostname when ctx provides readMergedConfig", async () => {
  const origUI = process.env.UI_HOSTNAME;
  const origH = process.env.HOSTNAME;
  delete process.env.UI_HOSTNAME;
  delete process.env.HOSTNAME;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-stats-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(configPath, "ui:\n  hostname: custom-host.example\n", "utf8");
  const ctx = { readMergedConfig, configPath, defaultConfigPath: "" };
  try {
    const payload = await collectUsageStats(ctx);
    assert.equal(payload.hostname, "custom-host.example");
  } finally {
    if (origUI !== undefined) process.env.UI_HOSTNAME = origUI;
    else delete process.env.UI_HOSTNAME;
    if (origH !== undefined) process.env.HOSTNAME = origH;
    else delete process.env.HOSTNAME;
    await fs.rm(tempDir, { recursive: true });
  }
});
