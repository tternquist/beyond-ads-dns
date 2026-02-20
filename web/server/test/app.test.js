import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";

import { createApp } from "../src/index.js";
import { _resetStoredHash } from "../src/auth.js";

async function withServer(app, handler) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves index.html from static dir fallback", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-ui-"));
  const indexPath = path.join(tempDir, "index.html");
  await fs.writeFile(indexPath, "<html>ok</html>");

  const { app } = createApp({ staticDir: tempDir });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body, "<html>ok</html>");
  });
});

test("health endpoint responds without clickhouse", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.clickhouseEnabled, false);
  });
});

test("info endpoint returns hostname, memoryUsage, buildTimestamp, startTimestamp, and releaseTag", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/info`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(typeof body.hostname === "string");
    assert.ok(typeof body.memoryUsage === "string");
    assert.ok(body.memoryUsage.match(/^[\d.]+ (B|KB|MB|GB)$/));
    assert.ok(body.buildTimestamp === null || typeof body.buildTimestamp === "string");
    assert.ok(typeof body.startTimestamp === "string");
    assert.ok(!Number.isNaN(Date.parse(body.startTimestamp)));
    assert.ok(body.releaseTag === null || typeof body.releaseTag === "string");
  });
});

test("cpu-count endpoint returns cpuCount in valid range", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/cpu-count`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(typeof body.cpuCount === "number");
    assert.ok(body.cpuCount >= 1 && body.cpuCount <= 64);
  });
});

test("resources endpoint returns cpu, memory, and recommended settings", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/resources`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(typeof body.cpuCount === "number");
    assert.ok(body.cpuCount >= 1 && body.cpuCount <= 64);
    assert.ok(typeof body.totalMemoryMB === "number");
    assert.ok(typeof body.freeMemoryMB === "number");
    assert.ok(body.totalMemoryMB > 0);
    if (body.containerMemoryLimitMB != null) {
      assert.ok(typeof body.containerMemoryLimitMB === "number");
      assert.ok(body.containerMemoryLimitMB > 0);
    }
    if (body.raspberryPiModel != null) {
      assert.ok(["pi4", "pi5", "pi_other"].includes(body.raspberryPiModel));
    }
    const rec = body.recommended;
    assert.ok(typeof rec.reuse_port_listeners === "number");
    assert.ok(typeof rec.redis_lru_size === "number");
    assert.ok(typeof rec.max_inflight === "number");
    assert.ok(typeof rec.max_batch_size === "number");
    assert.ok(typeof rec.query_store_batch_size === "number");
    assert.ok(rec.redis_lru_size >= 1000 && rec.redis_lru_size <= 150000);
  });
});

test("raspberry-pi debug endpoint returns detection info", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/debug/raspberry-pi`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(
      body.detectedModel === null ||
      ["pi4", "pi5", "pi_other"].includes(body.detectedModel)
    );
    assert.ok(typeof body.deviceTree === "object");
    assert.ok(typeof body.cpuinfo === "object");
    assert.ok(
      body.deviceTree.model != null ||
      body.deviceTree.error != null
    );
    assert.ok(
      body.cpuinfo.hardware != null ||
      body.cpuinfo.error != null
    );
  });
});

test("query summary returns disabled when clickhouse off", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/queries/summary`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.deepEqual(body.statuses, []);
  });
});

test("query latency returns disabled when clickhouse off", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/queries/latency`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.count, 0);
  });
});

test("query list returns disabled when clickhouse off", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/queries/recent`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.total, 0);
    assert.deepEqual(body.rows, []);
  });
});

test("query time-series returns disabled when clickhouse off", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/queries/time-series?window_minutes=60&bucket_minutes=5`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.deepEqual(body.buckets, []);
    assert.deepEqual(body.latencyBuckets, []);
  });
});

test("blocklist config can be read and updated", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(
    configPath,
    `blocklists:\n  refresh_interval: "6h"\n  sources:\n    - name: "hagezi"\n      url: "https://example.com"\n  allowlist: ["allow.com"]\n  denylist: ["deny.com"]\n`
  );

  const { app } = createApp({ configPath, clickhouseEnabled: false });

  await withServer(app, async (baseUrl) => {
    const initial = await fetch(`${baseUrl}/api/blocklists`).then((r) => r.json());
    assert.equal(initial.sources.length, 1);
    assert.equal(initial.allowlist[0], "allow.com");

    const updateResponse = await fetch(`${baseUrl}/api/blocklists`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshInterval: "12h",
        sources: [{ name: "custom", url: "https://blocklist.test" }],
        allowlist: ["example.org"],
        denylist: ["ads.example.org"],
      }),
    });
    assert.equal(updateResponse.status, 200);

    const updated = await fetch(`${baseUrl}/api/blocklists`).then((r) => r.json());
    assert.equal(updated.refreshInterval, "12h");
    assert.equal(updated.sources[0].url, "https://blocklist.test");
    assert.equal(updated.allowlist[0], "example.org");
  });
});

test("blocklist scheduled_pause and health_check can be read and updated", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(
    configPath,
    `blocklists:\n  refresh_interval: "6h"\n  sources:\n    - name: "hagezi"\n      url: "https://example.com"\n`
  );

  const { app } = createApp({ configPath, clickhouseEnabled: false });

  await withServer(app, async (baseUrl) => {
    const initial = await fetch(`${baseUrl}/api/blocklists`).then((r) => r.json());
    assert.equal(initial.scheduled_pause, null);
    assert.equal(initial.health_check, null);

    const updateResponse = await fetch(`${baseUrl}/api/blocklists`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshInterval: "6h",
        sources: [{ name: "hagezi", url: "https://example.com" }],
        allowlist: [],
        denylist: [],
        scheduled_pause: { enabled: true, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
        health_check: { enabled: true, fail_on_any: true },
      }),
    });
    assert.equal(updateResponse.status, 200);

    const updated = await fetch(`${baseUrl}/api/blocklists`).then((r) => r.json());
    assert.ok(updated.scheduled_pause);
    assert.equal(updated.scheduled_pause.enabled, true);
    assert.equal(updated.scheduled_pause.start, "09:00");
    assert.equal(updated.scheduled_pause.end, "17:00");
    assert.deepEqual(updated.scheduled_pause.days, [1, 2, 3, 4, 5]);
    assert.ok(updated.health_check);
    assert.equal(updated.health_check.enabled, true);
    assert.equal(updated.health_check.fail_on_any, true);
  });
});

test("blocklist scheduled_pause validation rejects invalid times", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(
    configPath,
    `blocklists:\n  refresh_interval: "6h"\n  sources:\n    - name: "hagezi"\n      url: "https://example.com"\n`
  );

  const { app } = createApp({ configPath, clickhouseEnabled: false });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/blocklists`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshInterval: "6h",
        sources: [{ name: "hagezi", url: "https://example.com" }],
        allowlist: [],
        denylist: [],
        scheduled_pause: { enabled: true, start: "17:00", end: "09:00", days: [] },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.includes("before"));
  });
});

test("blocklist apply requires control url", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/blocklists/apply`, {
      method: "POST",
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.ok(body.error);
  });
});

test("blocklist stats require control url", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/blocklists/stats`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.ok(body.error);
  });
});

test("refresh stats require control url", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cache/refresh/stats`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.ok(body.error);
  });
});

test("config endpoint merges and redacts secrets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const overridePath = path.join(tempDir, "config.yaml");
  await fs.writeFile(
    defaultPath,
    `cache:\n  redis:\n    password: "secret"\nquery_store:\n  password: "secret2"\ncontrol:\n  token: "tok"\n`
  );
  await fs.writeFile(overridePath, `blocklists:\n  allowlist: ["a.com"]\n`);

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath: overridePath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.cache.redis.password, "***");
    assert.equal(body.query_store.password, "***");
    assert.equal(body.control.token, "***");
    assert.equal(body.blocklists.allowlist[0], "a.com");
  });
});

test("errors API prefers config logging.level over control API when available", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-errors-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(
    defaultPath,
    `server:\n  listen: ["0.0.0.0:53"]\ncache:\n  redis:\n    address: "redis:6379"\nblocklists:\n  sources: []\n`
  );
  await fs.writeFile(
    configPath,
    `logging:\n  level: "warning"\nblocklists:\n  sources: []\n`
  );

  const mockControl = http.createServer((req, res) => {
    if (req.url === "/errors" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [], log_level: "info" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => mockControl.listen(0, resolve));
  const { port } = mockControl.address();
  const mockControlUrl = `http://127.0.0.1:${port}`;

  try {
    const { app } = createApp({
      defaultConfigPath: defaultPath,
      configPath,
      dnsControlUrl: mockControlUrl,
      clickhouseEnabled: false,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/errors`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.log_level, "warning", "API should return config logging.level when it differs from control API");
      assert.deepEqual(body.errors, []);
    });
  } finally {
    await new Promise((resolve) => mockControl.close(resolve));
  }
});

test("export endpoint requires clickhouse", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/queries/export`);
    assert.equal(response.status, 400);
  });
});

test("config export only includes non-default values and omits passwords", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const overridePath = path.join(tempDir, "config.yaml");
  
  await fs.writeFile(
    defaultPath,
    `server:
  listen:
    - "0.0.0.0:53"
cache:
  redis:
    address: "redis:6379"
    password: "default-secret"
query_store:
  enabled: true
  password: "default-secret2"
control:
  token: "default-token"
blocklists:
  refresh_interval: "6h"
  sources: []
`
  );
  
  await fs.writeFile(
    overridePath,
    `blocklists:
  refresh_interval: "12h"
  sources:
    - name: "custom"
      url: "https://example.com"
cache:
  redis:
    password: "override-secret"
query_store:
  password: "override-secret2"
control:
  token: "override-token"
`
  );

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath: overridePath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config/export`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith("application/x-yaml"));
    
    const body = await response.text();
    
    // Should include modified values
    assert.ok(body.includes("refresh_interval"));
    assert.ok(body.includes("12h"));
    assert.ok(body.includes("custom"));
    
    // Should NOT include passwords
    assert.ok(!body.includes("password"));
    assert.ok(!body.includes("token"));
    assert.ok(!body.includes("override-secret"));
    assert.ok(!body.includes("override-token"));
    
    // Should NOT include default values that weren't overridden
    assert.ok(!body.includes("0.0.0.0:53"));
  });
});

test("config export excludes instance details by default", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const overridePath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `blocklists:
  refresh_interval: "6h"
  sources: []
`
  );

  await fs.writeFile(
    overridePath,
    `blocklists:
  refresh_interval: "12h"
  sources: []
ui:
  hostname: "my-dns-server.local"
sync:
  role: replica
  primary_url: "http://primary:8081"
  sync_token: "secret-token"
`
  );

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath: overridePath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config/export`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("12h"));
    assert.ok(!body.includes("hostname"));
    assert.ok(!body.includes("my-dns-server"));
    assert.ok(!body.includes("sync"));
    assert.ok(!body.includes("primary_url"));
    assert.ok(!body.includes("sync_token"));
  });
});

test("config export includes instance details when exclude_instance_details=false", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const overridePath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `blocklists:
  refresh_interval: "6h"
  sources: []
`
  );

  await fs.writeFile(
    overridePath,
    `blocklists:
  refresh_interval: "12h"
  sources: []
ui:
  hostname: "replica-a.example.com"
sync:
  role: replica
  primary_url: "http://primary:8081"
`
  );

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath: overridePath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config/export?exclude_instance_details=false`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("12h"));
    assert.ok(body.includes("hostname"));
    assert.ok(body.includes("replica-a.example.com"));
    assert.ok(body.includes("sync"));
    assert.ok(body.includes("primary_url"));
  });
});

test("config import merges with existing overrides", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const overridePath = path.join(tempDir, "config.yaml");
  
  await fs.writeFile(
    defaultPath,
    `blocklists:
  refresh_interval: "6h"
  sources: []
  allowlist: []
`
  );
  
  await fs.writeFile(
    overridePath,
    `blocklists:
  allowlist:
    - "existing.com"
`
  );

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath: overridePath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const importData = {
      blocklists: {
        refresh_interval: "24h",
        sources: [
          { name: "imported", url: "https://imported.com" }
        ]
      }
    };
    
    const response = await fetch(`${baseUrl}/api/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(importData),
    });
    
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    
    // Verify the config was saved correctly
    const savedConfig = await fs.readFile(overridePath, "utf8");
    assert.ok(savedConfig.includes("24h"));
    assert.ok(savedConfig.includes("imported"));
    assert.ok(savedConfig.includes("existing.com"));
  });
});

test("config import rejects invalid data", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const configPath = path.join(tempDir, "config.yaml");
  
  const { app } = createApp({
    configPath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    // Test with array instead of object
    const response = await fetch(`${baseUrl}/api/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });
    
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.ok(result.error);
    assert.ok(result.error.includes("Invalid config format"));
  });
});

test("system config GET returns client_identification and client_groups", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const configPath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `server:
  listen: ["0.0.0.0:53"]
cache:
  redis:
    address: "redis:6379"
blocklists:
  sources: []
`
  );
  await fs.writeFile(
    configPath,
    `client_identification:
  enabled: true
  clients:
    - ip: "192.168.1.10"
      name: "Kids Tablet"
      group_id: "kids"
    - ip: "192.168.1.11"
      name: "Adults Phone"
      group_id: "adults"
client_groups:
  - id: "kids"
    name: "Kids"
    description: "Children devices"
  - id: "adults"
    name: "Adults"
`
  );

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.client_identification.enabled, true);
    assert.equal(body.client_identification.clients.length, 2);
    assert.equal(body.client_identification.clients[0].ip, "192.168.1.10");
    assert.equal(body.client_identification.clients[0].name, "Kids Tablet");
    assert.equal(body.client_identification.clients[0].group_id, "kids");
    assert.equal(body.client_groups.length, 2);
    assert.equal(body.client_groups[0].id, "kids");
    assert.equal(body.client_groups[0].name, "Kids");
    assert.equal(body.client_groups[0].description, "Children devices");
  });
});

test("system config PUT saves client_identification and client_groups", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const configPath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `server:
  listen: ["0.0.0.0:53"]
cache:
  redis:
    address: "redis:6379"
blocklists:
  sources: []
`
  );
  await fs.writeFile(configPath, `blocklists:\n  sources: []\n`);

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(getRes.status, 200);
    const current = await getRes.json();

    const updated = {
      ...current,
      client_identification: {
        enabled: true,
        clients: [
          { ip: "10.0.0.1", name: "New Device", group_id: "kids" },
        ],
      },
      client_groups: [
        { id: "kids", name: "Kids", description: "Kids group" },
      ],
    };

    const putRes = await fetch(`${baseUrl}/api/system/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    assert.equal(putRes.status, 200);

    const verifyRes = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(verifyRes.status, 200);
    const verified = await verifyRes.json();
    assert.equal(verified.client_identification.enabled, true);
    assert.equal(verified.client_identification.clients.length, 1);
    assert.equal(verified.client_identification.clients[0].ip, "10.0.0.1");
    assert.equal(verified.client_identification.clients[0].name, "New Device");
    assert.equal(verified.client_identification.clients[0].group_id, "kids");
    assert.equal(verified.client_groups.length, 1);
    assert.equal(verified.client_groups[0].id, "kids");
    assert.equal(verified.client_groups[0].name, "Kids");
  });
});

test("system config PUT/GET round-trips client_groups with blocklist", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const configPath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `server:
  listen: ["0.0.0.0:53"]
cache:
  redis:
    address: "redis:6379"
blocklists:
  sources: []
`
  );
  await fs.writeFile(configPath, `blocklists:\n  sources: []\n`);

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const getResBefore = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(getResBefore.status, 200);
    const current = await getResBefore.json();

    const groupsWithBlocklist = [
      {
        id: "kids",
        name: "Kids",
        description: "Strict filtering",
        blocklist: {
          inherit_global: false,
          sources: [{ name: "test", url: "https://example.com/list.txt" }],
          allowlist: [],
          denylist: ["roblox.com"],
        },
      },
      { id: "adults", name: "Adults", blocklist: { inherit_global: true } },
    ];

    const putRes = await fetch(`${baseUrl}/api/system/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, client_groups: groupsWithBlocklist }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.client_groups.length, 2);
    assert.equal(body.client_groups[0].blocklist.inherit_global, false);
    assert.deepEqual(body.client_groups[0].blocklist.denylist, ["roblox.com"]);
    assert.equal(body.client_groups[1].blocklist.inherit_global, true);
  });
});

test("system config PUT/GET round-trips client_groups with safe_search", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const configPath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `server:
  listen: ["0.0.0.0:53"]
cache:
  redis:
    address: "redis:6379"
blocklists:
  sources: []
`
  );
  await fs.writeFile(configPath, `blocklists:\n  sources: []\n`);

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const getResBefore = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(getResBefore.status, 200);
    const current = await getResBefore.json();

    const groupsWithSafeSearch = [
      {
        id: "kids",
        name: "Kids",
        description: "Strict filtering",
        safe_search: { enabled: true, google: true, bing: true },
      },
      { id: "adults", name: "Adults", safe_search: { enabled: false } },
    ];

    const putRes = await fetch(`${baseUrl}/api/system/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, client_groups: groupsWithSafeSearch }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.client_groups.length, 2);
    assert.equal(body.client_groups[0].safe_search.enabled, true);
    assert.equal(body.client_groups[0].safe_search.google, true);
    assert.equal(body.client_groups[0].safe_search.bing, true);
    assert.equal(body.client_groups[1].safe_search.enabled, false);
  });
});

test("clients discovery returns disabled when clickhouse off", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clients/discovery`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.deepEqual(body.discovered, []);
  });
});

test("system config GET handles legacy map format for clients", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-config-"));
  const defaultPath = path.join(tempDir, "default.yaml");
  const configPath = path.join(tempDir, "config.yaml");

  await fs.writeFile(
    defaultPath,
    `server:
  listen: ["0.0.0.0:53"]
cache:
  redis:
    address: "redis:6379"
blocklists:
  sources: []
`
  );
  await fs.writeFile(
    configPath,
    `client_identification:
  enabled: true
  clients:
    "192.168.1.10": "legacy-device"
`
  );

  const { app } = createApp({
    defaultConfigPath: defaultPath,
    configPath,
    clickhouseEnabled: false,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.client_identification.enabled, true);
    assert.equal(body.client_identification.clients.length, 1);
    assert.equal(body.client_identification.clients[0].ip, "192.168.1.10");
    assert.equal(body.client_identification.clients[0].name, "legacy-device");
    assert.equal(body.client_identification.clients[0].group_id, "");
  });
});

test("auth status returns authEnabled false when no password set", async () => {
  const { app } = createApp({ clickhouseEnabled: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/status`, {
      credentials: "include",
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.authEnabled, false);
    assert.equal(body.authenticated, false);
    assert.equal(body.canSetInitialPassword, true);
    assert.equal(body.passwordEditable, true);
  });
});

test("protected routes return 401 when auth enabled and not logged in", async () => {
  _resetStoredHash();
  const origEnv = process.env.UI_PASSWORD;
  process.env.UI_PASSWORD = "testpass123";

  try {
    const session = await import("express-session");
    const MemoryStore = session.default.MemoryStore;
    const { app } = createApp({
      clickhouseEnabled: false,
      redisUrl: "redis://localhost:6379",
      sessionStore: new MemoryStore(),
    });

    await withServer(app, async (baseUrl) => {
      const statusRes = await fetch(`${baseUrl}/api/auth/status`, {
        credentials: "include",
      });
      const status = await statusRes.json();
      assert.equal(status.authEnabled, true);
      assert.equal(status.authenticated, false);

      const blocklistRes = await fetch(`${baseUrl}/api/blocklists`, {
        credentials: "include",
      });
      assert.equal(blocklistRes.status, 401);
      const body = await blocklistRes.json();
      assert.equal(body.requiresAuth, true);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "testpass123" }),
      });
      assert.equal(loginRes.status, 200);
      // When password is from env, passwordEditable is false
      assert.equal(status.passwordEditable, false);
    });
  } finally {
    if (origEnv !== undefined) process.env.UI_PASSWORD = origEnv;
    else delete process.env.UI_PASSWORD;
  }
});

test("set-password allows initial password when auth disabled and file-based", async () => {
  _resetStoredHash();
  const origEnv = process.env.UI_PASSWORD;
  const origAdminEnv = process.env.ADMIN_PASSWORD;
  const origFile = process.env.ADMIN_PASSWORD_FILE;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-test-"));
  const passwordFile = path.join(tempDir, ".admin-password");
  delete process.env.UI_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD_FILE = passwordFile;

  try {
    const session = await import("express-session");
    const { app } = createApp({
      clickhouseEnabled: false,
      sessionStore: new session.default.MemoryStore(),
    });
    await withServer(app, async (baseUrl) => {
      const setRes = await fetch(`${baseUrl}/api/auth/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPassword: "newpass123" }),
      });
      if (setRes.status !== 200) {
        const errBody = await setRes.text();
        throw new Error(`Expected 200, got ${setRes.status}: ${errBody}`);
      }
      const setBody = await setRes.json();
      assert.equal(setBody.ok, true);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: "admin", password: "newpass123" }),
      });
      assert.equal(loginRes.status, 200);
    });
  } finally {
    if (origEnv !== undefined) process.env.UI_PASSWORD = origEnv;
    else delete process.env.UI_PASSWORD;
    if (origAdminEnv !== undefined) process.env.ADMIN_PASSWORD = origAdminEnv;
    else delete process.env.ADMIN_PASSWORD;
    if (origFile !== undefined) process.env.ADMIN_PASSWORD_FILE = origFile;
    else delete process.env.ADMIN_PASSWORD_FILE;
    await fs.rm(tempDir, { recursive: true }).catch(() => {});
  }
});

test("set-password requires auth when changing existing password", async () => {
  _resetStoredHash();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-test2-"));
  const passwordFile = path.join(tempDir, ".admin-password");
  const hash = (await import("bcryptjs")).default.hashSync("oldpass123", 10);
  await fs.writeFile(passwordFile, hash, { mode: 0o600 });
  const origFile = process.env.ADMIN_PASSWORD_FILE;
  delete process.env.UI_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD_FILE = passwordFile;

  try {
    const session = await import("express-session");
    const { app } = createApp({
      clickhouseEnabled: false,
      sessionStore: new session.default.MemoryStore(),
    });
    await withServer(app, async (baseUrl) => {
      const setRes = await fetch(`${baseUrl}/api/auth/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: "oldpass123", newPassword: "newpass456" }),
      });
      assert.equal(setRes.status, 401);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: "admin", password: "oldpass123" }),
      });
      assert.equal(loginRes.status, 200);
      const cookies = loginRes.headers.get("set-cookie");
      const sessionCookie = cookies?.split(";").find((c) => c.trim().startsWith("beyond_ads.sid="));

      const setRes2 = await fetch(`${baseUrl}/api/auth/set-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie || "",
        },
        credentials: "include",
        body: JSON.stringify({ currentPassword: "oldpass123", newPassword: "newpass456" }),
      });
      assert.equal(setRes2.status, 200);
    });
  } finally {
    if (origFile !== undefined) process.env.ADMIN_PASSWORD_FILE = origFile;
    else delete process.env.ADMIN_PASSWORD_FILE;
    await fs.rm(tempDir, { recursive: true }).catch(() => {});
  }
});

test("set-password rejects when password from env", async () => {
  _resetStoredHash();
  const origEnv = process.env.UI_PASSWORD;
  process.env.UI_PASSWORD = "envpass";

  try {
    const session = await import("express-session");
    const { app } = createApp({
      clickhouseEnabled: false,
      sessionStore: new session.default.MemoryStore(),
    });
    await withServer(app, async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: "admin", password: "envpass" }),
      });
      assert.equal(loginRes.status, 200);
      const cookies = loginRes.headers.get("set-cookie");
      const sessionCookie = cookies?.split(";").find((c) => c.trim().startsWith("beyond_ads.sid="));

      const setRes = await fetch(`${baseUrl}/api/auth/set-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie || "",
        },
        credentials: "include",
        body: JSON.stringify({ currentPassword: "envpass", newPassword: "newpass123" }),
      });
      assert.equal(setRes.status, 400);
      const body = await setRes.json();
      assert.ok(body.error?.includes("environment variable"));
    });
  } finally {
    if (origEnv !== undefined) process.env.UI_PASSWORD = origEnv;
    else delete process.env.UI_PASSWORD;
  }
});
