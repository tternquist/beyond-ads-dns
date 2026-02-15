import express from "express";
import cors from "cors";
import session from "express-session";
import { RedisStore } from "connect-redis";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import https from "node:https";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient as createRedisClient } from "redis";
import { createClient as createClickhouseClient } from "@clickhouse/client";
import YAML from "yaml";
import { isAuthEnabled, verifyPassword, getAdminUsername } from "./auth.js";
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

export function createApp(options = {}) {
  const app = express();

  // Trust proxy for correct client IP and protocol (needed for HTTPS behind reverse proxy)
  app.set("trust proxy", 1);

  // ACME HTTP-01 challenge for Let's Encrypt (only when using HTTP challenge; DNS uses TXT records)
  if (isLetsEncryptEnabled() && !isLetsEncryptDnsChallenge()) {
    app.get("/.well-known/acme-challenge/:token", (req, res) => {
      const keyAuthz = getChallenge(req.params.token);
      if (!keyAuthz) {
        res.status(404).send("Challenge not found");
        return;
      }
      res.type("text/plain").send(keyAuthz);
    });
    // Redirect HTTP to HTTPS (except ACME challenge); only when HTTPS is ready
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
  app.use(express.json());

  const redisUrl =
    options.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
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

  const redisClient = createRedisClient({ url: redisUrl });
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

  function authMiddleware(req, res, next) {
    if (!isAuthEnabled()) return next();
    if (req.session?.authenticated) return next();
    const p = req.path;
    if ((p === "/api/auth/login" || p === "/auth/login") && req.method === "POST") return next();
    if ((p === "/api/auth/status" || p === "/auth/status") && req.method === "GET") return next();
    if ((p === "/api/health" || p === "/health") && req.method === "GET") return next();
    res.status(401).json({ error: "Unauthorized", requiresAuth: true });
  }

  app.use("/api", authMiddleware);

  app.get("/api/auth/status", (_req, res) => {
    res.json({
      authenticated: Boolean(_req.session?.authenticated),
      authEnabled: isAuthEnabled(),
      username: isAuthEnabled() ? getAdminUsername() : null,
    });
  });

  app.post("/api/auth/login", (req, res) => {
    if (!isAuthEnabled()) {
      res.json({ ok: true, authenticated: true });
      return;
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "Username and password required" });
      return;
    }
    if (!verifyPassword(String(username).trim(), String(password))) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    req.session.authenticated = true;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      res.json({ ok: true, authenticated: true });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ error: "Logout failed" });
        return;
      }
      res.clearCookie("beyond_ads.sid");
      res.json({ ok: true });
    });
  });

  let clickhouseClient = null;
  if (clickhouseEnabled) {
    clickhouseClient = createClickhouseClient({
      url: clickhouseUrl,
      database: clickhouseDatabase,
      username: clickhouseUser,
      password: clickhousePassword,
    });
  }

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      redisUrl,
      clickhouseEnabled,
    });
  });

  app.get("/api/info", async (_req, res) => {
    try {
      const hostname =
        process.env.UI_HOSTNAME ||
        process.env.HOSTNAME ||
        (await readMergedConfig(defaultConfigPath, configPath))?.ui?.hostname ||
        os.hostname();

      const mem = process.memoryUsage();
      const memoryUsage = formatBytes(mem.heapUsed);

      let buildTimestamp = process.env.BUILD_TIMESTAMP || null;
      if (!buildTimestamp) {
        try {
          const buildPath = path.join(__dirname, "..", "build-timestamp.txt");
          const ts = await fsPromises.readFile(buildPath, "utf8");
          buildTimestamp = ts?.trim() || null;
        } catch {
          // File not present in dev
        }
      }

      res.json({
        hostname: hostname.trim() || os.hostname(),
        memoryUsage,
        buildTimestamp,
      });
    } catch (err) {
      const hostname =
        process.env.UI_HOSTNAME || process.env.HOSTNAME || os.hostname();
      const mem = process.memoryUsage();
      res.json({
        hostname: hostname.trim() || os.hostname(),
        memoryUsage: formatBytes(mem.heapUsed),
        buildTimestamp: process.env.BUILD_TIMESTAMP || null,
      });
    }
  });

  app.get("/api/redis/summary", async (_req, res) => {
    try {
      const info = await redisClient.info();
      const parsed = parseRedisInfo(info);
      const hits = toNumber(parsed.keyspace_hits);
      const misses = toNumber(parsed.keyspace_misses);
      const totalRequests = hits + misses;
      const hitRate = totalRequests > 0 ? hits / totalRequests : null;
      const keyspace = parseKeyspace(parsed.db0);

      // Count keys by prefix (DNS cache entries vs metadata)
      let dnsKeys = 0;
      let dnsmetaKeys = 0;
      try {
        dnsKeys = await countKeysByPrefix(redisClient, "dns:*");
        dnsmetaKeys = await countKeysByPrefix(redisClient, "dnsmeta:*");
      } catch (scanErr) {
        // Non-fatal: keyspace counts may be unavailable
      }
      const otherKeys = Math.max(0, (keyspace.keys || 0) - dnsKeys - dnsmetaKeys);

      res.json({
        hits,
        misses,
        totalRequests,
        hitRate,
        evictedKeys: toNumber(parsed.evicted_keys),
        usedMemory: toNumber(parsed.used_memory),
        usedMemoryHuman: parsed.used_memory_human || null,
        connectedClients: toNumber(parsed.connected_clients),
        keyspace: {
          ...keyspace,
          dnsKeys,
          dnsmetaKeys,
          otherKeys,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to fetch Redis info" });
    }
  });

  app.get("/api/queries/recent", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        sortBy: "ts",
        sortDir: "desc",
      });
      return;
    }
    const page = clampNumber(req.query.page, 1, 1, 100000);
    const pageSize = clampNumber(req.query.page_size, 50, 1, 500);
    const offset = (page - 1) * pageSize;
    const sortBy = normalizeSortBy(req.query.sort_by);
    const sortDir = normalizeSortDir(req.query.sort_dir);
    const filters = buildQueryFilters(req);

    const whereClause = filters.clauses.length
      ? `WHERE ${filters.clauses.join(" AND ")}`
      : "";

    const baseQuery = `
      FROM ${clickhouseDatabase}.${clickhouseTable}
      ${whereClause}
    `;
    const query = `
      SELECT ts, client_ip, client_name, protocol, qname, qtype, qclass, outcome, rcode, duration_ms
      ${baseQuery}
      ORDER BY ${sortBy} ${sortDir}
      LIMIT {limit: UInt32}
      OFFSET {offset: UInt32}
    `;
    const countQuery = `
      SELECT count() as total
      ${baseQuery}
    `;
    try {
      const [result, countResult] = await Promise.all([
        clickhouseClient.query({
          query,
          query_params: { ...filters.params, limit: pageSize, offset },
        }),
        clickhouseClient.query({
          query: countQuery,
          query_params: filters.params,
        }),
      ]);
      const rows = await result.json();
      const countRows = await countResult.json();
      const total =
        countRows.data && countRows.data.length > 0
          ? Number(countRows.data[0].total)
          : 0;
      res.json({
        enabled: true,
        rows: rows.data || [],
        total,
        page,
        pageSize,
        sortBy,
        sortDir,
      });
    } catch (err) {
      res.json({
        enabled: false,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        sortBy: "ts",
        sortDir: "desc",
      });
    }
  });

  app.get("/api/queries/export", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.status(400).json({ error: "ClickHouse is not enabled" });
      return;
    }
    const limit = clampNumber(req.query.limit, 5000, 1, 50000);
    const sortBy = normalizeSortBy(req.query.sort_by);
    const sortDir = normalizeSortDir(req.query.sort_dir);
    const filters = buildQueryFilters(req);
    const whereClause = filters.clauses.length
      ? `WHERE ${filters.clauses.join(" AND ")}`
      : "";
    const query = `
      SELECT ts, client_ip, client_name, protocol, qname, qtype, qclass, outcome, rcode, duration_ms
      FROM ${clickhouseDatabase}.${clickhouseTable}
      ${whereClause}
      ORDER BY ${sortBy} ${sortDir}
      LIMIT {limit: UInt32}
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { ...filters.params, limit },
        format: "CSVWithNames",
      });
      const body = await result.text();
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=\"dns-queries.csv\""
      );
      res.send(body);
    } catch (err) {
      res.status(500).json({ error: err.message || "Export failed" });
    }
  });

  app.get("/api/config", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const merged = await readMergedConfig(defaultConfigPath, configPath);
      res.json(redactConfig(merged));
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.get("/api/system/config", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const merged = await readMergedConfig(defaultConfigPath, configPath);
      const server = merged.server || {};
      const cache = merged.cache || {};
      const queryStore = merged.query_store || {};
      const clientId = merged.client_identification || {};
      const control = merged.control || {};
      const ui = merged.ui || {};
      const clients = clientId.clients || {};
      const clientsList = Object.entries(clients).map(([ip, name]) => ({ ip, name }));
      res.json({
        server: {
          listen: Array.isArray(server.listen) ? server.listen.join(", ") : (server.listen || "0.0.0.0:53"),
          read_timeout: server.read_timeout || "5s",
          write_timeout: server.write_timeout || "5s",
        },
        cache: {
          redis_address: cache.redis?.address || "redis:6379",
          min_ttl: cache.min_ttl || "300s",
          max_ttl: cache.max_ttl || "1h",
        },
        query_store: {
          enabled: queryStore.enabled !== false,
          address: queryStore.address || "http://clickhouse:8123",
          database: queryStore.database || "beyond_ads",
          table: queryStore.table || "dns_queries",
          flush_to_store_interval: queryStore.flush_to_store_interval || queryStore.flush_interval || "5s",
          flush_to_disk_interval: queryStore.flush_to_disk_interval || queryStore.flush_interval || "5s",
          retention_days: queryStore.retention_days ?? 7,
        },
        client_identification: {
          enabled: clientId.enabled === true,
          clients: clientsList,
        },
        control: {
          enabled: control.enabled !== false,
          listen: control.listen || "0.0.0.0:8081",
        },
        ui: {
          hostname: ui.hostname || "",
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read system config" });
    }
  });

  app.put("/api/system/config", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const body = req.body || {};
      const overrideConfig = await readOverrideConfig(configPath);

      if (body.server) {
        const listen = body.server.listen;
        overrideConfig.server = {
          ...(overrideConfig.server || {}),
          listen: typeof listen === "string"
            ? listen.split(",").map((s) => s.trim()).filter(Boolean)
            : Array.isArray(listen) ? listen : ["0.0.0.0:53"],
          read_timeout: body.server.read_timeout || "5s",
          write_timeout: body.server.write_timeout || "5s",
        };
      }
      if (body.cache) {
        overrideConfig.cache = {
          ...(overrideConfig.cache || {}),
          redis: {
            ...(overrideConfig.cache?.redis || {}),
            address: body.cache.redis_address || "redis:6379",
          },
          min_ttl: body.cache.min_ttl || "300s",
          max_ttl: body.cache.max_ttl || "1h",
        };
      }
      if (body.query_store) {
        const qs = {
          ...(overrideConfig.query_store || {}),
          enabled: body.query_store.enabled !== false,
          address: body.query_store.address || "http://clickhouse:8123",
          database: body.query_store.database || "beyond_ads",
          table: body.query_store.table || "dns_queries",
          flush_to_store_interval: body.query_store.flush_to_store_interval || "5s",
          flush_to_disk_interval: body.query_store.flush_to_disk_interval || "5s",
          retention_days: body.query_store.retention_days ?? 7,
        };
        delete qs.flush_interval;
        overrideConfig.query_store = qs;
      }
      if (body.client_identification) {
        const clientsList = body.client_identification.clients || [];
        const clients = {};
        for (const entry of clientsList) {
          const ip = String(entry?.ip || "").trim();
          const name = String(entry?.name || "").trim();
          if (ip && name) {
            clients[ip] = name;
          }
        }
        overrideConfig.client_identification = {
          enabled: body.client_identification.enabled === true,
          clients,
        };
      }
      if (body.control) {
        overrideConfig.control = {
          ...(overrideConfig.control || {}),
          enabled: body.control.enabled !== false,
          listen: body.control.listen || "0.0.0.0:8081",
        };
      }
      if (body.ui) {
        overrideConfig.ui = {
          ...(overrideConfig.ui || {}),
          hostname: String(body.ui.hostname ?? "").trim(),
        };
      }

      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, message: "Saved. Restart the service to apply changes." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update system config" });
    }
  });

  app.get("/api/config/export", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const defaultConfig = await readYamlFile(defaultConfigPath);
      const overrideConfig = await readYamlFile(configPath);
      
      // Get only the values that differ from defaults
      const differences = getConfigDifferences(defaultConfig, overrideConfig);
      
      // Remove password fields
      removePasswordFields(differences);
      
      // Convert to YAML
      const yamlContent = YAML.stringify(differences);
      
      res.setHeader("Content-Type", "application/x-yaml");
      res.setHeader("Content-Disposition", "attachment; filename=\"config-export.yaml\"");
      res.send(yamlContent);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to export config" });
    }
  });

  app.post("/api/config/import", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const importedConfig = req.body;
      
      if (!importedConfig || typeof importedConfig !== "object" || Array.isArray(importedConfig)) {
        res.status(400).json({ error: "Invalid config format" });
        return;
      }
      
      // Read existing override config
      const existingOverride = await readOverrideConfig(configPath);
      
      // Merge imported config with existing overrides
      const merged = mergeDeep(existingOverride, importedConfig);
      
      // Write the merged config
      await writeConfig(configPath, merged);
      
      res.json({ ok: true, message: "Config imported successfully" });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to import config" });
    }
  });

  app.get("/api/sync/status", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const merged = await readMergedConfig(defaultConfigPath, configPath);
      const sync = merged.sync || {};
      const role = sync.role || "primary";
      const enabled = Boolean(sync.enabled);
      const tokens = (sync.tokens || []).map((t, i) => ({
        index: i,
        id: t.id ? `${t.id.slice(0, 8)}...` : "",
        name: t.name || "",
        created_at: t.created_at || "",
        last_used: t.last_used || "",
      }));
      res.json({
        role,
        enabled,
        tokens: role === "primary" ? tokens : [],
        primary_url: role === "replica" ? sync.primary_url || "" : undefined,
        sync_interval: role === "replica" ? sync.sync_interval || "60s" : undefined,
        stats_source_url: role === "replica" ? sync.stats_source_url || "" : undefined,
        last_pulled_at: role === "replica" ? sync.last_pulled_at || "" : undefined,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read sync status" });
    }
  });

  app.post("/api/sync/tokens", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      const sync = overrideConfig.sync || {};
      if (sync.role === "replica") {
        res.status(400).json({ error: "Cannot manage tokens on a replica" });
        return;
      }
      const tokens = sync.tokens || [];
      const name = String(req.body?.name || "Replica").trim();
      const id = crypto.randomBytes(24).toString("hex");
      const now = new Date().toISOString();
      tokens.push({ id, name, created_at: now, last_used: "" });
      overrideConfig.sync = { ...sync, enabled: true, role: "primary", tokens };
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, token: id, name, message: "Copy the token now; it will not be shown again." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to create token" });
    }
  });

  app.delete("/api/sync/tokens/:index", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const index = parseInt(req.params.index, 10);
      const overrideConfig = await readOverrideConfig(configPath);
      const sync = overrideConfig.sync || {};
      if (sync.role === "replica") {
        res.status(400).json({ error: "Cannot manage tokens on a replica" });
        return;
      }
      const tokens = sync.tokens || [];
      if (index < 0 || index >= tokens.length) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      tokens.splice(index, 1);
      overrideConfig.sync = { ...sync, tokens };
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to revoke token" });
    }
  });

  app.put("/api/sync/settings", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      const sync = overrideConfig.sync || {};
      if (sync.role !== "replica") {
        res.status(400).json({ error: "Sync settings only apply to replicas" });
        return;
      }
      const { primary_url, sync_token, sync_interval, stats_source_url } = req.body || {};
      if (primary_url !== undefined) sync.primary_url = String(primary_url).trim();
      if (sync_token !== undefined) sync.sync_token = String(sync_token).trim();
      if (sync_interval !== undefined) sync.sync_interval = String(sync_interval).trim();
      if (stats_source_url !== undefined) sync.stats_source_url = String(stats_source_url).trim();
      overrideConfig.sync = sync;
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, message: "Restart the application to apply sync settings." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update sync settings" });
    }
  });

  app.put("/api/sync/config", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      const sync = overrideConfig.sync || {};
      const { enabled, role, primary_url, sync_token, sync_interval, stats_source_url } = req.body || {};
      if (enabled !== undefined) {
        sync.enabled = Boolean(enabled);
      }
      if (role !== undefined) {
        const r = String(role).toLowerCase().trim();
        if (r !== "primary" && r !== "replica") {
          res.status(400).json({ error: "role must be 'primary' or 'replica'" });
          return;
        }
        sync.role = r;
      }
      if (sync.enabled && sync.role === "primary" && !Array.isArray(sync.tokens)) {
        sync.tokens = [];
      }
      if (sync.enabled && sync.role === "replica") {
        if (primary_url !== undefined) sync.primary_url = String(primary_url).trim();
        else sync.primary_url = sync.primary_url || "";
        if (sync_token !== undefined) sync.sync_token = String(sync_token).trim();
        else sync.sync_token = sync.sync_token || "";
        if (sync_interval !== undefined) sync.sync_interval = String(sync_interval).trim();
        else sync.sync_interval = sync.sync_interval || "60s";
        if (stats_source_url !== undefined) sync.stats_source_url = String(stats_source_url).trim();
      }
      if (!sync.enabled) {
        sync.role = sync.role || "primary";
      }
      overrideConfig.sync = sync;
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, message: "Sync configuration saved. Restart the application to apply." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update sync config" });
    }
  });

  app.post("/api/restart", async (req, res) => {
    if (dnsControlToken) {
      const auth = req.headers.authorization || "";
      const headerToken = req.headers["x-auth-token"] || "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (bearer !== dnsControlToken && headerToken !== dnsControlToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    res.json({ ok: true, message: "Restarting..." });
    res.on("finish", () => {
      setTimeout(() => process.exit(0), 100);
    });
  });

  app.get("/api/queries/summary", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, windowMinutes: null, total: 0, statuses: [] });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT outcome, count() as count
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
      GROUP BY outcome
      ORDER BY count DESC
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const statuses = (rows.data || []).map((row) => ({
        outcome: row.outcome,
        count: toNumber(row.count),
      }));
      const total = statuses.reduce((sum, row) => sum + row.count, 0);
      res.json({ enabled: true, windowMinutes, total, statuses });
    } catch (err) {
      res.json({ enabled: false, windowMinutes: null, total: 0, statuses: [] });
    }
  });

  app.get("/api/queries/latency", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        windowMinutes: null,
        count: 0,
        avgMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
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
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const stats = rows.data && rows.data.length > 0 ? rows.data[0] : {};
      const count = toNumber(stats.count);
      res.json({
        enabled: true,
        windowMinutes,
        count,
        avgMs: count ? toNumber(stats.avg) : null,
        minMs: count ? toNumber(stats.min) : null,
        maxMs: count ? toNumber(stats.max) : null,
        p50Ms: count ? toNumber(stats.p50) : null,
        p95Ms: count ? toNumber(stats.p95) : null,
        p99Ms: count ? toNumber(stats.p99) : null,
      });
    } catch (err) {
      res.json({
        enabled: false,
        windowMinutes: null,
        count: 0,
        avgMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      });
    }
  });

  app.get("/api/queries/time-series", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({
        enabled: false,
        windowMinutes: null,
        bucketMinutes: null,
        buckets: [],
        latencyBuckets: [],
      });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const bucketMinutes = clampNumber(req.query.bucket_minutes, 5, 1, Math.min(60, windowMinutes));
    const bucketExpr = `toStartOfInterval(ts, INTERVAL {bucket: UInt32} MINUTE)`;
    const whereClause = `WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE`;
    try {
      const [countResult, latencyResult] = await Promise.all([
        clickhouseClient.query({
          query: `
            SELECT
              ${bucketExpr} as bucket,
              count() as total,
              countIf(outcome = 'cached') as cached,
              countIf(outcome = 'local') as local,
              countIf(outcome = 'upstream') as upstream,
              countIf(outcome = 'blocked') as blocked,
              countIf(outcome = 'upstream_error') as upstream_error,
              countIf(outcome = 'invalid') as invalid
            FROM ${clickhouseDatabase}.${clickhouseTable}
            ${whereClause}
            GROUP BY bucket
            ORDER BY bucket
          `,
          query_params: { window: windowMinutes, bucket: bucketMinutes },
        }),
        clickhouseClient.query({
          query: `
            SELECT
              ${bucketExpr} as bucket,
              count() as count,
              avg(duration_ms) as avg_ms,
              quantile(0.5)(duration_ms) as p50_ms,
              quantile(0.95)(duration_ms) as p95_ms,
              quantile(0.99)(duration_ms) as p99_ms
            FROM ${clickhouseDatabase}.${clickhouseTable}
            ${whereClause}
            GROUP BY bucket
            ORDER BY bucket
          `,
          query_params: { window: windowMinutes, bucket: bucketMinutes },
        }),
      ]);
      const countRows = (await countResult.json()).data || [];
      const latencyRows = (await latencyResult.json()).data || [];
      const buckets = countRows.map((row) => ({
        ts: row.bucket,
        total: toNumber(row.total),
        cached: toNumber(row.cached),
        local: toNumber(row.local),
        upstream: toNumber(row.upstream),
        blocked: toNumber(row.blocked),
        upstream_error: toNumber(row.upstream_error),
        invalid: toNumber(row.invalid),
      }));
      const latencyBuckets = latencyRows.map((row) => ({
        ts: row.bucket,
        count: toNumber(row.count),
        avgMs: toNumber(row.avg_ms),
        p50Ms: toNumber(row.p50_ms),
        p95Ms: toNumber(row.p95_ms),
        p99Ms: toNumber(row.p99_ms),
      }));
      res.json({
        enabled: true,
        windowMinutes,
        bucketMinutes,
        buckets,
        latencyBuckets,
      });
    } catch (err) {
      res.json({
        enabled: false,
        windowMinutes: null,
        bucketMinutes: null,
        buckets: [],
        latencyBuckets: [],
      });
    }
  });

  app.get("/api/queries/upstream-stats", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, windowMinutes: null, total: 0, upstreams: [] });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 60, 1, 1440);
    const query = `
      SELECT upstream_address as address, count() as count
      FROM ${clickhouseDatabase}.${clickhouseTable}
      WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE
        AND outcome IN ('upstream', 'servfail')
        AND upstream_address != ''
      GROUP BY upstream_address
      ORDER BY count DESC
    `;
    try {
      const result = await clickhouseClient.query({
        query,
        query_params: { window: windowMinutes },
      });
      const rows = await result.json();
      const upstreams = (rows.data || []).map((row) => ({
        address: row.address || "-",
        count: toNumber(row.count),
      }));
      const total = upstreams.reduce((sum, row) => sum + row.count, 0);
      res.json({ enabled: true, windowMinutes, total, upstreams });
    } catch (err) {
      res.json({ enabled: false, windowMinutes: null, total: 0, upstreams: [] });
    }
  });

  app.get("/api/queries/filter-options", async (req, res) => {
    if (!clickhouseEnabled || !clickhouseClient) {
      res.json({ enabled: false, options: {} });
      return;
    }
    const windowMinutes = clampNumber(req.query.window_minutes, 1440, 1, 10080);
    const limit = 10; // Top 10 values for each field
    
    try {
      const queries = [
        { field: "outcome", query: `SELECT outcome as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY outcome ORDER BY count DESC LIMIT ${limit}` },
        { field: "rcode", query: `SELECT rcode as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY rcode ORDER BY count DESC LIMIT ${limit}` },
        { field: "qtype", query: `SELECT qtype as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY qtype ORDER BY count DESC LIMIT ${limit}` },
        { field: "protocol", query: `SELECT protocol as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY protocol ORDER BY count DESC LIMIT ${limit}` },
        { field: "client_ip", query: `SELECT coalesce(nullif(client_name, ''), client_ip) as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY value ORDER BY count DESC LIMIT ${limit}` },
        { field: "qname", query: `SELECT qname as value, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY qname ORDER BY count DESC LIMIT ${limit}` },
      ];
      
      const results = await Promise.all(
        queries.map(async ({ field, query }) => {
          const result = await clickhouseClient.query({
            query,
            query_params: { window: windowMinutes },
          });
          const rows = await result.json();
          return {
            field,
            values: (rows.data || []).map(row => ({
              value: row.value,
              count: toNumber(row.count),
            })),
          };
        })
      );
      
      const options = {};
      for (const { field, values } of results) {
        options[field] = values;
      }
      
      res.json({ enabled: true, options });
    } catch (err) {
      res.json({ enabled: false, options: {} });
    }
  });

  app.get("/api/dns/local-records", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const records = config.local_records || [];
      res.json({ records });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.put("/api/dns/local-records", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const merged = await readMergedConfig(defaultConfigPath, configPath).catch(() => ({}));
    if (merged?.sync?.enabled && merged?.sync?.role === "replica") {
      res.status(403).json({ error: "Replicas cannot modify local records; config is synced from primary" });
      return;
    }
    const recordsInput = Array.isArray(req.body?.records) ? req.body.records : [];
    const records = normalizeLocalRecords(recordsInput);

    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.local_records = records;
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, records });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update local records" });
    }
  });

  app.post("/api/dns/local-records/apply", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/local-records/reload`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Reload failed: ${response.status}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to reload local records" });
    }
  });

  app.get("/api/dns/upstreams", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const upstreams = config.upstreams || [];
      const resolverStrategy = config.resolver_strategy || "failover";
      res.json({ upstreams, resolver_strategy: resolverStrategy });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.put("/api/dns/upstreams", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const merged = await readMergedConfig(defaultConfigPath, configPath).catch(() => ({}));
    if (merged?.sync?.enabled && merged?.sync?.role === "replica") {
      res.status(403).json({ error: "Replicas cannot modify upstreams; config is synced from primary" });
      return;
    }
    const upstreamsInput = Array.isArray(req.body?.upstreams) ? req.body.upstreams : [];
    const resolverStrategy = String(req.body?.resolver_strategy || "failover").trim().toLowerCase();
    const validStrategies = ["failover", "load_balance", "weighted"];
    if (!validStrategies.includes(resolverStrategy)) {
      res.status(400).json({ error: "resolver_strategy must be failover, load_balance, or weighted" });
      return;
    }
    const upstreams = upstreamsInput
      .filter((u) => u && (u.name || u.address))
      .map((u) => ({
        name: String(u.name || "").trim() || "upstream",
        address: String(u.address || "").trim(),
        protocol: String(u.protocol || "udp").trim().toLowerCase() || "udp",
      }))
      .filter((u) => u.address);
    if (upstreams.length === 0) {
      res.status(400).json({ error: "At least one upstream with address is required" });
      return;
    }
    for (const u of upstreams) {
      const addr = u.address;
      if (addr.startsWith("tls://")) {
        const hostPort = addr.slice(6);
        const hasPort = /:\d{1,5}$/.test(hostPort);
        if (!hasPort) {
          res.status(400).json({ error: `Invalid DoT address: ${addr} (expected tls://host:port)` });
          return;
        }
      } else if (addr.startsWith("https://")) {
        try {
          const parsed = new URL(addr);
          if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
            res.status(400).json({ error: `Invalid DoH address: ${addr} (expected https://host/path)` });
            return;
          }
        } catch {
          res.status(400).json({ error: `Invalid DoH address: ${addr} (expected valid HTTPS URL)` });
          return;
        }
      } else {
        const parts = addr.split(":");
        if (parts.length < 2 || !parts[parts.length - 1]?.match(/^\d+$/)) {
          res.status(400).json({ error: `Invalid upstream address: ${addr} (expected host:port, tls://host:port, or https://host/path)` });
          return;
        }
      }
      const validProtocols = ["udp", "tcp", "tls", "https"];
      if (u.protocol && !validProtocols.includes(u.protocol)) {
        res.status(400).json({ error: `Invalid protocol for ${addr}: ${u.protocol}` });
        return;
      }
    }
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.upstreams = upstreams;
      overrideConfig.resolver_strategy = resolverStrategy;
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, upstreams, resolver_strategy: resolverStrategy });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update upstreams" });
    }
  });

  app.post("/api/dns/upstreams/apply", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/upstreams/reload`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Reload failed: ${response.status}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to reload upstreams" });
    }
  });

  app.get("/api/dns/response", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const response = config.response || {};
      res.json({
        blocked: response.blocked || "nxdomain",
        blocked_ttl: response.blocked_ttl || "1h",
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read response config" });
    }
  });

  app.put("/api/dns/response", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const merged = await readMergedConfig(defaultConfigPath, configPath).catch(() => ({}));
    if (merged?.sync?.enabled && merged?.sync?.role === "replica") {
      res.status(403).json({ error: "Replicas cannot modify response config; config is synced from primary" });
      return;
    }
    const blocked = String(req.body?.blocked ?? "nxdomain").trim().toLowerCase();
    const blockedTtl = String(req.body?.blocked_ttl ?? "1h").trim();
    if (blocked !== "nxdomain") {
      if (net.isIP(blocked) === 0) {
        res.status(400).json({ error: "blocked must be nxdomain or a valid IPv4/IPv6 address" });
        return;
      }
    }
    const durationPattern = /^(?:(?:\d+(?:\.\d+)?)(?:ns|us|µs|μs|ms|s|m|h))+$/i;
    if (!durationPattern.test(blockedTtl) || !/[1-9]/.test(blockedTtl)) {
      res.status(400).json({ error: "blocked_ttl must be a positive duration (e.g. 30s, 1h)" });
      return;
    }
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.response = {
        ...(overrideConfig.response || {}),
        blocked: blocked === "nxdomain" ? "nxdomain" : blocked,
        blocked_ttl: blockedTtl,
      };
      await writeConfig(configPath, overrideConfig);
      res.json({
        ok: true,
        blocked: overrideConfig.response.blocked,
        blocked_ttl: overrideConfig.response.blocked_ttl,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update response config" });
    }
  });

  app.post("/api/dns/response/apply", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/response/reload`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Reload failed: ${response.status}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to apply response config" });
    }
  });

  app.get("/api/dns/safe-search", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const ss = config.safe_search || {};
      res.json({
        enabled: ss.enabled ?? false,
        google: ss.google ?? true,
        bing: ss.bing ?? true,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read safe search config" });
    }
  });

  app.put("/api/dns/safe-search", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const merged = await readMergedConfig(defaultConfigPath, configPath).catch(() => ({}));
    if (merged?.sync?.enabled && merged?.sync?.role === "replica") {
      res.status(403).json({ error: "Replicas cannot modify safe search; config is synced from primary" });
      return;
    }
    const enabled = Boolean(req.body?.enabled);
    const google = req.body?.google !== false;
    const bing = req.body?.bing !== false;
    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.safe_search = {
        enabled,
        google,
        bing,
      };
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, safe_search: overrideConfig.safe_search });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update safe search config" });
    }
  });

  app.post("/api/dns/safe-search/apply", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/safe-search/reload`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Reload failed: ${response.status}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to reload response config" });
    }
  });

  app.get("/api/blocklists", async (_req, res) => {
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const blocklists = config.blocklists || {};
      res.json({
        refreshInterval: blocklists.refresh_interval || "6h",
        sources: blocklists.sources || [],
        allowlist: blocklists.allowlist || [],
        denylist: blocklists.denylist || [],
        scheduled_pause: blocklists.scheduled_pause || null,
        health_check: blocklists.health_check || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.put("/api/blocklists", async (req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "CONFIG_PATH is not set" });
      return;
    }
    const merged = await readMergedConfig(defaultConfigPath, configPath).catch(() => ({}));
    if (merged?.sync?.enabled && merged?.sync?.role === "replica") {
      res.status(403).json({ error: "Replicas cannot modify blocklists; config is synced from primary" });
      return;
    }
    const refreshInterval = String(req.body?.refreshInterval || "6h").trim();
    const sourcesInput = Array.isArray(req.body?.sources) ? req.body.sources : [];
    const allowlistInput = Array.isArray(req.body?.allowlist)
      ? req.body.allowlist
      : [];
    const denylistInput = Array.isArray(req.body?.denylist) ? req.body.denylist : [];

    const sources = normalizeSources(sourcesInput);
    const allowlist = normalizeDomains(allowlistInput);
    const denylist = normalizeDomains(denylistInput);

    if (sources.length === 0) {
      res.status(400).json({ error: "At least one blocklist source is required" });
      return;
    }

    const scheduledPauseInput = req.body?.scheduled_pause;
    const healthCheckInput = req.body?.health_check;

    if (scheduledPauseInput != null) {
      const err = validateScheduledPause(scheduledPauseInput);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }

    if (healthCheckInput != null) {
      const err = validateHealthCheck(healthCheckInput);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }

    try {
      const overrideConfig = await readOverrideConfig(configPath);
      overrideConfig.blocklists = {
        ...(overrideConfig.blocklists || {}),
        refresh_interval: refreshInterval,
        sources,
        allowlist,
        denylist,
      };
      if (scheduledPauseInput !== undefined) {
        overrideConfig.blocklists.scheduled_pause = normalizeScheduledPause(scheduledPauseInput);
      }
      if (healthCheckInput !== undefined) {
        overrideConfig.blocklists.health_check = normalizeHealthCheck(healthCheckInput);
      }
      await writeConfig(configPath, overrideConfig);
      res.json({ ok: true, blocklists: overrideConfig.blocklists });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update config" });
    }
  });

  app.post("/api/blocklists/apply", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/reload`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Reload failed: ${response.status}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to reload blocklists" });
    }
  });

  app.get("/api/blocklists/stats", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/stats`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Stats failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load stats" });
    }
  });

  app.get("/api/cache/refresh/stats", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/cache/refresh/stats`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res
          .status(502)
          .json({ error: body || `Stats failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load stats" });
    }
  });

  app.post("/api/blocklists/pause", async (req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = { "Content-Type": "application/json" };
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/pause`, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body),
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Pause failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to pause blocking" });
    }
  });

  app.post("/api/blocklists/resume", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/resume`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Resume failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to resume blocking" });
    }
  });

  app.get("/api/blocklists/pause/status", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/pause/status`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Status check failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to get pause status" });
    }
  });

  app.get("/api/blocklists/health", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/blocklists/health`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Health check failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to get blocklist health" });
    }
  });

  app.get("/api/cache/stats", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/cache/stats`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Cache stats failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load cache stats" });
    }
  });

  app.get("/api/errors", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const response = await fetch(`${dnsControlUrl}/errors`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        res.status(502).json({ error: body || `Errors fetch failed: ${response.status}` });
        return;
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load errors" });
    }
  });

  app.get("/api/instances/stats", async (_req, res) => {
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) {
        headers.Authorization = `Bearer ${dnsControlToken}`;
      }
      const fetches = [
        fetch(`${dnsControlUrl}/blocklists/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/cache/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/cache/refresh/stats`, { method: "GET", headers }),
        fetch(`${dnsControlUrl}/sync/replica-stats`, { method: "GET", headers }),
      ];
      let primaryResponseDistribution = null;
      let primaryResponseTime = null;
      if (clickhouseEnabled && clickhouseClient) {
        const windowMinutes = 60;
        try {
          const [summaryRes, latencyRes] = await Promise.all([
            clickhouseClient.query({
              query: `SELECT outcome, count() as count FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE GROUP BY outcome ORDER BY count DESC`,
              query_params: { window: windowMinutes },
            }),
            clickhouseClient.query({
              query: `SELECT count() as count, avg(duration_ms) as avg, quantile(0.5)(duration_ms) as p50, quantile(0.95)(duration_ms) as p95, quantile(0.99)(duration_ms) as p99 FROM ${clickhouseDatabase}.${clickhouseTable} WHERE ts >= now() - INTERVAL {window: UInt32} MINUTE`,
              query_params: { window: windowMinutes },
            }),
          ]);
          const summaryRows = (await summaryRes.json()).data || [];
          const latencyRows = (await latencyRes.json()).data || [];
          const summaryStats = summaryRows.reduce((acc, row) => {
            acc[row.outcome] = toNumber(row.count);
            return acc;
          }, {});
          primaryResponseDistribution = { ...summaryStats, total: summaryRows.reduce((s, r) => s + toNumber(r.count), 0) };
          const lat = latencyRows[0];
          const count = toNumber(lat?.count);
          if (count > 0) {
            primaryResponseTime = {
              count,
              avg_ms: toNumber(lat.avg),
              p50_ms: toNumber(lat.p50),
              p95_ms: toNumber(lat.p95),
              p99_ms: toNumber(lat.p99),
            };
          }
        } catch {
          // ClickHouse query failed; leave response_distribution and response_time null
        }
      }
      const [primaryBlocklistRes, primaryCacheRes, primaryRefreshRes, replicaStatsRes] = await Promise.all(fetches);
      let primary = null;
      if (primaryBlocklistRes.ok && primaryCacheRes.ok && primaryRefreshRes.ok) {
        const [blocklist, cache, refresh] = await Promise.all([
          primaryBlocklistRes.json(),
          primaryCacheRes.json(),
          primaryRefreshRes.json(),
        ]);
        primary = { blocklist, cache, refresh };
        if (primaryResponseDistribution) primary.response_distribution = primaryResponseDistribution;
        if (primaryResponseTime) primary.response_time = primaryResponseTime;
      }
      let replicas = [];
      if (replicaStatsRes.ok) {
        const data = await replicaStatsRes.json();
        replicas = data.replicas || [];
      }
      res.json({ primary, replicas });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to load instance stats" });
    }
  });

  // Block page: when Host is a blocked domain, serve HTML block page
  app.use(async (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/.well-known/")) {
      return next();
    }
    const host = (req.get("host") || "").split(":")[0].toLowerCase().trim();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return next();
    }
    if (!dnsControlUrl) return next();
    try {
      const controlUrl = new URL("/blocked/check", dnsControlUrl);
      controlUrl.searchParams.set("domain", host);
      const response = await fetch(controlUrl.toString());
      const data = await response.json();
      if (data.blocked) {
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

  const { app, redisClient } = createApp(options);
  await redisClient.connect();

  let httpServer = null;
  let httpsServer = null;

  // Let's Encrypt: obtain or load certificate, then start both HTTP and HTTPS
  if (letsEncryptEnabled) {
    const leConfig = getLetsEncryptConfig();
    const primaryDomain = leConfig.domains[0];
    const useDnsChallenge = isLetsEncryptDnsChallenge();

    const certValid = await hasValidCert(leConfig.certDir, primaryDomain);
    let certData = certValid ? await loadCertForHttps(leConfig.certDir, primaryDomain) : null;

    // For DNS challenge, obtain cert before starting HTTP (no port 80 needed for challenge)
    // For HTTP challenge, we need HTTP server running first
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
        // HTTP challenge: start HTTP first so ACME can reach /.well-known/acme-challenge/
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

    // Start HTTP if not already (for redirect to HTTPS)
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

  // Manual HTTPS with certificate files
  if (httpsEnabled && sslCertFile && sslKeyFile) {
    const cert = fs.readFileSync(sslCertFile);
    const key = fs.readFileSync(sslKeyFile);
    httpsServer = https.createServer({ cert, key }, app);
    httpsServer.listen(httpsPort, () => {
      console.log(`Metrics API (HTTPS) listening on :${httpsPort}`);
    });
    return { app, server: httpsServer, redisClient };
  }

  // HTTP only
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

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["true", "1", "yes", "y"].includes(String(value).toLowerCase());
}

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function countKeysByPrefix(client, pattern) {
  const keys = await client.keys(pattern);
  return Array.isArray(keys) ? keys.length : 0;
}

function parseRedisInfo(info) {
  const lines = info.split("\n");
  const data = {};
  for (const line of lines) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) {
      continue;
    }
    data[key] = rest.join(":").trim();
  }
  return data;
}

function parseKeyspace(value) {
  if (!value) {
    return { keys: 0, expires: 0, avgTtlMs: 0 };
  }
  const parts = value.split(",");
  const parsed = {};
  for (const part of parts) {
    const [key, val] = part.split("=");
    parsed[key] = toNumber(val);
  }
  return {
    keys: parsed.keys || 0,
    expires: parsed.expires || 0,
    avgTtlMs: parsed.avg_ttl || 0,
  };
}

async function readYamlFile(path) {
  if (!path) {
    return {};
  }
  try {
    const data = await fsPromises.readFile(path, "utf8");
    const parsed = YAML.parse(data);
    return parsed || {};
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function readMergedConfig(defaultPath, overridePath) {
  const base = await readYamlFile(defaultPath);
  const override = await readYamlFile(overridePath);
  return mergeDeep(base, override);
}

async function readOverrideConfig(overridePath) {
  return readYamlFile(overridePath);
}

async function writeConfig(configPath, config) {
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const content = YAML.stringify(config);
  await fsPromises.writeFile(configPath, content, "utf8");
}

function mergeDeep(base, override) {
  if (Array.isArray(override)) {
    return override;
  }
  if (!isObject(base) || !isObject(override)) {
    return override ?? base;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = mergeDeep(base[key], value);
  }
  return merged;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function redactConfig(config) {
  const copy = structuredClone(config);
  if (copy?.cache?.redis?.password !== undefined) {
    copy.cache.redis.password = "***";
  }
  if (copy?.query_store?.password !== undefined) {
    copy.query_store.password = "***";
  }
  if (copy?.control?.token !== undefined) {
    copy.control.token = "***";
  }
  return copy;
}

function normalizeSources(sources) {
  const result = [];
  const seen = new Set();
  for (const source of sources) {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const name = String(source?.name || "").trim() || url;
    result.push({ name, url });
  }
  return result;
}

function normalizeDomains(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const domain = String(value || "").trim().toLowerCase();
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(domain);
  }
  return result;
}

const HHMM_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function validateScheduledPause(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) return null;
  const start = String(input.start || "").trim();
  const end = String(input.end || "").trim();
  if (!HHMM_PATTERN.test(start)) {
    return "scheduled_pause.start must be HH:MM (e.g. 09:00)";
  }
  if (!HHMM_PATTERN.test(end)) {
    return "scheduled_pause.end must be HH:MM (e.g. 17:00)";
  }
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if (sh > eh || (sh === eh && sm >= em)) {
    return "scheduled_pause.start must be before end";
  }
  const days = Array.isArray(input.days) ? input.days : [];
  for (const d of days) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return "scheduled_pause.days must be 0-6 (0=Sun, 6=Sat)";
    }
  }
  return null;
}

function normalizeScheduledPause(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) {
    return { enabled: false, start: "09:00", end: "17:00", days: [] };
  }
  const start = String(input.start || "09:00").trim();
  const end = String(input.end || "17:00").trim();
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map((d) => Number(d)).filter((n) => n >= 0 && n <= 6))]
    : [];
  return { enabled: true, start, end, days };
}

function validateHealthCheck(input) {
  if (input === null || input === undefined) return null;
  if (typeof input.enabled !== "boolean" && input.enabled !== undefined) {
    return "health_check.enabled must be a boolean";
  }
  if (typeof input.fail_on_any !== "boolean" && input.fail_on_any !== undefined) {
    return "health_check.fail_on_any must be a boolean";
  }
  return null;
}

function normalizeHealthCheck(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  const failOnAny = input.fail_on_any !== false;
  return { enabled, fail_on_any: failOnAny };
}

function normalizeLocalRecords(records) {
  const result = [];
  const seen = new Set();
  for (const rec of records) {
    const name = String(rec?.name || "").trim().toLowerCase();
    const type = String(rec?.type || "A").trim().toUpperCase();
    const value = String(rec?.value || "").trim();
    if (!name || !value) {
      continue;
    }
    const key = `${name}:${type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ name, type, value });
  }
  return result;
}

function toNumber(value) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return 0;
  }
  return num;
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function normalizeSortBy(value) {
  const allowed = new Set([
    "ts",
    "duration_ms",
    "qname",
    "qtype",
    "qclass",
    "outcome",
    "rcode",
    "client_ip",
    "client_name",
    "protocol",
  ]);
  const raw = String(value || "ts").toLowerCase();
  return allowed.has(raw) ? raw : "ts";
}

function normalizeSortDir(value) {
  const raw = String(value || "desc").toLowerCase();
  return raw === "asc" ? "asc" : "desc";
}

function buildQueryFilters(req) {
  const clauses = [];
  const params = {};

  const qname = String(req.query.qname || "").trim();
  if (qname) {
    clauses.push("positionCaseInsensitive(qname, {qname: String}) > 0");
    params.qname = qname;
  }
  const outcome = String(req.query.outcome || "").trim();
  if (outcome) {
    const outcomes = outcome.split(",").map((s) => s.trim()).filter(Boolean);
    if (outcomes.length === 1) {
      clauses.push("outcome = {outcome: String}");
      params.outcome = outcomes[0];
    } else if (outcomes.length > 1) {
      const orClauses = outcomes.map((_, i) => `outcome = {outcome_${i}: String}`);
      clauses.push(`(${orClauses.join(" OR ")})`);
      outcomes.forEach((o, i) => {
        params[`outcome_${i}`] = o;
      });
    }
  }
  const rcode = String(req.query.rcode || "").trim();
  if (rcode) {
    clauses.push("rcode = {rcode: String}");
    params.rcode = rcode;
  }
  const qtype = String(req.query.qtype || "").trim();
  if (qtype) {
    clauses.push("qtype = {qtype: String}");
    params.qtype = qtype;
  }
  const qclass = String(req.query.qclass || "").trim();
  if (qclass) {
    clauses.push("qclass = {qclass: String}");
    params.qclass = qclass;
  }
  const protocol = String(req.query.protocol || "").trim();
  if (protocol) {
    clauses.push("protocol = {protocol: String}");
    params.protocol = protocol;
  }
  const client = String(req.query.client_ip || req.query.client || "").trim();
  if (client) {
    clauses.push("(client_ip = {client: String} OR client_name = {client: String})");
    params.client = client;
  }
  const sinceMinutes = clampNumber(req.query.since_minutes, 0, 0, 525600);
  if (sinceMinutes > 0) {
    clauses.push("ts >= now() - INTERVAL {since: UInt32} MINUTE");
    params.since = sinceMinutes;
  }

  const minDuration = clampNumber(req.query.min_duration_ms, 0, 0, 10_000_000);
  if (minDuration > 0) {
    clauses.push("duration_ms >= {min_duration: UInt32}");
    params.min_duration = minDuration;
  }
  const maxDuration = clampNumber(req.query.max_duration_ms, 0, 0, 10_000_000);
  if (maxDuration > 0) {
    clauses.push("duration_ms <= {max_duration: UInt32}");
    params.max_duration = maxDuration;
  }

  return { clauses, params };
}

function getConfigDifferences(defaultConfig, overrideConfig) {
  if (!isObject(defaultConfig) || !isObject(overrideConfig)) {
    return overrideConfig;
  }
  
  const differences = {};
  
  for (const [key, overrideValue] of Object.entries(overrideConfig)) {
    const defaultValue = defaultConfig[key];
    
    // If key doesn't exist in default, include it
    if (!(key in defaultConfig)) {
      differences[key] = overrideValue;
      continue;
    }
    
    // Handle arrays - if they differ, include the override
    if (Array.isArray(overrideValue)) {
      if (!arraysEqual(defaultValue, overrideValue)) {
        differences[key] = overrideValue;
      }
      continue;
    }
    
    // Handle nested objects recursively
    if (isObject(overrideValue) && isObject(defaultValue)) {
      const nestedDiff = getConfigDifferences(defaultValue, overrideValue);
      if (Object.keys(nestedDiff).length > 0) {
        differences[key] = nestedDiff;
      }
      continue;
    }
    
    // Handle primitive values - include if different
    if (overrideValue !== defaultValue) {
      differences[key] = overrideValue;
    }
  }
  
  return differences;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function removePasswordFields(config) {
  if (!isObject(config)) {
    return;
  }
  
  // Remove cache.redis.password
  if (config.cache?.redis?.password !== undefined) {
    delete config.cache.redis.password;
    // Clean up empty objects
    if (Object.keys(config.cache.redis).length === 0) {
      delete config.cache.redis;
    }
    if (Object.keys(config.cache).length === 0) {
      delete config.cache;
    }
  }
  
  // Remove query_store.password
  if (config.query_store?.password !== undefined) {
    delete config.query_store.password;
    if (Object.keys(config.query_store).length === 0) {
      delete config.query_store;
    }
  }
  
  // Remove control.token
  if (config.control?.token !== undefined) {
    delete config.control.token;
    if (Object.keys(config.control).length === 0) {
      delete config.control;
    }
  }
}
