import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import {
  validateUpstreamsForm,
  validateLocalRecordsForm,
  validateResponseForm,
  isValidDuration,
} from "../utils/validation.js";

/**
 * Per-feature hook for DNS Settings page state.
 * Owns upstreams, local records, response config, safe search.
 */
export function useDnsState() {
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [upstreams, setUpstreams] = useState([]);
  const [resolverStrategy, setResolverStrategy] = useState("failover");
  const [upstreamTimeout, setUpstreamTimeout] = useState("10s");
  const [upstreamBackoff, setUpstreamBackoff] = useState("30s");
  const [upstreamsError, setUpstreamsError] = useState("");
  const [upstreamsStatus, setUpstreamsStatus] = useState("");
  const [upstreamsLoading, setUpstreamsLoading] = useState(false);
  const [localRecords, setLocalRecords] = useState([]);
  const [localRecordsError, setLocalRecordsError] = useState("");
  const [localRecordsStatus, setLocalRecordsStatus] = useState("");
  const [localRecordsLoading, setLocalRecordsLoading] = useState(false);
  const [responseBlocked, setResponseBlocked] = useState("nxdomain");
  const [responseBlockedTtl, setResponseBlockedTtl] = useState("1h");
  const [responseError, setResponseError] = useState("");
  const [responseStatus, setResponseStatus] = useState("");
  const [responseLoading, setResponseLoading] = useState(false);
  const [safeSearchEnabled, setSafeSearchEnabled] = useState(false);
  const [safeSearchGoogle, setSafeSearchGoogle] = useState(true);
  const [safeSearchBing, setSafeSearchBing] = useState(true);
  const [safeSearchError, setSafeSearchError] = useState("");
  const [safeSearchStatus, setSafeSearchStatus] = useState("");
  const [safeSearchLoading, setSafeSearchLoading] = useState(false);

  const upstreamValidation = validateUpstreamsForm(upstreams);
  const localRecordsValidation = validateLocalRecordsForm(localRecords);
  const responseValidation = validateResponseForm({
    blocked: responseBlocked,
    blockedTtl: responseBlockedTtl,
  });

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadLocalRecords = async () => {
      try {
        const data = await api.get("/api/dns/local-records", { signal: controller.signal });
        if (!isMounted) return;
        setLocalRecords(Array.isArray(data.records) ? data.records : []);
        setLocalRecordsError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setLocalRecordsError(err.message || "Failed to load local records");
      }
    };
    const loadUpstreams = async () => {
      try {
        const data = await api.get("/api/dns/upstreams", { signal: controller.signal });
        if (!isMounted) return;
        setUpstreams(Array.isArray(data.upstreams) ? data.upstreams : []);
        setResolverStrategy(data.resolver_strategy || "failover");
        setUpstreamTimeout(data.upstream_timeout || "10s");
        setUpstreamBackoff(data.upstream_backoff || "30s");
        setUpstreamsError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setUpstreamsError(err.message || "Failed to load upstreams");
      }
    };
    const loadResponse = async () => {
      try {
        const data = await api.get("/api/dns/response", { signal: controller.signal });
        if (!isMounted) return;
        setResponseBlocked(data.blocked || "nxdomain");
        setResponseBlockedTtl(data.blocked_ttl || "1h");
        setResponseError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setResponseError(err.message || "Failed to load response config");
      }
    };
    const loadSafeSearch = async () => {
      try {
        const data = await api.get("/api/dns/safe-search", { signal: controller.signal });
        if (!isMounted) return;
        setSafeSearchEnabled(data.enabled ?? false);
        setSafeSearchGoogle(data.google !== false);
        setSafeSearchBing(data.bing !== false);
        setSafeSearchError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setSafeSearchError(err.message || "Failed to load safe search config");
      }
    };
    loadLocalRecords();
    loadUpstreams();
    loadResponse();
    loadSafeSearch();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  const updateUpstream = (index, field, value) => {
    setUpstreams((prev) =>
      prev.map((u, idx) => {
        if (idx !== index) return u;
        const next = { ...u, [field]: value };
        if (field === "address") {
          const addr = String(value || "").trim().toLowerCase();
          if (addr.startsWith("tls://")) next.protocol = "tls";
          else if (addr.startsWith("quic://")) next.protocol = "quic";
          else if (addr.startsWith("https://")) next.protocol = "https";
        }
        return next;
      })
    );
  };

  const addUpstream = () => {
    setUpstreams((prev) => [...prev, { name: "", address: "", protocol: "udp" }]);
  };

  const addSuggestedUpstream = (suggestion) => {
    setUpstreams((prev) => [...prev, { ...suggestion }]);
  };

  const removeUpstream = (index) => {
    setUpstreams((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveUpstreams = async () => {
    setUpstreamsStatus("");
    setUpstreamsError("");
    const validation = validateUpstreamsForm(upstreams);
    if (validation.hasErrors) {
      setUpstreamsError(validation.summary || "Please fix validation errors before saving.");
      return false;
    }
    const normalizedTimeout = (upstreamTimeout || "").trim() || "10s";
    const normalizedBackoff = (upstreamBackoff || "").trim() || "30s";
    if (!isValidDuration(normalizedTimeout)) {
      setUpstreamsError("Upstream timeout must be a positive duration (e.g. 2s, 10s, 30s).");
      return false;
    }
    try {
      setUpstreamsLoading(true);
      const data = await api.put("/api/dns/upstreams", {
        upstreams: validation.normalizedUpstreams,
        resolver_strategy: resolverStrategy,
        upstream_timeout: normalizedTimeout,
        upstream_backoff: normalizedBackoff,
      });
      setUpstreamsStatus("Saved");
      setUpstreams(validation.normalizedUpstreams);
      if (data.upstream_timeout) setUpstreamTimeout(data.upstream_timeout);
      if (data.upstream_backoff !== undefined) setUpstreamBackoff(data.upstream_backoff);
      return true;
    } catch (err) {
      setUpstreamsError(err.message || "Failed to save upstreams");
      return false;
    } finally {
      setUpstreamsLoading(false);
    }
  };

  const applyUpstreams = async () => {
    const saved = await saveUpstreams();
    if (!saved) return;
    try {
      setUpstreamsLoading(true);
      await api.post("/api/dns/upstreams/apply");
      setUpstreamsStatus("Applied");
      addToast("Upstreams applied successfully", "success");
    } catch (err) {
      setUpstreamsError(err.message || "Failed to apply upstreams");
      addToast(err.message || "Failed to apply upstreams", "error");
    } finally {
      setUpstreamsLoading(false);
    }
  };

  const confirmApplyUpstreams = () => {
    confirm({
      title: "Apply upstream changes",
      message: "This will update DNS resolvers immediately. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyUpstreams,
    });
  };

  const updateLocalRecord = (index, field, value) => {
    setLocalRecords((prev) =>
      prev.map((rec, idx) =>
        idx === index ? { ...rec, [field]: value } : rec
      )
    );
  };

  const addLocalRecord = () => {
    setLocalRecords((prev) => [...prev, { name: "", type: "A", value: "" }]);
  };

  const removeLocalRecord = (index) => {
    setLocalRecords((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveLocalRecords = async () => {
    setLocalRecordsStatus("");
    setLocalRecordsError("");
    const validation = validateLocalRecordsForm(localRecords);
    if (validation.hasErrors) {
      setLocalRecordsError(validation.summary || "Please fix validation errors before saving.");
      return false;
    }
    try {
      setLocalRecordsLoading(true);
      const data = await api.put("/api/dns/local-records", {
        records: validation.normalizedRecords,
      });
      setLocalRecordsStatus("Saved");
      setLocalRecords(validation.normalizedRecords);
      return true;
    } catch (err) {
      setLocalRecordsError(err.message || "Failed to save local records");
      return false;
    } finally {
      setLocalRecordsLoading(false);
    }
  };

  const applyLocalRecords = async () => {
    const saved = await saveLocalRecords();
    if (!saved) return;
    try {
      setLocalRecordsLoading(true);
      await api.post("/api/dns/local-records/apply");
      setLocalRecordsStatus("Applied");
      addToast("Local records applied successfully", "success");
    } catch (err) {
      setLocalRecordsError(err.message || "Failed to apply local records");
      addToast(err.message || "Failed to apply local records", "error");
    } finally {
      setLocalRecordsLoading(false);
    }
  };

  const confirmApplyLocalRecords = () => {
    confirm({
      title: "Apply local records",
      message: "This will update local DNS records immediately. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyLocalRecords,
    });
  };

  const saveResponse = async () => {
    setResponseStatus("");
    setResponseError("");
    const validation = validateResponseForm({
      blocked: responseBlocked,
      blockedTtl: responseBlockedTtl,
    });
    if (validation.hasErrors) {
      setResponseError(validation.summary || "Please fix validation errors before saving.");
      return false;
    }
    try {
      setResponseLoading(true);
      const data = await api.put("/api/dns/response", {
        blocked: validation.normalized.blocked,
        blocked_ttl: validation.normalized.blockedTtl,
      });
      setResponseStatus("Saved");
      setResponseBlocked(validation.normalized.blocked);
      setResponseBlockedTtl(validation.normalized.blockedTtl);
      return true;
    } catch (err) {
      setResponseError(err.message || "Failed to save response config");
      return false;
    } finally {
      setResponseLoading(false);
    }
  };

  const applyResponse = async () => {
    const saved = await saveResponse();
    if (!saved) return;
    try {
      setResponseLoading(true);
      await api.post("/api/dns/response/apply");
      setResponseStatus("Applied");
      addToast("Response config applied successfully", "success");
    } catch (err) {
      setResponseError(err.message || "Failed to apply response config");
      addToast(err.message || "Failed to apply response config", "error");
    } finally {
      setResponseLoading(false);
    }
  };

  const confirmApplyResponse = () => {
    confirm({
      title: "Apply blocked response config",
      message: "This will update how blocked domains are responded to. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyResponse,
    });
  };

  const saveSafeSearch = async () => {
    setSafeSearchStatus("");
    setSafeSearchError("");
    try {
      setSafeSearchLoading(true);
      await api.put("/api/dns/safe-search", {
        enabled: safeSearchEnabled,
        google: safeSearchGoogle,
        bing: safeSearchBing,
      });
      setSafeSearchStatus("Saved");
      return true;
    } catch (err) {
      setSafeSearchError(err.message || "Failed to save safe search config");
      return false;
    } finally {
      setSafeSearchLoading(false);
    }
  };

  const applySafeSearch = async () => {
    const saved = await saveSafeSearch();
    if (!saved) return;
    try {
      setSafeSearchLoading(true);
      await api.post("/api/dns/safe-search/apply");
      setSafeSearchStatus("Applied");
      addToast("Safe search applied successfully", "success");
    } catch (err) {
      setSafeSearchError(err.message || "Failed to apply safe search config");
      addToast(err.message || "Failed to apply safe search config", "error");
    } finally {
      setSafeSearchLoading(false);
    }
  };

  const confirmApplySafeSearch = () => {
    confirm({
      title: "Apply safe search config",
      message: "This will update safe search settings. Continue?",
      confirmLabel: "Apply",
      onConfirm: applySafeSearch,
    });
  };

  return {
    upstreams,
    resolverStrategy,
    setResolverStrategy,
    upstreamTimeout,
    setUpstreamTimeout,
    upstreamBackoff,
    setUpstreamBackoff,
    upstreamsError,
    upstreamsStatus,
    upstreamsLoading,
    upstreamValidation,
    saveUpstreams,
    confirmApplyUpstreams,
    updateUpstream,
    removeUpstream,
    addUpstream,
    addSuggestedUpstream,
    localRecords,
    localRecordsError,
    localRecordsStatus,
    localRecordsLoading,
    localRecordsValidation,
    saveLocalRecords,
    confirmApplyLocalRecords,
    updateLocalRecord,
    removeLocalRecord,
    addLocalRecord,
    responseBlocked,
    setResponseBlocked,
    responseBlockedTtl,
    setResponseBlockedTtl,
    responseError,
    responseStatus,
    responseLoading,
    responseValidation,
    saveResponse,
    confirmApplyResponse,
    safeSearchEnabled,
    setSafeSearchEnabled,
    safeSearchGoogle,
    setSafeSearchGoogle,
    safeSearchBing,
    setSafeSearchBing,
    safeSearchError,
    safeSearchStatus,
    safeSearchLoading,
    saveSafeSearch,
    confirmApplySafeSearch,
  };
}
