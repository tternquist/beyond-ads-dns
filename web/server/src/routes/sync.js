/**
 * Sync (primary/replica) configuration routes.
 */
import crypto from "node:crypto";
import {
  readMergedConfig,
  readOverrideConfig,
  writeConfig,
} from "../utils/config.js";

export function registerSyncRoutes(app, ctx) {
  const { defaultConfigPath, configPath } = ctx;

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
}
