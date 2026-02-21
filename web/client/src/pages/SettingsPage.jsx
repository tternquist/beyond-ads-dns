import { SkeletonCard } from "../components/Skeleton.jsx";

export default function SettingsPage({
  systemConfig,
  systemConfigValidation = { fieldErrors: {} },
  systemConfigLoading,
  systemConfigStatus,
  systemConfigError,
  saveSystemConfig,
  confirmRestartService,
  restartLoading,
  runAutodetectResourceSettings,
  autodetectLoading,
  showAdvancedSettings,
  toggleShowAdvancedSettings,
  passwordEditable,
  canSetInitialPassword,
  authEnabled,
  adminCurrentPassword,
  setAdminCurrentPassword,
  adminNewPassword,
  setAdminNewPassword,
  adminConfirmPassword,
  setAdminConfirmPassword,
  adminPasswordLoading,
  adminPasswordStatus,
  adminPasswordError,
  handleSetPassword,
  updateSystemConfig,
  runCpuDetect,
  cpuDetectLoading,
  clearRedisData,
  clearRedisLoading,
  clearClickhouseData,
  clearClickhouseLoading,
  clearRedisError,
  clearClickhouseError,
}) {
  return (
    <section className="section">
      <div className="section-header">
        <h2>System Settings</h2>
        <div className="actions">
          <button
            className="button primary"
            onClick={() => saveSystemConfig()}
            disabled={systemConfigLoading || !systemConfig || systemConfigValidation?.hasErrors}
          >
            {systemConfigLoading ? "Saving..." : "Save"}
          </button>
          <button
            className="button"
            onClick={confirmRestartService}
            disabled={restartLoading}
          >
            {restartLoading ? "Restarting..." : "Restart service"}
          </button>
        </div>
      </div>
      <p className="muted">
        Most settings require a restart to take effect. Client Identification
        applies immediately when saved.
      </p>
      {systemConfigStatus && <p className="status">{systemConfigStatus}</p>}
      {systemConfigError && <div className="error">{systemConfigError}</div>}
      {!systemConfig ? (
        <div className="grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <>
          <div className="form-group" style={{ marginBottom: "1.5rem" }}>
            <button
              type="button"
              className="button"
              onClick={runAutodetectResourceSettings}
              disabled={autodetectLoading}
            >
              {autodetectLoading ? "Detecting…" : "Auto-detect resource settings"}
            </button>
            <p
              className="muted"
              style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}
            >
              Detects CPU and memory, then recommends L0 cache, refresh sweeper, and
              query store settings for this machine. Apply and then Save to
              persist.
            </p>
          </div>
          <div className="form-group" style={{ marginBottom: "1rem" }}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showAdvancedSettings}
                onChange={toggleShowAdvancedSettings}
              />
              {" "}Show advanced settings
            </label>
            <p
              className="muted"
              style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}
            >
              Reveals tuning options for timeouts, TTLs, refresh sweeper, query
              store, error persistence, and request logging.
            </p>
          </div>
          {(passwordEditable || canSetInitialPassword) && (
            <>
              <h3>Admin Password</h3>
              <p className="muted" style={{ marginBottom: "0.5rem" }}>
                {canSetInitialPassword
                  ? "Set a password to protect the UI. Once set, you will need to log in to access the dashboard."
                  : "Change the admin password used to log in to the UI."}
              </p>
              {authEnabled && (
                <div className="form-group">
                  <label className="field-label">Current password</label>
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={adminCurrentPassword}
                    onChange={(e) => setAdminCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    style={{ maxWidth: "250px" }}
                  />
                </div>
              )}
              <div className="form-group">
                <label className="field-label">
                  {canSetInitialPassword ? "Password" : "New password"}
                </label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={adminNewPassword}
                  onChange={(e) => setAdminNewPassword(e.target.value)}
                  placeholder={
                    canSetInitialPassword
                      ? "Choose a password"
                      : "Enter new password"
                  }
                  style={{ maxWidth: "250px" }}
                />
              </div>
              <div className="form-group">
                <label className="field-label">Confirm password</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={adminConfirmPassword}
                  onChange={(e) => setAdminConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  style={{ maxWidth: "250px" }}
                />
              </div>
              <button
                className="button primary"
                onClick={handleSetPassword}
                disabled={
                  adminPasswordLoading ||
                  !adminNewPassword ||
                  adminNewPassword !== adminConfirmPassword ||
                  (authEnabled && !adminCurrentPassword)
                }
              >
                {adminPasswordLoading
                  ? "Saving..."
                  : canSetInitialPassword
                    ? "Set password"
                    : "Change password"}
              </button>
              {adminPasswordStatus && (
                <p className="status" style={{ marginTop: "0.5rem" }}>
                  {adminPasswordStatus}
                </p>
              )}
              {adminPasswordError && (
                <div className="error" style={{ marginTop: "0.5rem" }}>
                  {adminPasswordError}
                </div>
              )}
            </>
          )}
          <h3>Query Store</h3>
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            Store DNS queries in ClickHouse for analytics. Enable to use the
            Queries tab and Multi-Instance stats.
          </p>
          <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={systemConfig.query_store?.enabled === true}
              onChange={(e) =>
                updateSystemConfig("query_store", "enabled", e.target.checked)
              }
            />
            {" "}Enable query store
          </label>
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
            Store DNS queries in ClickHouse for the Queries tab and Multi-Instance stats. Requires ClickHouse.
          </p>
          {systemConfig.query_store?.enabled && (
            <div style={{ marginLeft: 20, marginTop: 8 }}>
              <div className="form-group">
                <label className="field-label">Retention (hours)</label>
                <input
                  className={`input ${systemConfigValidation?.fieldErrors?.query_store_retention_hours ? "input-invalid" : ""}`}
                  type="text"
                  value={systemConfig.query_store?.retention_hours ?? "168"}
                  onChange={(e) =>
                    updateSystemConfig(
                      "query_store",
                      "retention_hours",
                      e.target.value
                    )
                  }
                  placeholder="168"
                  style={{ maxWidth: "100px" }}
                />
                {systemConfigValidation?.fieldErrors?.query_store_retention_hours && (
                  <div className="field-error">{systemConfigValidation.fieldErrors.query_store_retention_hours}</div>
                )}
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Hours to keep query analytics data. 168 = 7 days. Use 12 or 24 for sub-day retention on resource-constrained devices. Default: 168.
                </p>
              </div>
              <div className="form-group">
                <label className="field-label">Max size (MB, 0=unlimited)</label>
                <input
                  className={`input ${systemConfigValidation?.fieldErrors?.query_store_max_size_mb ? "input-invalid" : ""}`}
                  type="text"
                  value={systemConfig.query_store?.max_size_mb ?? "0"}
                  onChange={(e) =>
                    updateSystemConfig(
                      "query_store",
                      "max_size_mb",
                      e.target.value
                    )
                  }
                  placeholder="0"
                  style={{ maxWidth: "100px" }}
                />
                {systemConfigValidation?.fieldErrors?.query_store_max_size_mb && (
                  <div className="field-error">{systemConfigValidation.fieldErrors.query_store_max_size_mb}</div>
                )}
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Limit storage size. 0 = unlimited. With tmpfs: use tmpfs_mb − 200 (e.g. 56 for 256MB). Oldest partitions dropped when exceeded. Default: 0.
                </p>
              </div>
            </div>
          )}
          <h3 style={{ marginTop: "2rem" }}>Server</h3>
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            Network and listener settings.
          </p>
          <div className="form-group">
            <label className="field-label">Reuse port listeners</label>
            <input
              className={`input ${systemConfigValidation?.fieldErrors?.server_reuse_port_listeners ? "input-invalid" : ""}`}
              type="text"
              value={systemConfig.server?.reuse_port_listeners ?? "4"}
              onChange={(e) =>
                updateSystemConfig(
                  "server",
                  "reuse_port_listeners",
                  e.target.value
                )
              }
              placeholder="4"
              style={{ maxWidth: "80px" }}
            />
            {systemConfigValidation?.fieldErrors?.server_reuse_port_listeners && (
              <div className="field-error">{systemConfigValidation.fieldErrors.server_reuse_port_listeners}</div>
            )}
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Number of SO_REUSEPORT listeners for multi-core scaling. Typically 1–4 on small systems, up to NumCPU on high-QPS. Default: 4.
            </p>
          </div>
          {showAdvancedSettings && (
            <>
              <div className="form-group">
                <label className="field-label">Read timeout</label>
                <input
                  className={`input ${systemConfigValidation?.fieldErrors?.server_read_timeout ? "input-invalid" : ""}`}
                  type="text"
                  value={systemConfig.server?.read_timeout ?? "5s"}
                  onChange={(e) =>
                    updateSystemConfig("server", "read_timeout", e.target.value)
                  }
                  placeholder="5s"
                  style={{ maxWidth: "80px" }}
                />
                {systemConfigValidation?.fieldErrors?.server_read_timeout && (
                  <div className="field-error">{systemConfigValidation.fieldErrors.server_read_timeout}</div>
                )}
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Max time to wait for DNS request data from client. Use duration (e.g. 5s, 1m). Default: 5s.
                </p>
              </div>
              <div className="form-group">
                <label className="field-label">Write timeout</label>
                <input
                  className={`input ${systemConfigValidation?.fieldErrors?.server_write_timeout ? "input-invalid" : ""}`}
                  type="text"
                  value={systemConfig.server?.write_timeout ?? "5s"}
                  onChange={(e) =>
                    updateSystemConfig("server", "write_timeout", e.target.value)
                  }
                  placeholder="5s"
                  style={{ maxWidth: "80px" }}
                />
                {systemConfigValidation?.fieldErrors?.server_write_timeout && (
                  <div className="field-error">{systemConfigValidation.fieldErrors.server_write_timeout}</div>
                )}
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Max time to send DNS response to client. Use duration (e.g. 5s, 1m). Default: 5s.
                </p>
              </div>
            </>
          )}
          {showAdvancedSettings && (
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
                  value={systemConfig.cache?.max_inflight ?? "50"}
                  onChange={(e) =>
                    updateSystemConfig("cache", "max_inflight", e.target.value)
                  }
                  placeholder="50"
                  style={{ maxWidth: "80px" }}
                />
                {systemConfigValidation?.fieldErrors?.cache_max_inflight && (
                  <div className="field-error">{systemConfigValidation.fieldErrors.cache_max_inflight}</div>
                )}
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Max concurrent background refresh requests to upstream. Limits load during thundering herd. Default: 50.
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
                  value={systemConfig.cache?.sweep_hit_window ?? "168h"}
                  onChange={(e) =>
                    updateSystemConfig("cache", "sweep_hit_window", e.target.value)
                  }
                  placeholder="168h"
                  style={{ maxWidth: "100px" }}
                />
                {systemConfigValidation?.fieldErrors?.cache_sweep_hit_window && (
                  <div className="field-error">{systemConfigValidation.fieldErrors.cache_sweep_hit_window}</div>
                )}
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Time window for counting hits. 168h = 7 days. Entries with fewer hits in this window are deprioritized. Default: 168h.
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
              <h3 style={{ marginTop: "2rem" }}>Control API & Error Persistence</h3>
              <p className="muted" style={{ marginBottom: "0.5rem" }}>
                Control server and error log persistence.
              </p>
              <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={systemConfig.control?.enabled !== false}
                  onChange={(e) =>
                    updateSystemConfig("control", "enabled", e.target.checked)
                  }
                />
                {" "}Enable control API
              </label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
                HTTP API for config sync, health, and control. Required for Metrics UI and replicas.
              </p>
              {systemConfig.control?.enabled !== false && (
                <>
                  <div className="form-group">
                    <label className="field-label">Listen address</label>
                    <input
                      className={`input ${systemConfigValidation?.fieldErrors?.control_listen ? "input-invalid" : ""}`}
                      type="text"
                      value={systemConfig.control?.listen ?? "0.0.0.0:8081"}
                      onChange={(e) =>
                        updateSystemConfig("control", "listen", e.target.value)
                      }
                      placeholder="0.0.0.0:8081"
                      style={{ maxWidth: "200px" }}
                    />
                    {systemConfigValidation?.fieldErrors?.control_listen && (
                      <div className="field-error">{systemConfigValidation.fieldErrors.control_listen}</div>
                    )}
                    <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                      Host:port for the control API. Default: 0.0.0.0:8081 (listens on all interfaces).
                    </p>
                  </div>
                  <div className="form-group">
                    <label className="field-label">Control token</label>
                    <input
                      className="input"
                      type="password"
                      value={systemConfig.control?.token ?? ""}
                      onChange={(e) =>
                        updateSystemConfig("control", "token", e.target.value)
                      }
                      placeholder="(optional)"
                      style={{ maxWidth: "250px" }}
                    />
                    <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                      Bearer token for API auth. Empty = no auth. Set for sync replicas and external access. Default: empty.
                    </p>
                  </div>
                  <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={systemConfig.control?.errors_enabled !== false}
                      onChange={(e) =>
                        updateSystemConfig("control", "errors_enabled", e.target.checked)
                      }
                    />
                    {" "}Enable error persistence
                  </label>
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
                    Persist resolver errors to disk for the Error Viewer. Enabled by default when control API is on.
                  </p>
                  {systemConfig.control?.errors_enabled !== false && (
                    <>
                      <div className="form-group">
                        <label className="field-label">Errors retention (days)</label>
                        <input
                          className={`input ${systemConfigValidation?.fieldErrors?.control_errors_retention_days ? "input-invalid" : ""}`}
                          type="text"
                          value={systemConfig.control?.errors_retention_days ?? "7"}
                          onChange={(e) =>
                            updateSystemConfig(
                              "control",
                              "errors_retention_days",
                              e.target.value
                            )
                          }
                          placeholder="7"
                          style={{ maxWidth: "80px" }}
                        />
                        {systemConfigValidation?.fieldErrors?.control_errors_retention_days && (
                          <div className="field-error">{systemConfigValidation.fieldErrors.control_errors_retention_days}</div>
                        )}
                        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                          Days to keep error log entries. Older entries are pruned. Default: 7.
                        </p>
                      </div>
                      <div className="form-group">
                        <label className="field-label">Errors directory</label>
                        <input
                          className="input"
                          type="text"
                          value={systemConfig.control?.errors_directory ?? "logs"}
                          onChange={(e) =>
                            updateSystemConfig(
                              "control",
                              "errors_directory",
                              e.target.value
                            )
                          }
                          placeholder="logs"
                          style={{ maxWidth: "200px" }}
                        />
                        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                          Directory for error log files. Relative to app working directory. Default: logs.
                        </p>
                      </div>
                      <div className="form-group">
                        <label className="field-label">Errors filename prefix</label>
                        <input
                          className="input"
                          type="text"
                          value={systemConfig.control?.errors_filename_prefix ?? "errors"}
                          onChange={(e) =>
                            updateSystemConfig(
                              "control",
                              "errors_filename_prefix",
                              e.target.value
                            )
                          }
                          placeholder="errors"
                          style={{ maxWidth: "150px" }}
                        />
                        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                          Prefix for error log filenames (e.g. errors-2025-02-21.log). Default: errors.
                        </p>
                      </div>
                    </>
                  )}
                </>
              )}
              <h3 style={{ marginTop: "2rem" }}>Application Logging</h3>
              <p className="muted" style={{ marginBottom: "0.5rem" }}>
                Log format and level (affects Error Viewer and stdout).
              </p>
              <div className="form-group">
                <label className="field-label">Log level</label>
                <select
                  className="input"
                  value={systemConfig.logging?.level ?? systemConfig.control?.errors_log_level ?? "warning"}
                  onChange={(e) =>
                    updateSystemConfig("logging", "level", e.target.value)
                  }
                  style={{ maxWidth: "120px" }}
                >
                  <option value="error">Error</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug</option>
                </select>
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Minimum severity for stdout and Error Viewer. Debug = verbose; Error = critical only. Default: warning.
                </p>
              </div>
              <div className="form-group">
                <label className="field-label">Log format</label>
                <select
                  className="input"
                  value={systemConfig.logging?.format ?? "text"}
                  onChange={(e) =>
                    updateSystemConfig("logging", "format", e.target.value)
                  }
                  style={{ maxWidth: "120px" }}
                >
                  <option value="text">Text</option>
                  <option value="json">JSON</option>
                </select>
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Text = human-readable; JSON = structured for Grafana, Loki, or log aggregators. Default: text.
                </p>
              </div>
              <h3 style={{ marginTop: "2rem" }}>Request Logging</h3>
              <p className="muted" style={{ marginBottom: "0.5rem" }}>
                Log DNS requests to disk for debugging.
              </p>
              <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={systemConfig.request_log?.enabled === true}
                  onChange={(e) =>
                    updateSystemConfig("request_log", "enabled", e.target.checked)
                  }
                />
                {" "}Enable request logging
              </label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
                Log every DNS request to disk. Use for debugging; can be high volume.
              </p>
              {systemConfig.request_log?.enabled && (
                <>
                  <div className="form-group">
                    <label className="field-label">Directory</label>
                    <input
                      className="input"
                      type="text"
                      value={systemConfig.request_log?.directory ?? "logs"}
                      onChange={(e) =>
                        updateSystemConfig(
                          "request_log",
                          "directory",
                          e.target.value
                        )
                      }
                      placeholder="logs"
                      style={{ maxWidth: "200px" }}
                    />
                    <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                      Directory for request log files. Relative to app working directory. Default: logs.
                    </p>
                  </div>
                  <div className="form-group">
                    <label className="field-label">Filename prefix</label>
                    <input
                      className="input"
                      type="text"
                      value={systemConfig.request_log?.filename_prefix ?? "dns-requests"}
                      onChange={(e) =>
                        updateSystemConfig(
                          "request_log",
                          "filename_prefix",
                          e.target.value
                        )
                      }
                      placeholder="dns-requests"
                      style={{ maxWidth: "200px" }}
                    />
                    <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                      Prefix for request log filenames (e.g. dns-requests-2025-02-21.log). Default: dns-requests.
                    </p>
                  </div>
                  <div className="form-group">
                    <label className="field-label">Format</label>
                    <select
                      className="input"
                      value={systemConfig.request_log?.format ?? "text"}
                      onChange={(e) =>
                        updateSystemConfig(
                          "request_log",
                          "format",
                          e.target.value
                        )
                      }
                      style={{ maxWidth: "120px" }}
                    >
                      <option value="text">Text</option>
                      <option value="json">JSON</option>
                    </select>
                    <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                      Text = human-readable; JSON = structured with query_id, qname, outcome, latency. Default: text.
                    </p>
                  </div>
                </>
              )}
              <h3 style={{ marginTop: "2rem" }}>UI</h3>
              <p className="muted" style={{ marginBottom: "0.5rem" }}>
                Display hostname in the environment banner.
              </p>
              <div className="form-group">
                <label className="field-label">Hostname</label>
                <input
                  className="input"
                  type="text"
                  value={systemConfig.ui?.hostname ?? ""}
                  onChange={(e) =>
                    updateSystemConfig("ui", "hostname", e.target.value)
                  }
                  placeholder="(OS hostname if empty)"
                  style={{ maxWidth: "250px" }}
                />
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Override hostname shown in the environment banner. Empty = use system hostname. Default: empty.
                </p>
              </div>
            </>
          )}
          <h3 style={{ marginTop: "2rem" }}>Resources</h3>
          <button
            type="button"
            className="button"
            onClick={runCpuDetect}
            disabled={cpuDetectLoading}
          >
            {cpuDetectLoading ? "Detecting…" : "Detect CPU count"}
          </button>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}
          >
            Detects logical CPU count for display. Does not change config.
          </p>
          <h3 style={{ marginTop: "2rem" }}>Data Management</h3>
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            Clear Redis cache or ClickHouse data. These actions are irreversible.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              className="button"
              onClick={clearRedisData}
              disabled={clearRedisLoading}
            >
              {clearRedisLoading ? "Clearing..." : "Clear Redis cache"}
            </button>
            <button
              className="button"
              onClick={clearClickhouseData}
              disabled={clearClickhouseLoading}
            >
              {clearClickhouseLoading ? "Clearing..." : "Clear ClickHouse data"}
            </button>
          </div>
          {clearRedisError && (
            <div className="error" style={{ marginTop: "0.5rem" }}>
              {clearRedisError}
            </div>
          )}
          {clearClickhouseError && (
            <div className="error" style={{ marginTop: "0.5rem" }}>
              {clearClickhouseError}
            </div>
          )}
        </>
      )}
    </section>
  );
}
