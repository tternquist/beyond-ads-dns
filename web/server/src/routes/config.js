/**
 * Config read/write, system config, export, import routes.
 */
import YAML from "yaml";
import {
  readMergedConfig,
  readOverrideConfig,
  readYamlFile,
  writeConfig,
  mergeDeep,
  redactConfig,
  getConfigDifferences,
  removePasswordFields,
  removeInstanceSpecificDetails,
  applyRedisEnvOverrides,
  applyQueryStoreEnvOverrides,
  resolveQueryStoreRetentionHours,
  parseExclusionList,
  normalizeErrorLogLevel,
  normalizeSources,
  normalizeDomains,
  validateScheduledPause,
  normalizeScheduledPause,
  validateFamilyTime,
  normalizeFamilyTime,
  validateHealthCheck,
  normalizeHealthCheck,
  normalizeLocalRecords,
} from "../utils/config.js";

function ctx(req) {
  return req.app.locals.ctx ?? {};
}

/** Build control API URL. */
function controlUrl(base, path) {
  const trimmed = String(base || "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}${path.startsWith("/") ? path : `/${path}`}` : "";
}

export function registerConfigRoutes(app) {
  app.get("/api/config", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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

  app.get("/api/system/config", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
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
      const logging = merged.logging || {};
      const ui = merged.ui || {};
      const requestLog = merged.request_log || {};
      const clientsRaw = clientId.clients || {};
      const clientsList = Array.isArray(clientsRaw)
        ? clientsRaw.map((c) => ({ ip: c.ip || "", name: c.name || "", group_id: c.group_id || "" }))
        : Object.entries(clientsRaw).map(([ip, name]) => ({ ip, name, group_id: "" }));
      const clientGroups = merged.client_groups || [];
      const redis = applyRedisEnvOverrides(cache.redis || {});
      res.json({
        server: {
          listen: Array.isArray(server.listen) ? server.listen.join(", ") : (server.listen || "0.0.0.0:53"),
          protocols: Array.isArray(server.protocols) ? server.protocols.join(", ") : (server.protocols || "udp, tcp"),
          read_timeout: server.read_timeout || "5s",
          write_timeout: server.write_timeout || "5s",
          reuse_port: server.reuse_port === true,
          reuse_port_listeners: server.reuse_port_listeners ?? 4,
        },
        cache: {
          redis_address: redis.address || "redis:6379",
          redis_db: redis.db ?? 0,
          redis_password: redis.password || "",
          redis_lru_size: redis.lru_size ?? 10000,
          redis_max_keys: redis.max_keys ?? 10000,
          redis_mode: redis.mode || "standalone",
          redis_master_name: redis.master_name || "",
          redis_sentinel_addrs: Array.isArray(redis.sentinel_addrs) ? redis.sentinel_addrs.join(", ") : (redis.sentinel_addrs || ""),
          redis_cluster_addrs: Array.isArray(redis.cluster_addrs) ? redis.cluster_addrs.join(", ") : (redis.cluster_addrs || ""),
          min_ttl: cache.min_ttl || "300s",
          max_ttl: cache.max_ttl || "1h",
          negative_ttl: cache.negative_ttl || "5m",
          servfail_backoff: cache.servfail_backoff || "60s",
          servfail_refresh_threshold: cache.servfail_refresh_threshold ?? 10,
          servfail_log_interval: cache.servfail_log_interval || "",
          respect_source_ttl: cache.respect_source_ttl === true,
          hit_count_sample_rate: cache.refresh?.hit_count_sample_rate ?? 1.0,
          sweep_min_hits: cache.refresh?.sweep_min_hits ?? 1,
          sweep_hit_window: cache.refresh?.sweep_hit_window || "72h",
          max_inflight: cache.refresh?.max_inflight ?? 100,
          sweep_interval: cache.refresh?.sweep_interval || "15s",
          sweep_window: cache.refresh?.sweep_window || "1m",
          max_batch_size: cache.refresh?.max_batch_size ?? 2000,
          serve_stale: cache.refresh?.serve_stale !== false,
          stale_ttl: cache.refresh?.stale_ttl || "1h",
          expired_entry_ttl: cache.refresh?.expired_entry_ttl || "30s",
          refresh_enabled: cache.refresh?.enabled !== false,
          refresh_hit_window: cache.refresh?.hit_window || "1m",
          refresh_hot_threshold: cache.refresh?.hot_threshold ?? 20,
          refresh_min_ttl: cache.refresh?.min_ttl || "30s",
          refresh_hot_ttl: cache.refresh?.hot_ttl || "2m",
          refresh_lock_ttl: cache.refresh?.lock_ttl || "10s",
          redis_lru_grace_period: cache.redis?.lru_grace_period || "",
        },
        query_store: (() => {
          const retentionHours = resolveQueryStoreRetentionHours(queryStore);
          const { queryStore: qs, maxSizeMbFromEnv } = applyQueryStoreEnvOverrides({
            enabled: queryStore.enabled !== false,
            address: queryStore.address || "http://clickhouse:8123",
            database: queryStore.database || "beyond_ads",
            table: queryStore.table || "dns_queries",
            username: queryStore.username || "beyondads",
            password: queryStore.password || "",
            flush_to_store_interval: queryStore.flush_to_store_interval || queryStore.flush_interval || "5s",
            flush_to_disk_interval: queryStore.flush_to_disk_interval || queryStore.flush_interval || "5s",
            batch_size: queryStore.batch_size ?? 2000,
            retention_hours: retentionHours,
            ...(queryStore.max_size_mb !== undefined && queryStore.max_size_mb !== null
              ? { max_size_mb: queryStore.max_size_mb }
              : {}),
            sample_rate: queryStore.sample_rate ?? 1.0,
            anonymize_client_ip: queryStore.anonymize_client_ip || "none",
            exclude_domains: Array.isArray(queryStore.exclude_domains) ? queryStore.exclude_domains : [],
            exclude_clients: Array.isArray(queryStore.exclude_clients) ? queryStore.exclude_clients : [],
          });
          return { ...qs, max_size_mb_from_env: maxSizeMbFromEnv };
        })(),
        client_identification: {
          enabled: clientId.enabled === true,
          clients: clientsList,
        },
        client_groups: clientGroups,
        control: {
          enabled: control.enabled !== false,
          listen: control.listen || "0.0.0.0:8081",
          token: control.token || "",
          errors_enabled: control.errors?.enabled !== false,
          errors_retention_days: control.errors?.retention_days ?? 7,
          errors_directory: control.errors?.directory || "logs",
          errors_filename_prefix: control.errors?.filename_prefix || "errors",
          errors_log_level: normalizeErrorLogLevel(logging.level || control.errors?.log_level || "warning"),
        },
        logging: {
          format: (logging.format || "text").toLowerCase() === "json" ? "json" : "text",
          level: ["debug", "info", "warn", "warning", "error"].includes(String(logging.level || control.errors?.log_level || "").toLowerCase())
            ? String(logging.level || control.errors?.log_level || "warning").toLowerCase()
            : "warning",
        },
        ui: {
          hostname: ui.hostname || "",
        },
        request_log: {
          enabled: requestLog.enabled === true,
          directory: requestLog.directory || "logs",
          filename_prefix: requestLog.filename_prefix || "dns-requests",
          format: requestLog.format || "text",
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to read system config" });
    }
  });

  app.put("/api/system/config", async (req, res) => {
    const { configPath } = ctx(req);
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
          protocols: typeof body.server.protocols === "string"
            ? body.server.protocols.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
            : (body.server.protocols || ["udp", "tcp"]),
          read_timeout: body.server.read_timeout || "5s",
          write_timeout: body.server.write_timeout || "5s",
          reuse_port: body.server.reuse_port === true,
          reuse_port_listeners: Math.max(1, Math.min(64, parseInt(body.server.reuse_port_listeners, 10) || 4)),
        };
      }
      if (body.cache) {
        const redis = {
          ...(overrideConfig.cache?.redis || {}),
          address: body.cache.redis_address || "redis:6379",
          db: parseInt(body.cache.redis_db, 10) || 0,
          password: String(body.cache.redis_password ?? "").trim(),
          lru_size: parseInt(body.cache.redis_lru_size, 10) || 10000,
          max_keys: (body.cache.redis_max_keys !== undefined && body.cache.redis_max_keys !== "")
            ? (() => { const v = parseInt(body.cache.redis_max_keys, 10); return Number.isNaN(v) ? 10000 : Math.max(0, v); })()
            : (overrideConfig.cache?.redis?.max_keys ?? 10000),
          mode: (body.cache.redis_mode || "standalone").toLowerCase(),
          master_name: String(body.cache.redis_master_name ?? "").trim(),
          sentinel_addrs: typeof body.cache.redis_sentinel_addrs === "string"
            ? body.cache.redis_sentinel_addrs.split(",").map((s) => s.trim()).filter(Boolean)
            : (body.cache.redis_sentinel_addrs || []),
          cluster_addrs: typeof body.cache.redis_cluster_addrs === "string"
            ? body.cache.redis_cluster_addrs.split(",").map((s) => s.trim()).filter(Boolean)
            : (body.cache.redis_cluster_addrs || []),
        };
        overrideConfig.cache = {
          ...(overrideConfig.cache || {}),
          redis,
          min_ttl: body.cache.min_ttl || "300s",
          max_ttl: body.cache.max_ttl || "1h",
          negative_ttl: body.cache.negative_ttl || "5m",
          servfail_backoff: body.cache.servfail_backoff || "60s",
          ...(body.cache.servfail_refresh_threshold !== undefined && body.cache.servfail_refresh_threshold !== null && body.cache.servfail_refresh_threshold !== ""
            ? { servfail_refresh_threshold: Math.max(0, parseInt(body.cache.servfail_refresh_threshold, 10) || 0) }
            : {}),
          ...(body.cache.servfail_log_interval !== undefined && body.cache.servfail_log_interval !== null && String(body.cache.servfail_log_interval).trim() !== ""
            ? { servfail_log_interval: String(body.cache.servfail_log_interval).trim() }
            : {}),
          respect_source_ttl: body.cache.respect_source_ttl === true,
        };
        if (body.cache && "servfail_log_interval" in body.cache && String(body.cache.servfail_log_interval || "").trim() === "") {
          delete overrideConfig.cache.servfail_log_interval;
        }
        if (body.cache.hit_count_sample_rate !== undefined && body.cache.hit_count_sample_rate !== null && body.cache.hit_count_sample_rate !== "") {
          const rate = parseFloat(body.cache.hit_count_sample_rate);
          if (!Number.isNaN(rate) && rate >= 0.01 && rate <= 1) {
            overrideConfig.cache.refresh = {
              ...(overrideConfig.cache?.refresh || {}),
              hit_count_sample_rate: rate,
            };
          }
        }
        if (body.cache.sweep_min_hits !== undefined && body.cache.sweep_min_hits !== null && body.cache.sweep_min_hits !== "") {
          const v = parseInt(body.cache.sweep_min_hits, 10);
          if (!Number.isNaN(v) && v >= 0) {
            overrideConfig.cache.refresh = {
              ...(overrideConfig.cache?.refresh || {}),
              sweep_min_hits: v,
            };
          }
        }
        if (body.cache.sweep_hit_window !== undefined && body.cache.sweep_hit_window !== null && String(body.cache.sweep_hit_window).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            sweep_hit_window: String(body.cache.sweep_hit_window).trim(),
          };
        }
        if (body.cache.max_inflight !== undefined && body.cache.max_inflight !== null && body.cache.max_inflight !== "") {
          const v = parseInt(body.cache.max_inflight, 10);
          if (!Number.isNaN(v) && v > 0) {
            overrideConfig.cache.refresh = {
              ...(overrideConfig.cache?.refresh || {}),
              max_inflight: v,
            };
          }
        }
        if (body.cache.sweep_interval !== undefined && body.cache.sweep_interval !== null && String(body.cache.sweep_interval).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            sweep_interval: String(body.cache.sweep_interval).trim(),
          };
        }
        if (body.cache.sweep_window !== undefined && body.cache.sweep_window !== null && String(body.cache.sweep_window).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            sweep_window: String(body.cache.sweep_window).trim(),
          };
        }
        if (body.cache.max_batch_size !== undefined && body.cache.max_batch_size !== null && body.cache.max_batch_size !== "") {
          const v = parseInt(body.cache.max_batch_size, 10);
          if (!Number.isNaN(v) && v > 0) {
            overrideConfig.cache.refresh = {
              ...(overrideConfig.cache?.refresh || {}),
              max_batch_size: v,
            };
          }
        }
        if (body.cache.serve_stale !== undefined && body.cache.serve_stale !== null) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            serve_stale: body.cache.serve_stale === true,
          };
        }
        if (body.cache.stale_ttl !== undefined && body.cache.stale_ttl !== null && String(body.cache.stale_ttl).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            stale_ttl: String(body.cache.stale_ttl).trim(),
          };
        }
        if (body.cache.expired_entry_ttl !== undefined && body.cache.expired_entry_ttl !== null && String(body.cache.expired_entry_ttl).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            expired_entry_ttl: String(body.cache.expired_entry_ttl).trim(),
          };
        }
        if (body.cache.refresh_enabled !== undefined && body.cache.refresh_enabled !== null) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            enabled: body.cache.refresh_enabled === true,
          };
        }
        if (body.cache.refresh_hit_window !== undefined && body.cache.refresh_hit_window !== null && String(body.cache.refresh_hit_window).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            hit_window: String(body.cache.refresh_hit_window).trim(),
          };
        }
        if (body.cache.refresh_hot_threshold !== undefined && body.cache.refresh_hot_threshold !== null && body.cache.refresh_hot_threshold !== "") {
          const v = parseInt(body.cache.refresh_hot_threshold, 10);
          if (!Number.isNaN(v) && v >= 0) {
            overrideConfig.cache.refresh = {
              ...(overrideConfig.cache?.refresh || {}),
              hot_threshold: v,
            };
          }
        }
        if (body.cache.refresh_min_ttl !== undefined && body.cache.refresh_min_ttl !== null && String(body.cache.refresh_min_ttl).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            min_ttl: String(body.cache.refresh_min_ttl).trim(),
          };
        }
        if (body.cache.refresh_hot_ttl !== undefined && body.cache.refresh_hot_ttl !== null && String(body.cache.refresh_hot_ttl).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            hot_ttl: String(body.cache.refresh_hot_ttl).trim(),
          };
        }
        if (body.cache.refresh_lock_ttl !== undefined && body.cache.refresh_lock_ttl !== null && String(body.cache.refresh_lock_ttl).trim()) {
          overrideConfig.cache.refresh = {
            ...(overrideConfig.cache?.refresh || {}),
            lock_ttl: String(body.cache.refresh_lock_ttl).trim(),
          };
        }
        if (body.cache.redis_lru_grace_period !== undefined && body.cache.redis_lru_grace_period !== null) {
          const val = String(body.cache.redis_lru_grace_period || "").trim();
          if (val !== "") {
            overrideConfig.cache.redis = { ...(overrideConfig.cache?.redis || {}), lru_grace_period: val };
          } else {
            const redisCopy = { ...(overrideConfig.cache?.redis || {}) };
            delete redisCopy.lru_grace_period;
            overrideConfig.cache.redis = redisCopy;
          }
        }
      }
      if (body.query_store) {
        const maxSizeMb = parseInt(body.query_store.max_size_mb, 10);
        const maxSizeMbValid = !Number.isNaN(maxSizeMb) && maxSizeMb >= 0;
        let retentionHours = parseInt(body.query_store.retention_hours, 10);
        if (Number.isNaN(retentionHours) || retentionHours <= 0) {
          const days = parseInt(body.query_store.retention_days, 10);
          retentionHours = (!Number.isNaN(days) && days > 0) ? days * 24 : 168;
        }
        const qs = {
          ...(overrideConfig.query_store || {}),
          enabled: body.query_store.enabled !== false,
          address: body.query_store.address || "http://clickhouse:8123",
          database: body.query_store.database || "beyond_ads",
          table: body.query_store.table || "dns_queries",
          username: String(body.query_store.username ?? "beyondads").trim() || "beyondads",
          password: String(body.query_store.password ?? ""),
          flush_to_store_interval: body.query_store.flush_to_store_interval || "5s",
          flush_to_disk_interval: body.query_store.flush_to_disk_interval || "5s",
          batch_size: parseInt(body.query_store.batch_size, 10) || 2000,
          retention_hours: retentionHours,
          ...(maxSizeMbValid && maxSizeMb > 0 ? { max_size_mb: maxSizeMb } : {}),
          sample_rate: parseFloat(body.query_store.sample_rate) || 1.0,
          anonymize_client_ip: ["none", "hash", "truncate"].includes(String(body.query_store.anonymize_client_ip || "none").toLowerCase())
            ? String(body.query_store.anonymize_client_ip).toLowerCase()
            : "none",
          exclude_domains: parseExclusionList(body.query_store.exclude_domains),
          exclude_clients: parseExclusionList(body.query_store.exclude_clients),
        };
        if (!(maxSizeMbValid && maxSizeMb > 0)) {
          delete qs.max_size_mb;
        }
        delete qs.flush_interval;
        delete qs.retention_days;
        delete qs.max_size_mb_from_env;
        overrideConfig.query_store = qs;
      }
      if (body.client_identification) {
        const clientsList = body.client_identification.clients || [];
        const clients = clientsList
          .map((entry) => ({
            ip: String(entry?.ip || "").trim(),
            name: String(entry?.name || "").trim(),
            group_id: String(entry?.group_id || "").trim(),
          }))
          .filter((e) => e.ip && e.name);
        overrideConfig.client_identification = {
          enabled: body.client_identification.enabled === true,
          clients,
        };
      }
      if (body.client_groups) {
        overrideConfig.client_groups = body.client_groups;
      }
      if (body.control) {
        overrideConfig.control = {
          ...(overrideConfig.control || {}),
          enabled: body.control.enabled !== false,
          listen: body.control.listen || "0.0.0.0:8081",
          token: String(body.control.token ?? "").trim(),
          errors: {
            enabled: body.control.errors_enabled !== false,
            retention_days: parseInt(body.control.errors_retention_days, 10) || 7,
            directory: String(body.control.errors_directory ?? "logs").trim() || "logs",
            filename_prefix: String(body.control.errors_filename_prefix ?? "errors").trim() || "errors",
          },
        };
      }
      if (body.logging) {
        const existing = overrideConfig.logging || {};
        const formatVal = body.logging.format !== undefined && body.logging.format !== null
          ? ((body.logging.format || "text").toLowerCase() === "json" ? "json" : "text")
          : (existing.format || "text");
        const levelVal = body.logging.level !== undefined && body.logging.level !== null
          ? (["debug", "info", "warn", "warning", "error"].includes(String(body.logging.level).toLowerCase())
            ? String(body.logging.level).toLowerCase()
            : (existing.level || "warning"))
          : (existing.level || "warning");
        overrideConfig.logging = { format: formatVal, level: levelVal };
      }
      if (body.request_log) {
        overrideConfig.request_log = {
          enabled: body.request_log.enabled === true,
          directory: String(body.request_log.directory ?? "logs").trim() || "logs",
          filename_prefix: String(body.request_log.filename_prefix ?? "dns-requests").trim() || "dns-requests",
          format: (body.request_log.format || "text").toLowerCase() === "json" ? "json" : "text",
        };
      }
      if (body.ui) {
        overrideConfig.ui = {
          ...(overrideConfig.ui || {}),
          hostname: String(body.ui.hostname ?? "").trim(),
        };
      }

      await writeConfig(configPath, overrideConfig);

      // Apply Redis max_keys to running DNS resolver so cap takes effect without restart
      const { dnsControlUrl, dnsControlToken } = ctx(req);
      if (body.cache && dnsControlUrl && (body.cache.redis_max_keys !== undefined && body.cache.redis_max_keys !== "")) {
        const v = parseInt(body.cache.redis_max_keys, 10);
        const maxKeys = Number.isNaN(v) ? 10000 : Math.max(0, v);
        try {
          const headers = { "Content-Type": "application/json" };
          if (dnsControlToken) headers.Authorization = `Bearer ${dnsControlToken}`;
          const applyRes = await fetch(controlUrl(dnsControlUrl, "/cache/config"), {
            method: "PUT",
            headers,
            body: JSON.stringify({ max_keys: maxKeys }),
          });
          if (!applyRes.ok) {
            // Non-fatal: config is saved; user can restart to apply
          }
        } catch (_) {
          // Non-fatal
        }
      }

      res.json({ ok: true, message: "Saved. Restart the service to apply changes." });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to update system config" });
    }
  });

  app.get("/api/config/export", async (req, res) => {
    const { defaultConfigPath, configPath } = ctx(req);
    if (!defaultConfigPath && !configPath) {
      res.status(400).json({ error: "DEFAULT_CONFIG_PATH or CONFIG_PATH is not set" });
      return;
    }
    try {
      const excludeInstanceDetails = req.query.exclude_instance_details !== "false";
      const defaultConfig = await readYamlFile(defaultConfigPath);
      const overrideConfig = await readYamlFile(configPath);

      const differences = getConfigDifferences(defaultConfig, overrideConfig);
      removePasswordFields(differences);

      if (excludeInstanceDetails) {
        removeInstanceSpecificDetails(differences);
      }

      const yamlContent = YAML.stringify(differences);

      res.setHeader("Content-Type", "application/x-yaml");
      res.setHeader("Content-Disposition", "attachment; filename=\"config-export.yaml\"");
      res.send(yamlContent);
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to export config" });
    }
  });

  app.post("/api/config/import", async (req, res) => {
    const { configPath } = ctx(req);
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

      const existingOverride = await readOverrideConfig(configPath);
      const merged = mergeDeep(existingOverride, importedConfig);

      await writeConfig(configPath, merged);

      res.json({ ok: true, message: "Config imported successfully" });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to import config" });
    }
  });
}
