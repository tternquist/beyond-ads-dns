import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import {
  validateBlocklistForm,
  validateScheduledPauseForm,
  validateFamilyTimeForm,
} from "../utils/validation.js";
import {
  isDomainBlockedByDenylist,
  getDenylistEntriesBlocking,
  normalizeDomainForBlocklist,
  escapeDomainForRegex,
} from "../utils/blocklist.js";
import { BLOCKLIST_REFRESH_DEFAULT } from "../utils/constants.js";

/**
 * Per-feature hook for blocklist management state.
 * Owns blocklist sources, allowlist, denylist, scheduled pause, family time, health check,
 * and all related API calls and handlers.
 */
export function useBlocklistState() {
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [blocklistSources, setBlocklistSources] = useState([]);
  const [allowlist, setAllowlist] = useState([]);
  const [denylist, setDenylist] = useState([]);
  const [refreshInterval, setRefreshInterval] = useState(BLOCKLIST_REFRESH_DEFAULT);
  const [blocklistStatus, setBlocklistStatus] = useState("");
  const [blocklistError, setBlocklistError] = useState("");
  const [blocklistLoading, setBlocklistLoading] = useState(false);
  const [blocklistStats, setBlocklistStats] = useState(null);
  const [blocklistStatsError, setBlocklistStatsError] = useState("");
  const [scheduledPause, setScheduledPause] = useState({
    enabled: false,
    start: "09:00",
    end: "17:00",
    days: [1, 2, 3, 4, 5],
  });
  const [familyTime, setFamilyTime] = useState({
    enabled: false,
    start: "17:00",
    end: "20:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    services: [],
  });
  const [healthCheck, setHealthCheck] = useState({
    enabled: false,
    fail_on_any: true,
  });
  const [healthCheckResults, setHealthCheckResults] = useState(null);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [refreshStats, setRefreshStats] = useState(null);
  const [refreshStatsError, setRefreshStatsError] = useState("");
  const [pauseStatus, setPauseStatus] = useState(null);
  const [pauseError, setPauseError] = useState("");
  const [pauseLoading, setPauseLoading] = useState(false);

  const blocklistValidation = validateBlocklistForm({
    refreshInterval,
    sources: blocklistSources,
  });
  const scheduledPauseValidation = validateScheduledPauseForm({
    enabled: scheduledPause.enabled,
    start: scheduledPause.start,
    end: scheduledPause.end,
    days: scheduledPause.days,
  });
  const familyTimeValidation = validateFamilyTimeForm({
    enabled: familyTime.enabled,
    start: familyTime.start,
    end: familyTime.end,
    days: familyTime.days,
    services: familyTime.services,
  });

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadBlocklists = async () => {
      try {
        setBlocklistLoading(true);
        const data = await api.get("/api/blocklists", { signal: controller.signal });
        if (!isMounted) return;
        setBlocklistSources(Array.isArray(data.sources) ? data.sources : []);
        setAllowlist(Array.isArray(data.allowlist) ? data.allowlist : []);
        setDenylist(Array.isArray(data.denylist) ? data.denylist : []);
        setRefreshInterval(data.refreshInterval || BLOCKLIST_REFRESH_DEFAULT);
        const sp = data.scheduled_pause;
        setScheduledPause(
          sp && typeof sp.enabled === "boolean"
            ? {
                enabled: sp.enabled,
                start: sp.start || "09:00",
                end: sp.end || "17:00",
                days: Array.isArray(sp.days) ? [...sp.days] : [1, 2, 3, 4, 5],
              }
            : { enabled: false, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }
        );
        const ft = data.family_time;
        setFamilyTime(
          ft && typeof ft.enabled === "boolean"
            ? {
                enabled: ft.enabled,
                start: ft.start || "17:00",
                end: ft.end || "20:00",
                days: Array.isArray(ft.days) ? [...ft.days] : [0, 1, 2, 3, 4, 5, 6],
                services: Array.isArray(ft.services) ? [...ft.services] : [],
              }
            : { enabled: false, start: "17:00", end: "20:00", days: [0, 1, 2, 3, 4, 5, 6], services: [] }
        );
        const hc = data.health_check;
        setHealthCheck(
          hc && typeof hc.enabled === "boolean"
            ? { enabled: hc.enabled, fail_on_any: hc.fail_on_any !== false }
            : { enabled: false, fail_on_any: true }
        );
        setBlocklistError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setBlocklistError(err.message || "Failed to load blocklists");
      } finally {
        if (isMounted) setBlocklistLoading(false);
      }
    };
    loadBlocklists();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadStats = async () => {
      try {
        const data = await api.get("/api/blocklists/stats", { signal: controller.signal });
        if (!isMounted) return;
        setBlocklistStats(data);
        setBlocklistStatsError("");
      } catch (err) {
        if (!isMounted) return;
        setBlocklistStatsError(err.message || "Failed to load blocklist stats");
      }
    };
    loadStats();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadRefreshStats = async () => {
      try {
        const data = await api.get("/api/cache/refresh/stats", { signal: controller.signal });
        if (!isMounted) return;
        setRefreshStats(data);
        setRefreshStatsError("");
      } catch (err) {
        if (!isMounted) return;
        setRefreshStatsError(err.message || "Failed to load refresh stats");
      }
    };
    loadRefreshStats();
    const interval = setInterval(loadRefreshStats, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadPauseStatus = async () => {
      try {
        const data = await api.get("/api/blocklists/pause/status", { signal: controller.signal });
        if (!isMounted) return;
        setPauseStatus(data);
        setPauseError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setPauseError(err.message || "Failed to load pause status");
      }
    };
    loadPauseStatus();
    const interval = setInterval(loadPauseStatus, 5000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  const saveBlocklistsWithLists = async (denylistToSave, allowlistToSave) => {
    setBlocklistStatus("");
    setBlocklistError("");
    const validation = validateBlocklistForm({
      refreshInterval,
      sources: blocklistSources,
    });
    if (validation.hasErrors) {
      setBlocklistError(validation.summary || "Please fix validation errors before saving.");
      addToast(validation.summary || "Failed to update blocklist", "error");
      return false;
    }
    if (scheduledPauseValidation.hasErrors) {
      setBlocklistError(scheduledPauseValidation.summary || "Please fix scheduled pause validation.");
      addToast(scheduledPauseValidation.summary || "Failed to update blocklist", "error");
      return false;
    }
    if (familyTimeValidation.hasErrors) {
      setBlocklistError(familyTimeValidation.summary || "Please fix family time validation.");
      addToast(familyTimeValidation.summary || "Failed to update blocklist", "error");
      return false;
    }
    try {
      setBlocklistLoading(true);
      const body = {
        refreshInterval: validation.normalizedRefreshInterval,
        sources: validation.normalizedSources,
        allowlist: allowlistToSave,
        denylist: denylistToSave,
        scheduled_pause: scheduledPause.enabled
          ? {
              enabled: true,
              start: String(scheduledPause.start || "09:00").trim(),
              end: String(scheduledPause.end || "17:00").trim(),
              days: Array.isArray(scheduledPause.days) ? scheduledPause.days : [],
            }
          : { enabled: false },
        family_time: familyTime.enabled
          ? {
              enabled: true,
              start: String(familyTime.start || "17:00").trim(),
              end: String(familyTime.end || "20:00").trim(),
              days: Array.isArray(familyTime.days) ? familyTime.days : [],
              services: Array.isArray(familyTime.services) ? familyTime.services : [],
            }
          : { enabled: false },
        health_check: {
          enabled: healthCheck.enabled,
          fail_on_any: healthCheck.fail_on_any,
        },
      };
      await api.put("/api/blocklists", body);
      setBlocklistStatus("Saved");
      return true;
    } catch (err) {
      setBlocklistError(err.message || "Failed to update blocklist");
      addToast(err.message || "Failed to update blocklist", "error");
      return false;
    } finally {
      setBlocklistLoading(false);
    }
  };

  const applyBlocklistsReload = async () => {
    try {
      setBlocklistLoading(true);
      await api.post("/api/blocklists/apply");
      setBlocklistStatus("Applied");
      try {
        const statsData = await api.get("/api/blocklists/stats");
        setBlocklistStats(statsData);
      } catch { /* ignore */ }
      return true;
    } catch (err) {
      setBlocklistError(err.message || "Failed to apply blocklists");
      addToast(err.message || "Failed to apply blocklists", "error");
      return false;
    } finally {
      setBlocklistLoading(false);
    }
  };

  const saveBlocklists = async () => {
    setBlocklistStatus("");
    setBlocklistError("");
    const validation = validateBlocklistForm({
      refreshInterval,
      sources: blocklistSources,
    });
    if (validation.hasErrors) {
      setBlocklistError(validation.summary || "Please fix validation errors before saving.");
      return false;
    }
    if (scheduledPauseValidation.hasErrors) {
      setBlocklistError(scheduledPauseValidation.summary || "Please fix scheduled pause validation.");
      return false;
    }
    if (familyTimeValidation.hasErrors) {
      setBlocklistError(familyTimeValidation.summary || "Please fix family time validation.");
      return false;
    }
    try {
      setBlocklistLoading(true);
      const body = {
        refreshInterval: validation.normalizedRefreshInterval,
        sources: validation.normalizedSources,
        allowlist,
        denylist,
        scheduled_pause: scheduledPause.enabled
          ? {
              enabled: true,
              start: String(scheduledPause.start || "09:00").trim(),
              end: String(scheduledPause.end || "17:00").trim(),
              days: Array.isArray(scheduledPause.days) ? scheduledPause.days : [],
            }
          : { enabled: false },
        family_time: familyTime.enabled
          ? {
              enabled: true,
              start: String(familyTime.start || "17:00").trim(),
              end: String(familyTime.end || "20:00").trim(),
              days: Array.isArray(familyTime.days) ? familyTime.days : [],
              services: Array.isArray(familyTime.services) ? familyTime.services : [],
            }
          : { enabled: false },
        health_check: {
          enabled: healthCheck.enabled,
          fail_on_any: healthCheck.fail_on_any,
        },
      };
      await api.put("/api/blocklists", body);
      setBlocklistStatus("Saved");
      return true;
    } catch (err) {
      setBlocklistError(err.message || "Failed to save blocklists");
      return false;
    } finally {
      setBlocklistLoading(false);
    }
  };

  const applyBlocklists = async () => {
    const saved = await saveBlocklists();
    if (!saved) return;
    const applied = await applyBlocklistsReload();
    if (applied) addToast("Blocklists applied successfully", "success");
  };

  const confirmApplyBlocklists = () => {
    confirm({
      title: "Apply blocklist changes",
      message: "This will reload blocklists and may temporarily affect DNS resolution. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyBlocklists,
    });
  };

  const updateSource = (index, field, value) => {
    setBlocklistSources((prev) =>
      prev.map((source, idx) =>
        idx === index ? { ...source, [field]: value } : source
      )
    );
  };

  const addSource = () => {
    setBlocklistSources((prev) => [...prev, { name: "", url: "" }]);
  };

  const addSuggestedBlocklist = (suggestion) => {
    setBlocklistSources((prev) => [...prev, { name: suggestion.name, url: suggestion.url }]);
  };

  const removeSource = (index) => {
    setBlocklistSources((prev) => prev.filter((_, idx) => idx !== index));
  };

  const addDomain = (setter, value) => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return;
    setter((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const removeDomain = (setter, domain) => {
    setter((prev) => prev.filter((item) => item !== domain));
  };

  const toggleServiceBlockingGlobal = async (service, checked) => {
    if (checked) {
      const toAdd = service.domains.filter((d) => !isDomainBlockedByDenylist(d, denylist));
      if (toAdd.length === 0) return;
      const updated = [...denylist, ...toAdd];
      setDenylist(updated);
      const saved = await saveBlocklistsWithLists(updated, allowlist);
      if (saved) {
        const applied = await applyBlocklistsReload();
        if (applied) addToast(`Blocked ${service.name}`, "success");
      }
    } else {
      const toRemove = service.domains.filter((d) => denylist.includes(d));
      if (toRemove.length === 0) return;
      const updated = denylist.filter((d) => !toRemove.includes(d));
      setDenylist(updated);
      const saved = await saveBlocklistsWithLists(updated, allowlist);
      if (saved) {
        const applied = await applyBlocklistsReload();
        if (applied) addToast(`Unblocked ${service.name}`, "success");
      }
    }
  };

  const addDomainToDenylist = async (domain, mode) => {
    const normalized = normalizeDomainForBlocklist(domain);
    if (!normalized) return;
    const entry = mode === "exact"
      ? `/${"^" + escapeDomainForRegex(normalized) + "$"}/`
      : normalized;
    const updated = denylist.includes(entry) ? denylist : [...denylist, entry];
    setDenylist(updated);
    const saved = await saveBlocklistsWithLists(updated, allowlist);
    if (!saved) return;
    const applied = await applyBlocklistsReload();
    if (applied) {
      const label = mode === "exact" ? "exact match" : "domain + subdomains";
      addToast(`Blocked ${normalized} (${label})`, "success");
    }
  };

  const removeDomainFromDenylist = async (domain) => {
    const entriesToRemove = getDenylistEntriesBlocking(domain, denylist);
    if (entriesToRemove.length === 0) return;
    const updated = denylist.filter((d) => !entriesToRemove.includes(d));
    setDenylist(updated);
    const saved = await saveBlocklistsWithLists(updated, allowlist);
    if (!saved) return;
    const applied = await applyBlocklistsReload();
    if (applied) addToast(`Unblocked ${normalizeDomainForBlocklist(domain)}`, "success");
  };

  const addDomainToAllowlist = async (domain) => {
    const normalized = normalizeDomainForBlocklist(domain);
    if (!normalized) return;
    const updated = allowlist.includes(normalized) ? allowlist : [...allowlist, normalized];
    setAllowlist(updated);
    const saved = await saveBlocklistsWithLists(denylist, updated);
    if (!saved) return;
    const applied = await applyBlocklistsReload();
    if (applied) addToast(`Allowed ${normalized}`, "success");
  };

  const pauseBlocking = async (minutes) => {
    setPauseLoading(true);
    setPauseError("");
    try {
      const data = await api.post("/api/blocklists/pause", { duration_minutes: minutes });
      setPauseStatus(data);
    } catch (err) {
      setPauseError(err.message || "Failed to pause blocking");
    } finally {
      setPauseLoading(false);
    }
  };

  const resumeBlocking = async () => {
    setPauseLoading(true);
    setPauseError("");
    try {
      const data = await api.get("/api/blocklists/resume", { method: "POST" });
      setPauseStatus(data);
    } catch (err) {
      setPauseError(err.message || "Failed to resume blocking");
    } finally {
      setPauseLoading(false);
    }
  };

  const checkBlocklistHealth = async () => {
    setHealthCheckLoading(true);
    setHealthCheckResults(null);
    try {
      const data = await api.get("/api/blocklists/health");
      setHealthCheckResults(data);
    } catch (err) {
      setHealthCheckResults({ error: err.message || "Failed to check blocklist health" });
    } finally {
      setHealthCheckLoading(false);
    }
  };

  const toggleScheduledPauseDay = (day) => {
    setScheduledPause((prev) => {
      const days = Array.isArray(prev.days) ? [...prev.days] : [];
      const idx = days.indexOf(day);
      if (idx >= 0) {
        days.splice(idx, 1);
      } else {
        days.push(day);
        days.sort((a, b) => a - b);
      }
      return { ...prev, days };
    });
  };

  const toggleFamilyTimeDay = (day) => {
    setFamilyTime((prev) => {
      const days = Array.isArray(prev.days) ? [...prev.days] : [];
      const idx = days.indexOf(day);
      if (idx >= 0) {
        days.splice(idx, 1);
      } else {
        days.push(day);
        days.sort((a, b) => a - b);
      }
      return { ...prev, days };
    });
  };

  const toggleFamilyTimeService = (serviceId) => {
    setFamilyTime((prev) => {
      const services = Array.isArray(prev.services) ? [...prev.services] : [];
      const idx = services.indexOf(serviceId);
      if (idx >= 0) {
        services.splice(idx, 1);
      } else {
        services.push(serviceId);
        services.sort();
      }
      return { ...prev, services };
    });
  };

  return {
    blocklistSources,
    setBlocklistSources,
    allowlist,
    setAllowlist,
    denylist,
    setDenylist,
    refreshInterval,
    setRefreshInterval,
    blocklistStatus,
    blocklistError,
    blocklistLoading,
    blocklistStats,
    blocklistStatsError,
    blocklistValidation,
    scheduledPauseValidation,
    familyTimeValidation,
    scheduledPause,
    setScheduledPause,
    familyTime,
    setFamilyTime,
    healthCheck,
    setHealthCheck,
    healthCheckResults,
    healthCheckLoading,
    refreshStats,
    refreshStatsError,
    pauseStatus,
    pauseError,
    pauseLoading,
    saveBlocklists,
    confirmApplyBlocklists,
    updateSource,
    addSource,
    addSuggestedBlocklist,
    removeSource,
    addDomain,
    removeDomain,
    toggleServiceBlockingGlobal,
    addDomainToDenylist,
    removeDomainFromDenylist,
    addDomainToAllowlist,
    pauseBlocking,
    resumeBlocking,
    checkBlocklistHealth,
    toggleScheduledPauseDay,
    toggleFamilyTimeDay,
    toggleFamilyTimeService,
    applyBlocklistsReload,
  };
}
