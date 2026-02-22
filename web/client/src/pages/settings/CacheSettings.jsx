/**
 * Cache and Query Store (advanced) settings section for the System Settings page.
 * Shown when "Show advanced settings" is enabled.
 */
export default function CacheSettings({
  systemConfig,
  systemConfigValidation = { fieldErrors: {} },
  updateSystemConfig,
}) {
  return (
    <>
      <h3 style={{ marginTop: "2rem" }}>Cache</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        TTLs, refresh sweeper, and Redis tuning.
      </p>
      <div className="form-group">
        <label className="field-label">Redis LRU size</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_redis_lru_size ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.redis_lru_size ?? "10000"}
          onChange={(e) =>
            updateSystemConfig("cache", "redis_lru_size", e.target.value)
          }
          placeholder="10000"
          style={{ maxWidth: "120px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_redis_lru_size && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_redis_lru_size}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          L0 in-memory LRU cache size. 0 disables. Higher values reduce Redis load at high QPS. Default: 10000.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Min TTL</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_min_ttl ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.min_ttl ?? "300s"}
          onChange={(e) =>
            updateSystemConfig("cache", "min_ttl", e.target.value)
          }
          placeholder="300s"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_min_ttl && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_min_ttl}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Minimum TTL for cached answers. Shorter source TTLs are raised to this. Default: 300s.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Max TTL</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_max_ttl ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.max_ttl ?? "1h"}
          onChange={(e) =>
            updateSystemConfig("cache", "max_ttl", e.target.value)
          }
          placeholder="1h"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_max_ttl && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_max_ttl}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Maximum TTL for cached answers. Longer source TTLs are capped. Default: 1h.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Negative TTL</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_negative_ttl ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.negative_ttl ?? "5m"}
          onChange={(e) =>
            updateSystemConfig("cache", "negative_ttl", e.target.value)
          }
          placeholder="5m"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_negative_ttl && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_negative_ttl}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          TTL for NXDOMAIN and negative responses. Shorter = more upstream queries. Default: 5m.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">SERVFAIL backoff</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_servfail_backoff ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.servfail_backoff ?? "60s"}
          onChange={(e) =>
            updateSystemConfig("cache", "servfail_backoff", e.target.value)
          }
          placeholder="60s"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_servfail_backoff && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_servfail_backoff}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Wait before retrying refresh after SERVFAIL (security/misconfig indicator). Default: 60s.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Max inflight refreshes</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_max_inflight ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.max_inflight ?? "100"}
          onChange={(e) =>
            updateSystemConfig("cache", "max_inflight", e.target.value)
          }
          placeholder="100"
          style={{ maxWidth: "80px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_max_inflight && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_max_inflight}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Max concurrent background refresh requests to upstream. Limits load during thundering herd. Default: 100.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Max batch size (sweep)</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_max_batch_size ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.max_batch_size ?? "2000"}
          onChange={(e) =>
            updateSystemConfig(
              "cache",
              "max_batch_size",
              e.target.value
            )
          }
          placeholder="2000"
          style={{ maxWidth: "80px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_max_batch_size && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_max_batch_size}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Max entries per refresh sweeper batch. Higher = fewer sweeps, more memory per sweep. Default: 2000.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Sweep interval</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_sweep_interval ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.sweep_interval ?? "15s"}
          onChange={(e) =>
            updateSystemConfig("cache", "sweep_interval", e.target.value)
          }
          placeholder="15s"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_sweep_interval && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_sweep_interval}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          How often the refresh sweeper runs to find entries needing refresh. Default: 15s.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Sweep window</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_sweep_window ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.sweep_window ?? "1m"}
          onChange={(e) =>
            updateSystemConfig("cache", "sweep_window", e.target.value)
          }
          placeholder="1m"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_sweep_window && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_sweep_window}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Time window for each sweep pass. Shorter = more granular, more Redis scans. Default: 1m.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Sweep min hits</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_sweep_min_hits ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.sweep_min_hits ?? "1"}
          onChange={(e) =>
            updateSystemConfig("cache", "sweep_min_hits", e.target.value)
          }
          placeholder="1"
          style={{ maxWidth: "80px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_sweep_min_hits && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_sweep_min_hits}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Minimum hit count for entry to be considered for refresh. 1 = all entries. Default: 1.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Sweep hit window</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_sweep_hit_window ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.sweep_hit_window ?? "48h"}
          onChange={(e) =>
            updateSystemConfig("cache", "sweep_hit_window", e.target.value)
          }
          placeholder="48h"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_sweep_hit_window && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_sweep_hit_window}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Time window for counting hits. 48h = 2 days. Entries with fewer hits in this window are deprioritized. Default: 48h.
        </p>
      </div>
      <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={systemConfig.cache?.serve_stale !== false}
          onChange={(e) =>
            updateSystemConfig("cache", "serve_stale", e.target.checked)
          }
        />
        {" "}Serve stale for performance and resilience
      </label>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
        Serve expired entries immediately while refreshing in background (avoids latency spikes) and when upstream is unavailable (prevents SERVFAIL during outages).
      </p>
      <div className="form-group">
        <label className="field-label">Stale TTL</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_stale_ttl ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.stale_ttl ?? "1h"}
          onChange={(e) =>
            updateSystemConfig("cache", "stale_ttl", e.target.value)
          }
          placeholder="1h"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_stale_ttl && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_stale_ttl}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          TTL in DNS response when serving stale (expired) entries. Client will re-query after this. Default: 1h.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Expired entry TTL</label>
        <input
          className={`input ${systemConfigValidation?.fieldErrors?.cache_expired_entry_ttl ? "input-invalid" : ""}`}
          type="text"
          value={systemConfig.cache?.expired_entry_ttl ?? "30s"}
          onChange={(e) =>
            updateSystemConfig("cache", "expired_entry_ttl", e.target.value)
          }
          placeholder="30s"
          style={{ maxWidth: "100px" }}
        />
        {systemConfigValidation?.fieldErrors?.cache_expired_entry_ttl && (
          <div className="field-error">{systemConfigValidation.fieldErrors.cache_expired_entry_ttl}</div>
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          TTL in DNS response when serving expired entries (before upstream responds). Keeps client from hammering. Default: 30s.
        </p>
      </div>
      <h3 style={{ marginTop: "2rem" }}>Query Store (advanced)</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        Flush intervals, sampling, and exclusions.
      </p>
      {systemConfig.query_store?.enabled && (
        <>
          <div className="form-group">
            <label className="field-label">Flush to store interval</label>
            <input
              className={`input ${systemConfigValidation?.fieldErrors?.query_store_flush_to_store_interval ? "input-invalid" : ""}`}
              type="text"
              value={systemConfig.query_store?.flush_to_store_interval ?? "5s"}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "flush_to_store_interval",
                  e.target.value
                )
              }
              placeholder="5s"
              style={{ maxWidth: "100px" }}
            />
            {systemConfigValidation?.fieldErrors?.query_store_flush_to_store_interval && (
              <div className="field-error">{systemConfigValidation.fieldErrors.query_store_flush_to_store_interval}</div>
            )}
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              How often the app sends buffered query events to ClickHouse. Default: 5s.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Flush to disk interval</label>
            <input
              className={`input ${systemConfigValidation?.fieldErrors?.query_store_flush_to_disk_interval ? "input-invalid" : ""}`}
              type="text"
              value={systemConfig.query_store?.flush_to_disk_interval ?? "5s"}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "flush_to_disk_interval",
                  e.target.value
                )
              }
              placeholder="5s"
              style={{ maxWidth: "100px" }}
            />
            {systemConfigValidation?.fieldErrors?.query_store_flush_to_disk_interval && (
              <div className="field-error">{systemConfigValidation.fieldErrors.query_store_flush_to_disk_interval}</div>
            )}
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              How often ClickHouse flushes async inserts to disk. Default: 5s.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Batch size</label>
            <input
              className={`input ${systemConfigValidation?.fieldErrors?.query_store_batch_size ? "input-invalid" : ""}`}
              type="text"
              value={systemConfig.query_store?.batch_size ?? "2000"}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "batch_size",
                  e.target.value
                )
              }
              placeholder="2000"
              style={{ maxWidth: "100px" }}
            />
            {systemConfigValidation?.fieldErrors?.query_store_batch_size && (
              <div className="field-error">{systemConfigValidation.fieldErrors.query_store_batch_size}</div>
            )}
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Max queries per insert batch. Higher = fewer inserts, more memory before flush. Default: 2000.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Sample rate (0.01–1.0)</label>
            <input
              className={`input ${systemConfigValidation?.fieldErrors?.query_store_sample_rate ? "input-invalid" : ""}`}
              type="text"
              value={systemConfig.query_store?.sample_rate ?? "1.0"}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "sample_rate",
                  e.target.value
                )
              }
              placeholder="1.0"
              style={{ maxWidth: "100px" }}
            />
            {systemConfigValidation?.fieldErrors?.query_store_sample_rate && (
              <div className="field-error">{systemConfigValidation.fieldErrors.query_store_sample_rate}</div>
            )}
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Fraction of queries to record. 1.0 = all. Use &lt;1.0 to reduce load at high QPS. Default: 1.0.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Anonymize client IP</label>
            <select
              className="input"
              value={systemConfig.query_store?.anonymize_client_ip ?? "none"}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "anonymize_client_ip",
                  e.target.value
                )
              }
              style={{ maxWidth: "150px" }}
            >
              <option value="none">None</option>
              <option value="hash">Hash</option>
              <option value="truncate">Truncate</option>
            </select>
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              For GDPR/privacy: hash (SHA256 prefix) or truncate (/24 IPv4, /64 IPv6). Default: none.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Exclude domains (one per line)</label>
            <textarea
              className="input"
              rows={3}
              value={(systemConfig.query_store?.exclude_domains || []).join("\n")}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "exclude_domains",
                  e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                )
              }
              placeholder="example.com"
              style={{ maxWidth: "400px" }}
            />
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Domains to exclude from query statistics (exact match + subdomains). Default: none.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Exclude clients (one per line)</label>
            <textarea
              className="input"
              rows={3}
              value={(systemConfig.query_store?.exclude_clients || []).join("\n")}
              onChange={(e) =>
                updateSystemConfig(
                  "query_store",
                  "exclude_clients",
                  e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                )
              }
              placeholder="192.168.1.10"
              style={{ maxWidth: "400px" }}
            />
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Client IPs or names to exclude from query statistics. Default: none.
            </p>
          </div>
        </>
      )}
    </>
  );
}
