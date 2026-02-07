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
