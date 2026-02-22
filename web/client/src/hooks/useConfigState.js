import { useEffect, useState } from "react";
import { parse as parseYAML } from "yaml";
import { api } from "../utils/apiClient.js";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";

/**
 * Per-feature hook for Config page state.
 * Owns active config, import/export, restart.
 */
export function useConfigState() {
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [activeConfig, setActiveConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importError, setImportError] = useState("");
  const [configExportExcludeInstanceDetails, setConfigExportExcludeInstanceDetails] = useState(true);
  const [restartLoading, setRestartLoading] = useState(false);
  const [restartError, setRestartError] = useState("");

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/config", { signal: controller.signal });
        if (!isMounted) return;
        setActiveConfig(data);
        setConfigError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setConfigError(err.message || "Failed to load config");
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  const exportConfig = () => {
    const exclude = configExportExcludeInstanceDetails ? "true" : "false";
    window.location.href = `/api/config/export?exclude_instance_details=${exclude}`;
  };

  const importConfig = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportStatus("");
    setImportError("");

    try {
      const text = await file.text();
      const parsed = parseYAML(text);
      await api.post("/api/config/import", parsed);
      setImportStatus("Config imported successfully.");
      showRestartRequiredPrompt(
        "Config imported successfully. Restart the application to apply changes."
      );
      try {
        const configData = await api.get("/api/config");
        setActiveConfig(configData);
      } catch { /* ignore */ }
    } catch (err) {
      setImportError(err.message || "Failed to import config");
    }
    event.target.value = "";
  };

  const restartService = async () => {
    setRestartError("");
    setRestartLoading(true);
    try {
      await api.post("/api/restart");
      setImportStatus("Service is restarting. The page will reconnect when it is back.");
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

  return {
    activeConfig,
    configError,
    importStatus,
    importError,
    configExportExcludeInstanceDetails,
    setConfigExportExcludeInstanceDetails,
    restartLoading,
    restartError,
    exportConfig,
    importConfig,
    confirmRestartService,
  };
}
