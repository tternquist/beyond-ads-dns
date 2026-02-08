import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";

import { createApp } from "../src/index.js";

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
