export default function SettingsPage({
  systemConfig,
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
            onClick={saveSystemConfig}
            disabled={systemConfigLoading || !systemConfig}
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
        <p className="muted">Loading...</p>
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
          {systemConfig.query_store?.enabled && (
            <div style={{ marginLeft: 20, marginTop: 8 }}>
              <div className="form-group">
                <label className="field-label">Retention (hours)</label>
                <input
                  className="input"
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
              </div>
              <div className="form-group">
                <label className="field-label">Max size (MB, 0=unlimited)</label>
                <input
                  className="input"
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
              className="input"
              type="text"
              value={systemConfig.server?.reuse_port_listeners ?? "1"}
              onChange={(e) =>
                updateSystemConfig(
                  "server",
                  "reuse_port_listeners",
                  e.target.value
                )
              }
              placeholder="1"
              style={{ maxWidth: "80px" }}
            />
          </div>
          {showAdvancedSettings && (
            <>
              <h3 style={{ marginTop: "2rem" }}>Cache</h3>
              <div className="form-group">
                <label className="field-label">Redis LRU size</label>
                <input
                  className="input"
                  type="text"
                  value={systemConfig.cache?.redis_lru_size ?? "10000"}
                  onChange={(e) =>
                    updateSystemConfig("cache", "redis_lru_size", e.target.value)
                  }
                  placeholder="10000"
                  style={{ maxWidth: "120px" }}
                />
              </div>
              <div className="form-group">
                <label className="field-label">Max inflight refreshes</label>
                <input
                  className="input"
                  type="text"
                  value={systemConfig.cache?.max_inflight ?? "100"}
                  onChange={(e) =>
                    updateSystemConfig("cache", "max_inflight", e.target.value)
                  }
                  placeholder="100"
                  style={{ maxWidth: "80px" }}
                />
              </div>
              <div className="form-group">
                <label className="field-label">Max batch size (sweep)</label>
                <input
                  className="input"
                  type="text"
                  value={systemConfig.cache?.max_batch_size ?? "500"}
                  onChange={(e) =>
                    updateSystemConfig(
                      "cache",
                      "max_batch_size",
                      e.target.value
                    )
                  }
                  placeholder="500"
                  style={{ maxWidth: "80px" }}
                />
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
