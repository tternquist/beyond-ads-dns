/**
 * Unit tests for the /api/blocklists routes.
 * Uses real temp config files (no mocks) and a mock fetch for DNS control calls.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import express from "express";
import { registerBlocklistsRoutes } from "../src/routes/blocklists.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(ctx) {
  const app = express();
  app.use(express.json());
  app.locals.ctx = ctx;
  registerBlocklistsRoutes(app);
  return app;
}

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

async function writeTempYaml(dir, filename, content) {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// GET /api/blocklists
// ---------------------------------------------------------------------------

describe("GET /api/blocklists", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "blocklists-get-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns 400 when neither defaultConfigPath nor configPath is set", async () => {
    const app = createTestApp({});
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error, "expected error message");
    });
  });

  test("returns blocklist config from merged config", async () => {
    const defaultConfig = await writeTempYaml(tmpDir, "default.yaml", `
blocklists:
  refresh_interval: "6h"
  sources:
    - name: hagezi-pro
      url: https://example.com/blocklist.txt
  allowlist: []
  denylist: []
`);
    const overrideConfig = await writeTempYaml(tmpDir, "override.yaml", "");

    const app = createTestApp({ defaultConfigPath: defaultConfig, configPath: overrideConfig });
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.refreshInterval, "6h");
      assert.ok(Array.isArray(body.sources), "expected sources array");
      assert.equal(body.sources.length, 1);
      assert.equal(body.sources[0].name, "hagezi-pro");
    });
  });

  test("returns defaults for missing blocklist fields", async () => {
    const defaultConfig = await writeTempYaml(tmpDir, "default-minimal.yaml", `
server:
  listen: ["127.0.0.1:53"]
`);
    const app = createTestApp({ defaultConfigPath: defaultConfig });
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.refreshInterval, "6h");
      assert.deepEqual(body.sources, []);
      assert.deepEqual(body.allowlist, []);
      assert.deepEqual(body.denylist, []);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/blocklists
// ---------------------------------------------------------------------------

describe("PUT /api/blocklists", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "blocklists-put-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns 400 when CONFIG_PATH is not set", async () => {
    const app = createTestApp({ defaultConfigPath: "/dev/null" });
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [{ url: "https://example.com/list.txt", name: "test" }] }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes("CONFIG_PATH"));
    });
  });

  test("returns 400 when sources array is empty", async () => {
    const overridePath = await writeTempYaml(tmpDir, "override-empty.yaml", "");
    const app = createTestApp({ configPath: overridePath });
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [] }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.toLowerCase().includes("source"), "expected source-related error");
    });
  });

  test("saves valid blocklist config and returns ok", async () => {
    const defaultPath = await writeTempYaml(tmpDir, "default-put.yaml", `
blocklists:
  sources: []
`);
    const overridePath = await writeTempYaml(tmpDir, "override-put.yaml", "");
    const app = createTestApp({ defaultConfigPath: defaultPath, configPath: overridePath });

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshInterval: "12h",
          sources: [{ url: "https://example.com/block.txt", name: "test-list" }],
          allowlist: ["safe.example.com"],
          denylist: [],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.blocklists.refresh_interval, "12h");
      assert.equal(body.blocklists.sources.length, 1);
      assert.equal(body.blocklists.allowlist.length, 1);
    });
  });

  test("deduplicates sources by URL", async () => {
    const overridePath = await writeTempYaml(tmpDir, "override-dedup.yaml", "");
    const app = createTestApp({ configPath: overridePath });

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [
            { url: "https://example.com/list.txt", name: "a" },
            { url: "https://example.com/list.txt", name: "duplicate" },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.blocklists.sources.length, 1, "expected deduplication of sources");
    });
  });

  test("returns 400 for invalid scheduled_pause", async () => {
    const overridePath = await writeTempYaml(tmpDir, "override-sp.yaml", "");
    const app = createTestApp({ configPath: overridePath });

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ url: "https://example.com/list.txt", name: "test" }],
          scheduled_pause: { enabled: true, start: "bad-time", end: "17:00" },
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes("scheduled_pause"));
    });
  });

  test("returns 403 when instance is a replica", async () => {
    const defaultPath = await writeTempYaml(tmpDir, "default-replica.yaml", `
sync:
  enabled: true
  role: replica
`);
    const overridePath = await writeTempYaml(tmpDir, "override-replica.yaml", "");
    const app = createTestApp({ defaultConfigPath: defaultPath, configPath: overridePath });

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ url: "https://example.com/list.txt", name: "test" }],
        }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.ok(body.error.toLowerCase().includes("replica"));
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/blocklists/apply
// ---------------------------------------------------------------------------

describe("POST /api/blocklists/apply", () => {
  test("returns 400 when DNS_CONTROL_URL is not set", async () => {
    const app = createTestApp({});
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists/apply`, { method: "POST" });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes("DNS_CONTROL_URL"));
    });
  });

  test("proxies to control server and returns ok on success", async () => {
    // Spin up a minimal mock DNS control server
    let controlCalled = false;
    const controlServer = http.createServer((req, res) => {
      if (req.url === "/blocklists/reload" && req.method === "POST") {
        controlCalled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => controlServer.listen(0, resolve));
    const controlPort = controlServer.address().port;
    const controlUrl = `http://127.0.0.1:${controlPort}`;

    try {
      const app = createTestApp({ dnsControlUrl: controlUrl });
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/blocklists/apply`, { method: "POST" });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(controlCalled, true, "expected DNS control server to be called");
      });
    } finally {
      await new Promise((resolve) => controlServer.close(resolve));
    }
  });

  test("returns 502 when control server returns error", async () => {
    const controlServer = http.createServer((req, res) => {
      res.writeHead(500);
      res.end("internal error");
    });
    await new Promise((resolve) => controlServer.listen(0, resolve));
    const controlPort = controlServer.address().port;

    try {
      const app = createTestApp({ dnsControlUrl: `http://127.0.0.1:${controlPort}` });
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/blocklists/apply`, { method: "POST" });
        assert.equal(res.status, 502);
      });
    } finally {
      await new Promise((resolve) => controlServer.close(resolve));
    }
  });

  test("forwards Authorization header when dnsControlToken is set", async () => {
    let receivedAuth = null;
    const controlServer = http.createServer((req, res) => {
      receivedAuth = req.headers["authorization"];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => controlServer.listen(0, resolve));
    const controlPort = controlServer.address().port;

    try {
      const app = createTestApp({
        dnsControlUrl: `http://127.0.0.1:${controlPort}`,
        dnsControlToken: "my-secret",
      });
      await withServer(app, async (baseUrl) => {
        await fetch(`${baseUrl}/api/blocklists/apply`, { method: "POST" });
        assert.equal(receivedAuth, "Bearer my-secret");
      });
    } finally {
      await new Promise((resolve) => controlServer.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/blocklists/stats
// ---------------------------------------------------------------------------

describe("GET /api/blocklists/stats", () => {
  test("returns 400 when DNS_CONTROL_URL is not set", async () => {
    const app = createTestApp({});
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/blocklists/stats`);
      assert.equal(res.status, 400);
    });
  });

  test("proxies stats from control server", async () => {
    const stats = { blocked: 123456, allow: 10, deny: 5 };
    const controlServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
    });
    await new Promise((resolve) => controlServer.listen(0, resolve));
    const controlPort = controlServer.address().port;

    try {
      const app = createTestApp({ dnsControlUrl: `http://127.0.0.1:${controlPort}` });
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/blocklists/stats`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.blocked, 123456);
      });
    } finally {
      await new Promise((resolve) => controlServer.close(resolve));
    }
  });
});
