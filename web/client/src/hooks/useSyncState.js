import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { validateReplicaSyncSettings } from "../utils/validation.js";
import { EMPTY_SYNC_VALIDATION } from "../utils/constants.js";

/**
 * Per-feature hook for Sync page state.
 * Owns sync config, tokens, replica settings. Uses syncStatus and refresh from useSyncStatus.
 */
export function useSyncState(syncStatus, refreshSyncStatus) {
  const [syncConfigRole, setSyncConfigRole] = useState("primary");
  const [syncConfigLoading, setSyncConfigLoading] = useState(false);
  const [syncConfigStatus, setSyncConfigStatus] = useState("");
  const [syncConfigError, setSyncConfigError] = useState("");
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncSettingsPrimaryUrl, setSyncSettingsPrimaryUrl] = useState("");
  const [syncSettingsToken, setSyncSettingsToken] = useState("");
  const [syncSettingsInterval, setSyncSettingsInterval] = useState("60s");
  const [syncSettingsStatsSourceUrl, setSyncSettingsStatsSourceUrl] = useState("");
  const [syncSettingsStatus, setSyncSettingsStatus] = useState("");
  const [syncSettingsError, setSyncSettingsError] = useState("");

  const syncEnableReplicaValidation =
    syncConfigRole === "replica"
      ? validateReplicaSyncSettings({
          primaryUrl: syncSettingsPrimaryUrl,
          syncToken: syncSettingsToken,
          syncInterval: syncSettingsInterval,
          requireToken: true,
        })
      : EMPTY_SYNC_VALIDATION;
  const syncSettingsValidation = validateReplicaSyncSettings({
    primaryUrl: syncSettingsPrimaryUrl,
    syncToken: syncSettingsToken,
    syncInterval: syncSettingsInterval,
    requireToken: false,
  });

  useEffect(() => {
    if (syncStatus?.role === "replica") {
      setSyncSettingsPrimaryUrl(syncStatus.primary_url || "");
      setSyncSettingsToken("");
      setSyncSettingsInterval(syncStatus.sync_interval || "60s");
      setSyncSettingsStatsSourceUrl(syncStatus.stats_source_url || "");
    }
  }, [syncStatus?.role, syncStatus?.primary_url, syncStatus?.sync_interval, syncStatus?.stats_source_url]);

  const createSyncToken = async () => {
    setSyncLoading(true);
    setCreatedToken(null);
    try {
      const data = await api.post("/api/sync/tokens", { name: newTokenName || "Replica" });
      setCreatedToken(data.token);
      setNewTokenName("");
      refreshSyncStatus?.();
      return data;
    } catch (err) {
      throw err;
    } finally {
      setSyncLoading(false);
    }
  };

  const revokeSyncToken = async (index) => {
    setSyncLoading(true);
    try {
      await api.del(`/api/sync/tokens/${index}`);
      refreshSyncStatus?.();
    } catch (err) {
      throw err;
    } finally {
      setSyncLoading(false);
    }
  };

  const saveSyncSettings = async () => {
    setSyncSettingsStatus("");
    setSyncSettingsError("");
    const validation = validateReplicaSyncSettings({
      primaryUrl: syncSettingsPrimaryUrl,
      syncToken: syncSettingsToken,
      syncInterval: syncSettingsInterval,
      requireToken: false,
    });
    if (validation.hasErrors) {
      setSyncSettingsError(validation.summary || "Please fix validation errors before saving.");
      return;
    }
    const body = {
      primary_url: validation.normalized.primaryUrl,
      sync_interval: validation.normalized.syncInterval,
    };
    if (validation.normalized.syncToken) {
      body.sync_token = validation.normalized.syncToken;
    }
    if (syncSettingsStatsSourceUrl.trim()) {
      body.stats_source_url = syncSettingsStatsSourceUrl.trim();
    }
    try {
      const data = await api.put("/api/sync/settings", body);
      setSyncSettingsStatus(data.message || "Saved");
      refreshSyncStatus?.();
      return data;
    } catch (err) {
      setSyncSettingsError(err.message || "Failed to save sync settings");
    }
  };

  const saveSyncConfig = async (enabled, role, replicaSettings = null) => {
    setSyncConfigStatus("");
    setSyncConfigError("");
    const body = { enabled, role };
    if (enabled && role === "replica") {
      const validation = validateReplicaSyncSettings({
        primaryUrl: replicaSettings?.primary_url,
        syncToken: replicaSettings?.sync_token,
        syncInterval: replicaSettings?.sync_interval,
        requireToken: true,
      });
      if (validation.hasErrors) {
        setSyncConfigError(validation.summary || "Please fix validation errors before saving.");
        return;
      }
      body.primary_url = validation.normalized.primaryUrl;
      body.sync_token = validation.normalized.syncToken;
      body.sync_interval = validation.normalized.syncInterval;
      if (replicaSettings?.stats_source_url?.trim()) {
        body.stats_source_url = replicaSettings.stats_source_url.trim();
      }
    }
    try {
      setSyncConfigLoading(true);
      const data = await api.put("/api/sync/config", body);
      setSyncConfigStatus(data.message || "Saved");
      refreshSyncStatus?.();
      return data;
    } catch (err) {
      setSyncConfigError(err.message || "Failed to save sync config");
    } finally {
      setSyncConfigLoading(false);
    }
  };

  const disableSync = async () => {
    if (!confirm("Disable sync? Replicas will stop receiving config updates.")) return;
    await saveSyncConfig(false, syncStatus?.role || "primary");
  };

  const enableSyncAsReplica = () =>
    saveSyncConfig(true, "replica", {
      primary_url: syncSettingsPrimaryUrl,
      sync_token: syncSettingsToken,
      sync_interval: syncSettingsInterval,
      stats_source_url: syncSettingsStatsSourceUrl,
    });

  const enableSyncAsPrimary = () => saveSyncConfig(true, "primary");

  return {
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
    syncConfigStatus,
    syncConfigError,
    saveSyncConfig,
  };
}
