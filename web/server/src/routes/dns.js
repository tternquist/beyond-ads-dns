/**
 * DNS configuration routes: local records, upstreams, response, safe search.
 */
import net from "node:net";
import {
  readMergedConfig,
  readOverrideConfig,
  writeConfig,
  normalizeLocalRecords,
} from "../utils/config.js";

function ctx(req) {
  return req.app.locals.ctx ?? {};
}

export function registerDnsRoutes(app) {
  app.get("/api/dns/local-records", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
    const { defaultConfigPath, configPath } = ctx(req);
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

  app.post("/api/dns/local-records/apply", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = ctx(req);
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) headers.Authorization = `Bearer ${dnsControlToken}`;
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

  app.get("/api/dns/upstreams", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const config = await readMergedConfig(defaultConfigPath, configPath);
      const upstreams = config.upstreams || [];
      const resolverStrategy = config.resolver_strategy || "failover";
      const upstreamTimeout = config.network?.upstream_timeout ?? config.upstream_timeout ?? "10s";
      const upstreamBackoff = config.network?.upstream_backoff ?? config.upstream_backoff ?? "30s";
      res.json({ upstreams, resolver_strategy: resolverStrategy, upstream_timeout: upstreamTimeout, upstream_backoff: upstreamBackoff });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read config" });
    }
  });

  app.put("/api/dns/upstreams", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
    const upstreamTimeout = String(req.body?.upstream_timeout || "10s").trim();
    const upstreamBackoff = String(req.body?.upstream_backoff || "30s").trim();
    const validStrategies = ["failover", "load_balance", "weighted"];
    if (!validStrategies.includes(resolverStrategy)) {
      res.status(400).json({ error: "resolver_strategy must be failover, load_balance, or weighted" });
      return;
    }
    const durationPattern = /^(?:(?:\d+(?:\.\d+)?)(?:ns|us|µs|μs|ms|s|m|h))+$/i;
    if (upstreamTimeout && (!durationPattern.test(upstreamTimeout) || !/[1-9]/.test(upstreamTimeout))) {
      res.status(400).json({ error: "upstream_timeout must be a positive duration (e.g. 2s, 10s, 30s)" });
      return;
    }
    if (upstreamBackoff && upstreamBackoff !== "0" && (!durationPattern.test(upstreamBackoff) || !/[1-9]/.test(upstreamBackoff))) {
      res.status(400).json({ error: "upstream_backoff must be a positive duration (e.g. 30s, 60s) or 0 to disable" });
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
      const timeoutVal = upstreamTimeout || "10s";
      const backoffVal = upstreamBackoff === "0" ? "0" : (upstreamBackoff || "30s");
      overrideConfig.network = overrideConfig.network || {};
      overrideConfig.network.upstream_timeout = timeoutVal;
      overrideConfig.network.upstream_backoff = backoffVal;
      overrideConfig.upstream_timeout = timeoutVal;
      overrideConfig.upstream_backoff = backoffVal;
      await writeConfig(configPath, overrideConfig);
      res.json({
        ok: true,
        upstreams,
        resolver_strategy: resolverStrategy,
        upstream_timeout: timeoutVal,
        upstream_backoff: backoffVal,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update upstreams" });
    }
  });

  app.post("/api/dns/upstreams/apply", async (req, res) => {
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

  app.get("/api/dns/response", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
    const { defaultConfigPath, configPath } = ctx(req);
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

  app.post("/api/dns/response/apply", async (req, res) => {
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

  app.get("/api/dns/safe-search", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
    const { defaultConfigPath, configPath } = ctx(req);
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

  app.post("/api/dns/safe-search/apply", async (req, res) => {
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

  app.post("/api/client-identification/apply", async (req, res) => {
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
      const response = await fetch(`${dnsControlUrl}/client-identification/reload`, {
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
      res.status(500).json({ error: err.message || "Failed to reload client identification" });
    }
  });
}
