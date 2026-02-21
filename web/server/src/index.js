import express from "express";
import cors from "cors";
import session from "express-session";
import { RedisStore } from "connect-redis";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAuthEnabled, canEditPassword } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerRedisRoutes } from "./routes/redis.js";
import { registerQueriesRoutes } from "./routes/queries.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerDnsRoutes } from "./routes/dns.js";
import { registerBlocklistsRoutes } from "./routes/blocklists.js";
import { registerWebhooksRoutes } from "./routes/webhooks.js";
import { registerControlRoutes } from "./routes/control.js";
import { authMiddleware } from "./middleware/auth.js";
import { createRedisClientFromEnv } from "./services/redis.js";
import { createClickhouseClient } from "./services/clickhouse.js";
import { parseBoolean, formatBytes } from "./utils/helpers.js";
import { readMergedConfig } from "./utils/config.js";
import {
  isLetsEncryptEnabled,
  getLetsEncryptConfig,
  hasValidCert,
  loadCertForHttps,
  obtainCertificate,
  getChallenge,
  isLetsEncryptDnsChallenge,
  setLetsEncryptHttpsReady,
  isLetsEncryptHttpsReady,
} from "./letsencrypt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Attempts to read container memory limit from cgroups (Docker, Kubernetes, etc.).
 * Returns limit in bytes, or null if not in a container, no limit ("max"), or unable to read.
 * Supports cgroup v2 (memory.max) and cgroup v1 (memory.limit_in_bytes).
 */
function getContainerMemoryLimitBytes() {
  try {
    const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
    const lines = cgroup.trim().split("\n");

    const v2Match = lines.find((l) => l.startsWith("0::"));
    if (v2Match) {
      const cgroupPath = v2Match.slice(3).trim() || "/";
      const base = "/sys/fs/cgroup";
      const memPath = path.join(base, cgroupPath, "memory.max");
      try {
        const val = fs.readFileSync(memPath, "utf8").trim();
        if (val === "max") return null;
        const bytes = parseInt(val, 10);
        return Number.isNaN(bytes) || bytes <= 0 ? null : bytes;
      } catch {
        return null;
      }
    }

    const memLine = lines.find((l) => l.includes(":memory:"));
    if (!memLine) return null;
    const pathPart = memLine.split(":memory:")[1]?.trim();
    if (!pathPart) return null;
    const memPath = path.join("/sys/fs/cgroup/memory", pathPart, "memory.limit_in_bytes");
    try {
      const val = fs.readFileSync(memPath, "utf8").trim();
      const bytes = parseInt(val, 10);
      if (Number.isNaN(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) return null;
      if (bytes > 1024 * 1024 * 1024 * 1024) return null;
      return bytes;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Attempts to detect Raspberry Pi model for resource-aware tuning.
 */
function getRaspberryPiModel() {
  const envOverride = process.env.RASPBERRY_PI_MODEL?.trim().toLowerCase();
  if (envOverride === "pi4" || envOverride === "pi5" || envOverride === "pi_other") {
    return envOverride;
  }

  try {
    const paths = [
      "/proc/device-tree/model",
      "/sys/firmware/devicetree/base/model",
      "/host/proc/device-tree/model",
    ];
    for (const p of paths) {
      try {
        const buf = fs.readFileSync(p);
        const model = (buf.toString("utf8") || "").replace(/\0/g, "").trim();
        if (/Raspberry Pi 4/i.test(model)) return "pi4";
        if (/Raspberry Pi 5/i.test(model)) return "pi5";
        if (/Raspberry Pi\s/i.test(model)) return "pi_other";
      } catch {
        // File missing or unreadable
      }
    }

    const compatiblePaths = [
      "/proc/device-tree/compatible",
      "/sys/firmware/devicetree/base/compatible",
      "/host/proc/device-tree/compatible",
    ];
    for (const p of compatiblePaths) {
      try {
        const buf = fs.readFileSync(p);
        const compatible = (buf.toString("utf8") || "").replace(/\0/g, " ");
        if (/\bbcm2711\b/.test(compatible)) return "pi4";
        if (/\bbcm2712\b/.test(compatible)) return "pi5";
      } catch {
        // ignore
      }
    }

    const cpuinfoPaths = ["/host/proc/cpuinfo", "/proc/cpuinfo"];
    for (const p of cpuinfoPaths) {
      try {
        const cpuinfo = fs.readFileSync(p, "utf8");
        if (/Hardware\s*:\s*BCM2711\b/.test(cpuinfo)) return "pi4";
        if (/Hardware\s*:\s*BCM2712\b/.test(cpuinfo)) return "pi5";
        if (/Hardware\s*:\s*BCM(2710|283[567])\b/.test(cpuinfo)) return "pi_other";
        break;
      } catch {
        // ignore
      }
    }
  } catch {}
  return null;
}

/**
 * Returns raw detection data for debugging Raspberry Pi detection.
 */
function getRaspberryPiDebugInfo() {
  const envOverride = process.env.RASPBERRY_PI_MODEL?.trim().toLowerCase();
  const out = {
    detectedModel: getRaspberryPiModel(),
    envOverride: envOverride && (envOverride === "pi4" || envOverride === "pi5" || envOverride === "pi_other") ? envOverride : null,
    deviceTree: { model: null, compatible: null, path: null, error: null },
    cpuinfo: { hardware: null, path: null, error: null },
  };

  const dtPaths = [
    "/proc/device-tree/model",
    "/sys/firmware/devicetree/base/model",
    "/host/proc/device-tree/model",
  ];
  for (const p of dtPaths) {
    try {
      const buf = fs.readFileSync(p);
      const model = (buf.toString("utf8") || "").replace(/\0/g, "").trim();
      out.deviceTree.model = model || "(empty)";
      out.deviceTree.path = p;
      out.deviceTree.error = null;
      break;
    } catch (e) {
      out.deviceTree.error = e.code || e.message || "unreadable";
    }
  }
  const compatiblePaths = ["/proc/device-tree/compatible", "/sys/firmware/devicetree/base/compatible", "/host/proc/device-tree/compatible"];
  for (const p of compatiblePaths) {
    try {
      const buf = fs.readFileSync(p);
      out.deviceTree.compatible = (buf.toString("utf8") || "").replace(/\0/g, " ").trim() || null;
      break;
    } catch {
      // ignore
    }
  }
  if (out.deviceTree.model == null && !out.deviceTree.path) {
    out.deviceTree.error = out.deviceTree.error || "both paths missing or unreadable";
  }

  const cpuinfoPaths = ["/host/proc/cpuinfo", "/proc/cpuinfo"];
  for (const p of cpuinfoPaths) {
    try {
      const cpuinfo = fs.readFileSync(p, "utf8");
      const m = cpuinfo.match(/Hardware\s*:\s*(.+)/);
      out.cpuinfo.hardware = m ? m[1].trim() : "(not found)";
      out.cpuinfo.path = p;
      break;
    } catch (e) {
      out.cpuinfo.error = e.code || e.message || "unreadable";
    }
  }

  return out;
}

function blockPageHtml(domain) {
  const escaped = domain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Site Blocked</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #1a1a2e; color: #eee; }
    .card { max-width: 420px; text-align: center; padding: 2rem; background: #16213e; border-radius: 12px; }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    p { margin: 0; color: #a0a0a0; line-height: 1.5; }
    .domain { font-weight: 600; color: #e94560; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Site Blocked</h1>
    <p>This site (<span class="domain">${escaped}</span>) has been blocked by your DNS resolver.</p>
  </div>
</body>
</html>`;
}

export function createApp(options = {}) {
  const startTimestamp = new Date().toISOString();
  const app = express();

  app.set("trust proxy", 1);

  if (isLetsEncryptEnabled() && !isLetsEncryptDnsChallenge()) {
    app.get("/.well-known/acme-challenge/:token", (req, res) => {
      const keyAuthz = getChallenge(req.params.token);
      if (!keyAuthz) {
        res.status(404).send("Challenge not found");
        return;
      }
      res.type("text/plain").send(keyAuthz);
    });
    app.use((req, res, next) => {
      if (
        !isLetsEncryptHttpsReady() ||
        req.secure ||
        req.path.startsWith("/.well-known/acme-challenge/")
      ) {
        return next();
      }
      const host = (req.get("host") || "localhost").replace(/:80$/, "");
      res.redirect(301, `https://${host}${req.originalUrl}`);
    });
  }

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  const redisUrl =
    options.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
  const redisMode = (options.redisMode || process.env.REDIS_MODE || "standalone").toLowerCase();
  app.locals.redisMode = redisMode;
  let redisSentinelAddrs = options.redisSentinelAddrs || process.env.REDIS_SENTINEL_ADDRS || "";
  if (!redisSentinelAddrs.trim() && redisMode === "sentinel") {
    const addr = process.env.REDIS_ADDRESS || "";
    if (addr.trim()) redisSentinelAddrs = addr.split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  }
  const redisMasterName = options.redisMasterName || process.env.REDIS_MASTER_NAME || "";
  let redisClusterAddrs = options.redisClusterAddrs || process.env.REDIS_CLUSTER_ADDRS || "";
  if (!redisClusterAddrs.trim() && redisMode === "cluster") {
    const addr = process.env.REDIS_ADDRESS || "";
    if (addr.trim()) redisClusterAddrs = addr.split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  }
  const redisPassword = options.redisPassword || process.env.REDIS_PASSWORD || "";

  const redisClient = createRedisClientFromEnv({
    redisUrl,
    redisMode,
    redisSentinelAddrs,
    redisMasterName,
    redisClusterAddrs,
    redisPassword,
  });

  const clickhouseEnabled =
    options.clickhouseEnabled ??
    parseBoolean(process.env.CLICKHOUSE_ENABLED, false);
  const clickhouseUrl =
    options.clickhouseUrl ||
    process.env.CLICKHOUSE_URL ||
    "http://localhost:8123";
  const clickhouseDatabase =
    options.clickhouseDatabase ||
    process.env.CLICKHOUSE_DATABASE ||
    "beyond_ads";
  const clickhouseTable =
    options.clickhouseTable || process.env.CLICKHOUSE_TABLE || "dns_queries";
  const clickhouseUser =
    options.clickhouseUser || process.env.CLICKHOUSE_USER || "default";
  const clickhousePassword =
    options.clickhousePassword || process.env.CLICKHOUSE_PASSWORD || "";
  const configPath =
    options.configPath || process.env.CONFIG_PATH || "";
  const defaultConfigPath =
    options.defaultConfigPath || process.env.DEFAULT_CONFIG_PATH || "";
  const dnsControlUrl =
    options.dnsControlUrl || process.env.DNS_CONTROL_URL || "";
  const dnsControlToken =
    options.dnsControlToken || process.env.DNS_CONTROL_TOKEN || "";

  redisClient.on("error", (err) => {
    console.error("Redis client error:", err);
  });

  const sessionSecret =
    options.sessionSecret ||
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString("hex");
  const sessionStore =
    options.sessionStore || new RedisStore({ client: redisClient });
  const isHttps =
    parseBoolean(process.env.HTTPS_ENABLED, false) ||
    isLetsEncryptEnabled();
  app.use(
    session({
      store: sessionStore,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      name: "beyond_ads.sid",
      cookie: {
        secure: isHttps,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use("/api", authMiddleware);

  registerAuthRoutes(app);

  let clickhouseClient = null;
  if (clickhouseEnabled) {
    clickhouseClient = createClickhouseClient({
      url: clickhouseUrl,
      database: clickhouseDatabase,
      username: clickhouseUser,
      password: clickhousePassword,
    });
  }

  const appLocals = {
    redisClient,
    redisUrl,
    clickhouseEnabled,
    clickhouseClient,
    clickhouseDatabase,
    clickhouseTable,
    defaultConfigPath,
    configPath,
    dnsControlUrl,
    dnsControlToken,
    startTimestamp,
    formatBytes,
    readMergedConfig,
    getContainerMemoryLimitBytes,
    getRaspberryPiModel,
    getRaspberryPiDebugInfo,
  };
  app.locals.ctx = appLocals;

  registerSystemRoutes(app);
  registerRedisRoutes(app);
  registerQueriesRoutes(app);
  registerConfigRoutes(app);
  registerSyncRoutes(app);
  registerDnsRoutes(app);
  registerBlocklistsRoutes(app);
  registerWebhooksRoutes(app);
  registerControlRoutes(app);

  // Block page: when Host is a blocked domain, serve HTML block page
  app.use(async (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/.well-known/")) {
      return next();
    }
    const host = (req.get("host") || "").split(":")[0].toLowerCase().trim();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return next();
    }
    const { dnsControlUrl: ctrlUrl, dnsControlToken: ctrlToken } = appLocals;
    if (!ctrlUrl) return next();
    try {
      const controlUrl = new URL("/blocked/check", ctrlUrl);
      controlUrl.searchParams.set("domain", host);
      const headers = {};
      if (ctrlToken) {
        headers.Authorization = `Bearer ${ctrlToken}`;
      }
      const response = await fetch(controlUrl.toString(), { headers });
      if (!response.ok) return next();
      const data = await response.json();
      if (data && data.blocked) {
        return res.type("text/html").status(200).send(blockPageHtml(host));
      }
    } catch {
      // Control API unreachable, continue
    }
    next();
  });

  const staticDir =
    options.staticDir ||
    process.env.STATIC_DIR ||
    path.join(__dirname, "..", "public");

  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      if (req.path.startsWith("/api/")) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return { app, redisClient };
}

export async function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 80);
  const httpsPort = Number(
    options.httpsPort || process.env.HTTPS_PORT || 443
  );
  const httpsEnabled =
    options.httpsEnabled ?? parseBoolean(process.env.HTTPS_ENABLED, false);
  const letsEncryptEnabled = isLetsEncryptEnabled();
  const sslCertFile =
    options.sslCertFile || process.env.SSL_CERT_FILE || process.env.HTTPS_CERT;
  const sslKeyFile =
    options.sslKeyFile || process.env.SSL_KEY_FILE || process.env.HTTPS_KEY;

  const configPath = options.configPath || process.env.CONFIG_PATH || "";
  const defaultConfigPath = options.defaultConfigPath || process.env.DEFAULT_CONFIG_PATH || "";
  const mergedOptions = { ...options };
  if (configPath || defaultConfigPath) {
    try {
      const merged = await readMergedConfig(defaultConfigPath, configPath);
      const redis = merged?.cache?.redis || {};
      const env = (k) => (process.env[k] || "").trim();
      if (!env("REDIS_MODE") && redis.mode) mergedOptions.redisMode = String(redis.mode).toLowerCase();
      if (!env("REDIS_URL") && !env("REDIS_ADDRESS") && redis.address) mergedOptions.redisUrl = redis.address.includes("://") ? redis.address : `redis://${redis.address}`;
      if (!env("REDIS_PASSWORD") && redis.password) mergedOptions.redisPassword = String(redis.password);
      if (!env("REDIS_MASTER_NAME") && redis.master_name) mergedOptions.redisMasterName = String(redis.master_name).trim();
      if (!env("REDIS_CLUSTER_ADDRS")) {
        if (Array.isArray(redis.cluster_addrs) && redis.cluster_addrs.length > 0) {
          mergedOptions.redisClusterAddrs = redis.cluster_addrs.map((a) => String(a).trim()).filter(Boolean).join(", ");
        } else if (redis.cluster_addrs && typeof redis.cluster_addrs === "string") {
          mergedOptions.redisClusterAddrs = redis.cluster_addrs.trim();
        } else if ((redis.mode === "cluster" || env("REDIS_MODE") === "cluster") && (redis.address || env("REDIS_ADDRESS"))) {
          const addr = redis.address || env("REDIS_ADDRESS");
          mergedOptions.redisClusterAddrs = String(addr).split(",").map((a) => a.trim()).filter(Boolean).join(", ");
        }
      }
      if (!env("REDIS_SENTINEL_ADDRS")) {
        if (Array.isArray(redis.sentinel_addrs) && redis.sentinel_addrs.length > 0) {
          mergedOptions.redisSentinelAddrs = redis.sentinel_addrs.map((a) => String(a).trim()).filter(Boolean).join(", ");
        } else if (redis.sentinel_addrs && typeof redis.sentinel_addrs === "string") {
          mergedOptions.redisSentinelAddrs = redis.sentinel_addrs.trim();
        } else if ((redis.mode === "sentinel" || env("REDIS_MODE") === "sentinel") && (redis.address || env("REDIS_ADDRESS"))) {
          const addr = redis.address || env("REDIS_ADDRESS");
          mergedOptions.redisSentinelAddrs = String(addr).split(",").map((a) => a.trim()).filter(Boolean).join(", ");
        }
      }
    } catch (_err) {
      // Config not found or invalid; env vars / defaults will be used
    }
  }

  const { app, redisClient } = createApp(mergedOptions);
  await redisClient.connect();

  if (!isAuthEnabled() && canEditPassword()) {
    console.log("No admin password configured. Set one in System Settings to protect the UI.");
  }

  let httpServer = null;
  let httpsServer = null;

  if (letsEncryptEnabled) {
    const leConfig = getLetsEncryptConfig();
    const primaryDomain = leConfig.domains[0];
    const useDnsChallenge = isLetsEncryptDnsChallenge();

    const certValid = await hasValidCert(leConfig.certDir, primaryDomain);
    let certData = certValid ? await loadCertForHttps(leConfig.certDir, primaryDomain) : null;

    if (!certData) {
      if (useDnsChallenge) {
        try {
          console.log("Obtaining Let's Encrypt certificate via DNS-01 challenge...");
          certData = await obtainCertificate(leConfig);
          console.log("Let's Encrypt certificate obtained successfully");
        } catch (err) {
          console.error("Let's Encrypt certificate acquisition failed:", err.message);
          console.log("Ensure TXT records were added correctly and LETSENCRYPT_DNS_PROPAGATION_WAIT allows time for propagation.");
          throw err;
        }
      } else {
        httpServer = app.listen(port, () => {
          console.log(`Metrics API (HTTP) listening on :${port}`);
        });

        try {
          console.log("Obtaining Let's Encrypt certificate...");
          certData = await obtainCertificate(leConfig);
          console.log("Let's Encrypt certificate obtained successfully");
        } catch (err) {
          console.error("Let's Encrypt certificate acquisition failed:", err.message);
          console.log("Continuing with HTTP only. Ensure port 80 is reachable and LETSENCRYPT_DOMAIN/LETSENCRYPT_EMAIL are set.");
          return { app, server: httpServer, redisClient };
        }
      }
    }

    if (!httpServer) {
      httpServer = app.listen(port, () => {
        console.log(`Metrics API (HTTP) listening on :${port}`);
      });
    }

    httpsServer = https.createServer(
      { cert: certData.cert, key: certData.key },
      app
    );
    httpsServer.listen(httpsPort, () => {
      setLetsEncryptHttpsReady(true);
      console.log(`Metrics API (HTTPS) listening on :${httpsPort}`);
    });

    return { app, server: httpsServer, httpServer, redisClient };
  }

  if (httpsEnabled && sslCertFile && sslKeyFile) {
    const cert = fs.readFileSync(sslCertFile);
    const key = fs.readFileSync(sslKeyFile);
    httpsServer = https.createServer({ cert, key }, app);
    httpsServer.listen(httpsPort, () => {
      console.log(`Metrics API (HTTPS) listening on :${httpsPort}`);
    });
    return { app, server: httpsServer, redisClient };
  }

  httpServer = app.listen(port, () => {
    console.log(`Metrics API listening on :${port}`);
  });
  return { app, server: httpServer, redisClient };
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
