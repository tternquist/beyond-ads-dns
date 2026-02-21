/**
 * Blocklist management routes.
 */
import {
  readMergedConfig,
  readOverrideConfig,
  writeConfig,
  normalizeSources,
  normalizeDomains,
  validateScheduledPause,
  normalizeScheduledPause,
  validateFamilyTime,
  normalizeFamilyTime,
  validateHealthCheck,
  normalizeHealthCheck,
} from "../utils/config.js";

function ctx(req) {
  return req.app.locals.ctx ?? {};
}

export function registerBlocklistsRoutes(app) {
  app.get("/api/blocklists", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
        family_time: blocklists.family_time || null,
        health_check: blocklists.health_check || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.put("/api/blocklists", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
    const familyTimeInput = req.body?.family_time;
    const healthCheckInput = req.body?.health_check;

    if (scheduledPauseInput != null) {
      const err = validateScheduledPause(scheduledPauseInput);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }

    if (familyTimeInput != null) {
      const err = validateFamilyTime(familyTimeInput);
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
      if (familyTimeInput !== undefined) {
        overrideConfig.blocklists.family_time = normalizeFamilyTime(familyTimeInput);
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

  app.post("/api/blocklists/apply", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
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

  app.get("/api/blocklists/stats", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
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

  app.post("/api/blocklists/pause", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
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

  app.post("/api/blocklists/resume", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
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

  app.get("/api/blocklists/pause/status", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
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

  app.get("/api/blocklists/health", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
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
}
