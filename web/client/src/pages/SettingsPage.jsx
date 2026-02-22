import { SkeletonCard } from "../components/Skeleton.jsx";
import { useSettingsState } from "../hooks/useSettingsState.js";
import AuthSettings from "./settings/AuthSettings.jsx";
import CacheSettings from "./settings/CacheSettings.jsx";
import LoggingSettings from "./settings/LoggingSettings.jsx";

export default function SettingsPage() {
  const settings = useSettingsState();
  const {
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
  } = settings;
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
            <AuthSettings
              canSetInitialPassword={canSetInitialPassword}
              authEnabled={authEnabled}
              adminCurrentPassword={adminCurrentPassword}
              setAdminCurrentPassword={setAdminCurrentPassword}
              adminNewPassword={adminNewPassword}
              setAdminNewPassword={setAdminNewPassword}
              adminConfirmPassword={adminConfirmPassword}
              setAdminConfirmPassword={setAdminConfirmPassword}
              adminPasswordLoading={adminPasswordLoading}
              adminPasswordStatus={adminPasswordStatus}
              adminPasswordError={adminPasswordError}
              handleSetPassword={handleSetPassword}
            />
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
              <CacheSettings
                systemConfig={systemConfig}
                systemConfigValidation={systemConfigValidation}
                updateSystemConfig={updateSystemConfig}
              />
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
              <LoggingSettings
                systemConfig={systemConfig}
                updateSystemConfig={updateSystemConfig}
              />
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
