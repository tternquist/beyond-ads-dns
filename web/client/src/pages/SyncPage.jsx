import { SkeletonCard } from "../components/Skeleton.jsx";
import { useSyncState } from "../hooks/useSyncState.js";
import { useAppContext } from "../context/AppContext.jsx";

export default function SyncPage() {
  const { syncStatus, syncError, refreshSyncStatus } = useAppContext();
  const sync = useSyncState(syncStatus, refreshSyncStatus);
  const {
    syncConfigRole,
    setSyncConfigRole,
    syncConfigLoading,
    syncEnableReplicaValidation,
    syncSettingsValidation,
    syncSettingsPrimaryUrl,
    setSyncSettingsPrimaryUrl,
    syncSettingsToken,
    setSyncSettingsToken,
    syncSettingsInterval,
    setSyncSettingsInterval,
    syncSettingsStatsSourceUrl,
    setSyncSettingsStatsSourceUrl,
    enableSyncAsReplica,
    enableSyncAsPrimary,
    saveSyncSettings,
    newTokenName,
    setNewTokenName,
    createSyncToken,
    syncLoading,
    createdToken,
    revokeSyncToken,
    syncSettingsStatus,
    syncSettingsError,
    disableSync,
  } = sync;
  return (
    <section className="section">
      <div className="section-header">
        <h2>Instance Sync</h2>
        {syncStatus?.enabled && (
          <span
            className={`badge ${syncStatus.role === "primary" ? "primary" : "muted"}`}
          >
            {syncStatus.role === "primary" ? "Primary" : "Replica"}
          </span>
        )}
      </div>
      {syncError && <div className="error">{syncError}</div>}
      {!syncStatus ? (
        <div className="grid">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !syncStatus.enabled ? (
        <>
          <h3>Enable Sync</h3>
          <p className="muted">
            Keep multiple instances in sync: one primary (source of truth) and
            replicas that pull config from it.
          </p>
          <div className="form-group">
            <label className="field-label">Role</label>
            <select
              className="input"
              value={syncConfigRole}
              onChange={(e) => setSyncConfigRole(e.target.value)}
              style={{ maxWidth: "280px" }}
            >
              <option value="primary">
                Primary — source of truth for DNS config
              </option>
              <option value="replica">Replica — pulls config from primary</option>
            </select>
          </div>
          {syncConfigRole === "replica" && (
            <>
              <div className="form-group">
                <label className="field-label">Primary URL</label>
                <input
                  className={`input ${
                    syncEnableReplicaValidation.fieldErrors.primaryUrl
                      ? "input-invalid"
                      : ""
                  }`}
                  placeholder="http://primary-host:8081"
                  value={syncSettingsPrimaryUrl}
                  onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
                />
                {syncEnableReplicaValidation.fieldErrors.primaryUrl && (
                  <div className="field-error">
                    {syncEnableReplicaValidation.fieldErrors.primaryUrl}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="field-label">Sync token</label>
                <input
                  className={`input ${
                    syncEnableReplicaValidation.fieldErrors.syncToken
                      ? "input-invalid"
                      : ""
                  }`}
                  type="password"
                  placeholder="Token from primary"
                  value={syncSettingsToken}
                  onChange={(e) => setSyncSettingsToken(e.target.value)}
                />
                {syncEnableReplicaValidation.fieldErrors.syncToken && (
                  <div className="field-error">
                    {syncEnableReplicaValidation.fieldErrors.syncToken}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="field-label">Sync interval</label>
                <input
                  className={`input ${
                    syncEnableReplicaValidation.fieldErrors.syncInterval
                      ? "input-invalid"
                      : ""
                  }`}
                  placeholder="60s"
                  value={syncSettingsInterval}
                  onChange={(e) => setSyncSettingsInterval(e.target.value)}
                />
                {syncEnableReplicaValidation.fieldErrors.syncInterval && (
                  <div className="field-error">
                    {syncEnableReplicaValidation.fieldErrors.syncInterval}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="field-label">Stats source URL (optional)</label>
                <p
                  className="muted"
                  style={{
                    fontSize: "0.85rem",
                    marginTop: 0,
                    marginBottom: "0.5rem",
                  }}
                >
                  URL for this replica&apos;s UI for stats in Multi-Instance view.
                  Leave empty to hide.
                </p>
                <input
                  className="input"
                  placeholder="http://replica-host:8081"
                  value={syncSettingsStatsSourceUrl}
                  onChange={(e) =>
                    setSyncSettingsStatsSourceUrl(e.target.value)
                  }
                />
              </div>
              <button
                className="button primary"
                onClick={enableSyncAsReplica}
                disabled={
                  syncConfigLoading || syncEnableReplicaValidation.hasErrors
                }
              >
                {syncConfigLoading ? "Enabling..." : "Enable as replica"}
              </button>
            </>
          )}
          {syncConfigRole === "primary" && (
            <button
              className="button primary"
              onClick={enableSyncAsPrimary}
              disabled={syncConfigLoading}
            >
              {syncConfigLoading ? "Enabling..." : "Enable as primary"}
            </button>
          )}
        </>
      ) : (
        <>
          <h3>Sync status</h3>
          <p className="muted">
            {syncStatus.role === "primary"
              ? "You are the primary. Replicas pull config from this instance."
              : "You are a replica. Config is synced from the primary."}
          </p>
          {syncStatus.role === "primary" ? (
            <>
              <h4 style={{ marginTop: 0 }}>Replica tokens</h4>
              <p
                className="muted"
                style={{
                  fontSize: "0.85rem",
                  marginTop: 0,
                  marginBottom: "0.5rem",
                }}
              >
                Create tokens for replicas to authenticate. Each token has a name
                (shown in Multi-Instance). Tokens are synced to replicas.
              </p>
              {syncSettingsStatus && (
                <p className="status">{syncSettingsStatus}</p>
              )}
              {syncSettingsError && (
                <div className="error">{syncSettingsError}</div>
              )}
              <div className="form-group">
                <label className="field-label">New token name</label>
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <input
                    className="input"
                    placeholder="e.g. Living Room"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    style={{ maxWidth: "200px" }}
                  />
                  <button
                    className="button"
                    onClick={createSyncToken}
                    disabled={!newTokenName.trim() || syncLoading}
                  >
                    Create token
                  </button>
                </div>
              </div>
              {createdToken && (
                <div className="status" style={{ marginTop: "0.5rem" }}>
                  <strong>Token created:</strong>{" "}
                  <code className="mono">{createdToken}</code>
                  <p
                    className="muted"
                    style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}
                  >
                    Copy this token now. It won&apos;t be shown again.
                  </p>
                </div>
              )}
              <div className="table-wrapper" style={{ marginTop: 16 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncStatus.tokens?.map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td>
                          {t.created_at
                            ? new Date(t.created_at).toLocaleString()
                            : "-"}
                        </td>
                        <td>
                          <button
                            className="button"
                            onClick={() => revokeSyncToken(t.id)}
                            disabled={syncLoading}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(!syncStatus.tokens || syncStatus.tokens.length === 0) && (
                <p className="muted" style={{ marginTop: 16 }}>
                  No tokens yet.
                </p>
              )}
            </>
          ) : (
            <>
              <h4 style={{ marginTop: 0 }}>Replica settings</h4>
              <p
                className="muted"
                style={{
                  fontSize: "0.85rem",
                  marginTop: 0,
                  marginBottom: "0.5rem",
                }}
              >
                Primary URL and sync interval. Restart required after saving.
              </p>
              {syncSettingsStatus && (
                <p className="status">{syncSettingsStatus}</p>
              )}
              {syncSettingsError && (
                <div className="error">{syncSettingsError}</div>
              )}
              <div className="form-group">
                <label className="field-label">Primary URL</label>
                <input
                  className="input"
                  value={syncSettingsPrimaryUrl}
                  onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
                  placeholder="http://primary-host:8081"
                  style={{ maxWidth: "400px" }}
                />
              </div>
              <div className="form-group">
                <label className="field-label">Sync interval</label>
                <input
                  className="input"
                  value={syncSettingsInterval}
                  onChange={(e) => setSyncSettingsInterval(e.target.value)}
                  placeholder="60s"
                  style={{ maxWidth: "120px" }}
                />
              </div>
              <div className="form-group">
                <label className="field-label">Stats source URL</label>
                <input
                  className="input"
                  value={syncSettingsStatsSourceUrl}
                  onChange={(e) =>
                    setSyncSettingsStatsSourceUrl(e.target.value)
                  }
                  placeholder="http://replica-host:8081"
                  style={{ maxWidth: "400px" }}
                />
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  className="button primary"
                  onClick={saveSyncSettings}
                  disabled={syncLoading || syncSettingsValidation?.hasErrors}
                >
                  {syncLoading ? "Saving..." : "Save sync settings"}
                </button>
                <button
                  className="button"
                  onClick={() => disableSync()}
                  disabled={syncLoading}
                >
                  {syncLoading ? "Disabling..." : "Disable sync"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
