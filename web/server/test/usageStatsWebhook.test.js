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
  const uptimeField = body.embeds?.[0]?.fields?.find((f) => f.name === "Uptime");
  const ipField = body.embeds?.[0]?.fields?.find((f) => f.name === "IP Address");
  assert.ok(hostnameField, "Hostname field should exist");
  assert.ok(uptimeField, "Uptime field should exist");
  assert.ok(ipField, "IP Address field should exist");
  assert.equal(hostnameField.value, "my-dns-server");
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

test("collectUsageStats includes hostname, uptime_seconds and ip_address", async () => {
  const payload = await collectUsageStats({});
  assert.ok(typeof payload.hostname === "string");
  assert.ok(payload.hostname.length > 0);
  assert.ok(typeof payload.uptime_seconds === "number");
  assert.ok(payload.uptime_seconds >= 0);
  assert.ok(payload.ip_address === null || typeof payload.ip_address === "string");
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
