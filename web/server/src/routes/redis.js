/**
 * Redis stats and cache management routes.
 */
import { toNumber } from "../utils/helpers.js";
import {
  parseRedisInfo,
  parseKeyspace,
  countKeysByPrefix,
} from "../services/redis.js";

export function registerRedisRoutes(app) {
  app.get("/api/redis/summary", async (req, res) => {
    const { redisClient } = req.app.locals.ctx ?? {};
    try {
      const info = await redisClient.info();
      const parsed = parseRedisInfo(info);
      const hits = toNumber(parsed.keyspace_hits);
      const misses = toNumber(parsed.keyspace_misses);
      const totalRequests = hits + misses;
      const hitRate = totalRequests > 0 ? hits / totalRequests : null;
      const keyspace = parseKeyspace(parsed.db0);

      let dnsKeys = 0;
      let dnsmetaKeys = 0;
      try {
        dnsKeys = await countKeysByPrefix(redisClient, "dns:*");
        const redisMode = req.app?.locals?.redisMode || process.env.REDIS_MODE || "standalone";
        const dnsmetaPattern =
          String(redisMode).toLowerCase() === "cluster" ? "{dnsmeta}:*" : "dnsmeta:*";
        dnsmetaKeys = await countKeysByPrefix(redisClient, dnsmetaPattern);
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

  app.get("/api/cache/stats", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = req.app.locals.ctx ?? {};
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) headers.Authorization = `Bearer ${dnsControlToken}`;
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

  app.get("/api/cache/refresh/stats", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = req.app.locals.ctx ?? {};
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) headers.Authorization = `Bearer ${dnsControlToken}`;
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

  app.post("/api/system/clear/redis", async (req, res) => {
    const { dnsControlUrl, dnsControlToken } = req.app.locals.ctx ?? {};
    if (!dnsControlUrl) {
      res.status(400).json({ error: "DNS_CONTROL_URL is not set" });
      return;
    }
    try {
      const headers = {};
      if (dnsControlToken) headers.Authorization = `Bearer ${dnsControlToken}`;
      const response = await fetch(`${dnsControlUrl}/cache/clear`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const body = await response.text();
        let errMsg = body || `Clear failed: ${response.status}`;
        try {
          const j = JSON.parse(body);
          if (j.error) errMsg = j.error;
        } catch {
          // use body as-is
        }
        res.status(502).json({ error: errMsg });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to clear Redis cache" });
    }
  });
}
