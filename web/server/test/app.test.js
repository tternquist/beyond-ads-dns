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
