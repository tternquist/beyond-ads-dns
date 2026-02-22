import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import { validateSystemConfig } from "../utils/validation.js";
import { SETTINGS_SHOW_ADVANCED_KEY } from "../utils/constants.js";

function loadSettingsShowAdvanced() {
  try {
    const stored = localStorage.getItem(SETTINGS_SHOW_ADVANCED_KEY);
    if (stored === null) return false;
    return JSON.parse(stored);
  } catch {
    return false;
  }
}

/**
 * Per-feature hook for System Settings page state.
 * Owns system config, auth/password, cache clear, restart, autodetect.
 */
export function useSettingsState() {
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [systemConfig, setSystemConfig] = useState(null);
  const [systemConfigError, setSystemConfigError] = useState("");
  const [systemConfigStatus, setSystemConfigStatus] = useState("");
  const [systemConfigLoading, setSystemConfigLoading] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [passwordEditable, setPasswordEditable] = useState(false);
  const [canSetInitialPassword, setCanSetInitialPassword] = useState(false);
  const [adminCurrentPassword, setAdminCurrentPassword] = useState("");
  const [adminNewPassword, setAdminNewPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");
  const [adminPasswordLoading, setAdminPasswordLoading] = useState(false);
  const [adminPasswordError, setAdminPasswordError] = useState("");
  const [adminPasswordStatus, setAdminPasswordStatus] = useState("");
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(loadSettingsShowAdvanced);
  const [restartLoading, setRestartLoading] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [autodetectLoading, setAutodetectLoading] = useState(false);
  const [cpuDetectLoading, setCpuDetectLoading] = useState(false);
  const [clearRedisLoading, setClearRedisLoading] = useState(false);
  const [clearRedisError, setClearRedisError] = useState("");
  const [clearClickhouseLoading, setClearClickhouseLoading] = useState(false);
  const [clearClickhouseError, setClearClickhouseError] = useState("");

  const systemConfigValidation = validateSystemConfig(systemConfig);

  const loadSystemConfig = async () => {
    try {
      const data = await api.get("/api/system/config");
      setSystemConfig(data);
      setSystemConfigError("");
    } catch (err) {
      setSystemConfigError(err.message || "Failed to load system config");
    }
  };

  useEffect(() => {
    loadSystemConfig();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.get("/api/auth/status", { signal: controller.signal })
      .then((d) => {
        setAuthEnabled(d.authEnabled ?? false);
        setPasswordEditable(d.passwordEditable ?? false);
        setCanSetInitialPassword(d.canSetInitialPassword ?? false);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const toggleShowAdvancedSettings = () => {
    setShowAdvancedSettings((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SETTINGS_SHOW_ADVANCED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const updateSystemConfig = (section, field, value) => {
    setSystemConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      if (field == null) {
        next[section] = value;
      } else {
        next[section] = { ...(next[section] || {}), [field]: value };
      }
      return next;
    });
  };

  const saveSystemConfig = async (opts = {}) => {
    const { skipRestartPrompt = false } = opts;
    setSystemConfigStatus("");
    setSystemConfigError("");
    if (!systemConfig) return;
    const validation = validateSystemConfig(systemConfig);
    if (validation.hasErrors) {
      setSystemConfigError(validation.summary || "Please fix validation errors before saving.");
      addToast(validation.summary || "Fix validation errors before saving", "error");
      return;
    }
    try {
      setSystemConfigLoading(true);
      const data = await api.put("/api/system/config", systemConfig);
      setSystemConfigStatus(data.message || "Saved.");
      try {
        await api.post("/api/client-identification/apply");
        setSystemConfigStatus("Saved. Client Identification applied.");
      } catch { /* ignore */ }
      if (!skipRestartPrompt) {
        showRestartRequiredPrompt(
          "Settings saved. Server, Cache, Query Store, Control, Application Logging, Request Log, and UI changes require a restart to take effect. Restart now?"
        );
      }
    } catch (err) {
      setSystemConfigError(err.message || "Failed to save system config");
    } finally {
      setSystemConfigLoading(false);
    }
  };

  const restartService = async () => {
    setRestartError("");
    setRestartLoading(true);
    try {
      await api.post("/api/restart");
      addToast("Service is restarting...", "info");
    } catch (err) {
      setRestartError(err.message || "Failed to restart service");
      addToast(err.message || "Failed to restart service", "error");
      setRestartLoading(false);
    }
  };

  const showRestartRequiredPrompt = (message) => {
    confirm({
      title: "Restart required",
      message: message || "Changes have been saved. Restart the service to apply them. Restart now?",
      confirmLabel: "Restart",
      cancelLabel: "Later",
      variant: "danger",
      onConfirm: restartService,
    });
  };

  const confirmRestartService = () => {
    confirm({
      title: "Restart service",
      message: "This will restart the DNS service. The dashboard may be briefly unavailable. Continue?",
      confirmLabel: "Restart",
      variant: "danger",
      onConfirm: restartService,
    });
  };

  const runAutodetectResourceSettings = async () => {
    setAutodetectLoading(true);
    try {
      const data = await api.get("/api/system/resources");
      const { cpuCount, totalMemoryMB, containerMemoryLimitMB, raspberryPiModel, recommended } = data;
      const memStr = containerMemoryLimitMB != null
        ? `${containerMemoryLimitMB} MB RAM (container limit)`
        : `${totalMemoryMB} MB RAM`;
      const hwStr = raspberryPiModel === "pi4"
        ? `Raspberry Pi 4, ${cpuCount} CPU cores, ${memStr}`
        : raspberryPiModel === "pi5"
          ? `Raspberry Pi 5, ${cpuCount} CPU cores, ${memStr}`
          : raspberryPiModel === "pi_other"
            ? `Raspberry Pi (Pi 3 or older), ${cpuCount} CPU cores, ${memStr}`
            : `${cpuCount} CPU cores, ${memStr}`;
      const msg = `Detected: ${hwStr}.\n\nRecommended:\n• Reuse port listeners: ${recommended.reuse_port_listeners}\n• L0 cache (Redis LRU): ${recommended.redis_lru_size.toLocaleString()}\n• Max concurrent refreshes: ${recommended.max_inflight}\n• Sweep batch size: ${recommended.max_batch_size}\n• Query store batch size: ${recommended.query_store_batch_size}\n\nApply these values to the form? You can still edit before saving.`;
      confirm({
        title: "Auto-detect resource settings",
        message: msg,
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        variant: "primary",
        onConfirm: () => {
          updateSystemConfig("server", "reuse_port_listeners", recommended.reuse_port_listeners);
          updateSystemConfig("cache", "redis_lru_size", recommended.redis_lru_size);
          updateSystemConfig("cache", "max_inflight", recommended.max_inflight);
          updateSystemConfig("cache", "max_batch_size", recommended.max_batch_size);
          updateSystemConfig("query_store", "batch_size", recommended.query_store_batch_size);
          addToast("Recommended settings applied. Click Save to persist.", "success");
        },
      });
    } catch (err) {
      addToast(err.message || "Failed to detect resources", "error");
    } finally {
      setAutodetectLoading(false);
    }
  };

  const runCpuDetect = async () => {
    setCpuDetectLoading(true);
    try {
      const data = await api.get("/api/system/cpu-count");
      const count = data?.cpuCount ?? "?";
      addToast(`Detected ${count} CPU core(s)`, "success");
    } catch (err) {
      addToast(err.message || "Failed to detect CPU count", "error");
    } finally {
      setCpuDetectLoading(false);
    }
  };

  const clearRedisCache = async () => {
    if (!confirm("Clear all DNS cache entries from Redis? This will remove cached responses and metadata. Continue?")) return;
    setClearRedisError("");
    try {
      setClearRedisLoading(true);
      await api.post("/api/system/clear/redis");
      addToast("Redis cache cleared", "success");
    } catch (err) {
      setClearRedisError(err.message || "Failed to clear Redis cache");
      addToast(err.message || "Failed to clear Redis cache", "error");
    } finally {
      setClearRedisLoading(false);
    }
  };

  const clearClickhouseData = async () => {
    if (!confirm("Clear all query data from ClickHouse? This will permanently delete all stored DNS query records. Continue?")) return;
    setClearClickhouseError("");
    try {
      setClearClickhouseLoading(true);
      await api.post("/api/system/clear/clickhouse");
      addToast("ClickHouse data cleared", "success");
    } catch (err) {
      setClearClickhouseError(err.message || "Failed to clear ClickHouse");
      addToast(err.message || "Failed to clear ClickHouse", "error");
    } finally {
      setClearClickhouseLoading(false);
    }
  };

  const saveAdminPassword = async () => {
    setAdminPasswordError("");
    setAdminPasswordStatus("");
    const newPwd = adminNewPassword.trim();
    const confirmPwd = adminConfirmPassword.trim();
    if (newPwd.length < 6) {
      setAdminPasswordError("Password must be at least 6 characters");
      return;
    }
    if (newPwd !== confirmPwd) {
      setAdminPasswordError("New password and confirmation do not match");
      return;
    }
    if (authEnabled && !adminCurrentPassword.trim()) {
      setAdminPasswordError("Current password is required");
      return;
    }
    setAdminPasswordLoading(true);
    try {
      const data = await api.post("/api/auth/set-password", {
        currentPassword: authEnabled ? adminCurrentPassword : undefined,
        newPassword: newPwd,
      });
      setAdminPasswordStatus(data.message || "Password updated successfully");
      setAdminCurrentPassword("");
      setAdminNewPassword("");
      setAdminConfirmPassword("");
      if (!authEnabled) {
        setAuthEnabled(true);
        setCanSetInitialPassword(false);
        addToast("Password set. You will need to log in.", "info");
        window.location.reload();
      }
    } catch (err) {
      setAdminPasswordError(err.message || "Failed to set password");
    } finally {
      setAdminPasswordLoading(false);
    }
  };

  return {
    systemConfig,
    setSystemConfig,
    systemConfigValidation,
    systemConfigLoading,
    systemConfigStatus,
    systemConfigError,
    saveSystemConfig,
    loadSystemConfig,
    updateSystemConfig,
    confirmRestartService,
    restartLoading,
    restartError,
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
    handleSetPassword: saveAdminPassword,
    runCpuDetect,
    cpuDetectLoading,
    clearRedisData: clearRedisCache,
    clearRedisLoading,
    clearClickhouseData,
    clearClickhouseLoading,
    clearRedisError,
    clearClickhouseError,
    showRestartRequiredPrompt,
  };
}
