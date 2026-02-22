import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { useToast } from "../context/ToastContext.jsx";
import { isDomainBlockedByDenylist } from "../utils/blocklist.js";

/**
 * Per-feature hook for Clients page state.
 * Owns system config (for client groups), discovered clients, toggleServiceBlockingForGroup.
 */
export function useClientsState(applyBlocklistsReload) {
  const { addToast } = useToast();

  const [systemConfig, setSystemConfig] = useState(null);
  const [systemConfigError, setSystemConfigError] = useState("");
  const [systemConfigStatus, setSystemConfigStatus] = useState("");
  const [systemConfigLoading, setSystemConfigLoading] = useState(false);
  const [discoveredClients, setDiscoveredClients] = useState(null);
  const [discoverClientsLoading, setDiscoverClientsLoading] = useState(false);
  const [discoverClientsError, setDiscoverClientsError] = useState("");

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/system/config", { signal: controller.signal });
        if (!isMounted) return;
        setSystemConfig(data);
        setSystemConfigError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setSystemConfigError(err.message || "Failed to load system config");
      }
    };
    load();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

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
    const { skipRestartPrompt = true } = opts; // Clients page: client identification applies immediately, no restart needed
    setSystemConfigStatus("");
    setSystemConfigError("");
    if (!systemConfig) return;
    try {
      setSystemConfigLoading(true);
      const data = await api.put("/api/system/config", systemConfig);
      setSystemConfigStatus(data.message || "Saved.");
      try {
        await api.post("/api/client-identification/apply");
        setSystemConfigStatus("Saved. Client Identification applied.");
      } catch { /* ignore */ }
    } catch (err) {
      setSystemConfigError(err.message || "Failed to save system config");
    } finally {
      setSystemConfigLoading(false);
    }
  };

  const onDiscoverClients = async () => {
    setDiscoverClientsLoading(true);
    setDiscoverClientsError("");
    try {
      const data = await api.get("/api/clients/discovery?window_minutes=60");
      setDiscoveredClients(data.enabled ? (data.discovered || []) : null);
      if (!data.enabled) setDiscoverClientsError("Query store is not enabled");
    } catch (err) {
      setDiscoveredClients(null);
      setDiscoverClientsError(err.message || "Failed to discover clients");
    } finally {
      setDiscoverClientsLoading(false);
    }
  };

  const toggleServiceBlockingForGroup = async (groupIndex, service, checked) => {
    if (!systemConfig) return;
    const groups = [...(systemConfig.client_groups || [])];
    const g = groups[groupIndex];
    const currentDenylist = g.blocklist?.denylist || [];
    if (checked) {
      const toAdd = service.domains.filter((d) => !isDomainBlockedByDenylist(d, currentDenylist));
      if (toAdd.length === 0) return;
      const updated = [...currentDenylist, ...toAdd];
      groups[groupIndex] = {
        ...g,
        blocklist: { ...(g.blocklist || {}), inherit_global: false, denylist: updated },
      };
    } else {
      const toRemove = service.domains.filter((d) => currentDenylist.includes(d));
      if (toRemove.length === 0) return;
      const updated = currentDenylist.filter((d) => !toRemove.includes(d));
      groups[groupIndex] = {
        ...g,
        blocklist: { ...(g.blocklist || {}), inherit_global: false, denylist: updated },
      };
    }
    const updatedConfig = { ...systemConfig, client_groups: groups };
    setSystemConfig(updatedConfig);
    try {
      await api.put("/api/system/config", updatedConfig);
      const applied = applyBlocklistsReload ? await applyBlocklistsReload() : false;
      if (applied) addToast(checked ? `Blocked ${service.name} for group` : `Unblocked ${service.name} for group`, "success");
    } catch (err) {
      addToast(err.message || "Failed to save", "error");
    }
  };

  return {
    systemConfig,
    systemConfigLoading,
    systemConfigStatus,
    systemConfigError,
    updateSystemConfig,
    saveSystemConfig,
    discoveredClients,
    setDiscoveredClients,
    discoverClientsLoading,
    discoverClientsError,
    onDiscoverClients,
    toggleServiceBlockingForGroup,
  };
}
