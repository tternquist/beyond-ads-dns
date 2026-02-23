import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { QUERY_WINDOW_OPTIONS, COLLAPSIBLE_STORAGE_KEY } from "../utils/constants.js";
import { STATUS_LABELS } from "../utils/constants.js";

function loadInitialCollapsed() {
  try {
    const stored = localStorage.getItem(COLLAPSIBLE_STORAGE_KEY);
    if (!stored) return {};
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

/**
 * Per-feature hook for Overview page state.
 * Owns Redis stats, query summary, time series, latency, upstream stats, cache stats.
 */
export function useOverviewState(refreshIntervalMs) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [queryWindowMinutes, setQueryWindowMinutes] = useState(
    QUERY_WINDOW_OPTIONS[1].value
  );
  const [querySummary, setQuerySummary] = useState(null);
  const [querySummaryError, setQuerySummaryError] = useState("");
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [timeSeries, setTimeSeries] = useState(null);
  const [timeSeriesError, setTimeSeriesError] = useState("");
  const [queryLatency, setQueryLatency] = useState(null);
  const [queryLatencyError, setQueryLatencyError] = useState("");
  const [upstreamStats, setUpstreamStats] = useState(null);
  const [upstreamStatsError, setUpstreamStatsError] = useState("");
  const [cacheStats, setCacheStats] = useState(null);
  const [cacheStatsError, setCacheStatsError] = useState("");
  const [collapsedSections, setCollapsedSections] = useState(loadInitialCollapsed);

  const bucketMinutes = queryWindowMinutes <= 15 ? 1 : queryWindowMinutes <= 60 ? 5 : queryWindowMinutes <= 360 ? 15 : 60;

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/redis/summary", { signal: controller.signal });
        if (!isMounted) return;
        setStats(data);
        setUpdatedAt(new Date());
        setError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setError(err.message || "Failed to load stats");
      }
    };
    load();
    const interval = refreshIntervalMs > 0 ? setInterval(load, refreshIntervalMs) : null;
    return () => {
      isMounted = false;
      controller.abort();
      if (interval) clearInterval(interval);
    };
  }, [queryWindowMinutes, refreshIntervalMs]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadSummary = async () => {
      try {
        const data = await api.get(
          `/api/queries/summary?window_minutes=${queryWindowMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setQueryEnabled(Boolean(data.enabled));
        setQuerySummaryError(data.error ? data.error : "");
        setQuerySummary(data.error ? null : data);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setQuerySummaryError(err.message || "Failed to load query summary");
      }
    };
    loadSummary();
    const interval = setInterval(loadSummary, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadTimeSeries = async () => {
      try {
        const data = await api.get(
          `/api/queries/time-series?window_minutes=${queryWindowMinutes}&bucket_minutes=${bucketMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setTimeSeriesError(data.error ? data.error : "");
        setTimeSeries(data.error ? null : data);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setTimeSeriesError(err.message || "Failed to load time-series");
      }
    };
    loadTimeSeries();
    const interval = setInterval(loadTimeSeries, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [queryWindowMinutes, bucketMinutes]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadLatency = async () => {
      try {
        const data = await api.get(
          `/api/queries/latency?window_minutes=${queryWindowMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setQueryEnabled(Boolean(data.enabled));
        setQueryLatencyError(data.error ? data.error : "");
        setQueryLatency(data.error ? null : data);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setQueryLatencyError(err.message || "Failed to load latency stats");
      }
    };
    loadLatency();
    const interval = setInterval(loadLatency, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadUpstreamStats = async () => {
      try {
        const data = await api.get(
          `/api/queries/upstream-stats?window_minutes=${queryWindowMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setUpstreamStatsError(data.error ? data.error : "");
        setUpstreamStats(data.error ? null : data);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setUpstreamStatsError(err.message || "Failed to load upstream stats");
      }
    };
    loadUpstreamStats();
    const interval = setInterval(loadUpstreamStats, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadCacheStats = async () => {
      try {
        const data = await api.get("/api/cache/stats", { signal: controller.signal });
        if (!isMounted) return;
        setCacheStats(data);
        setCacheStatsError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setCacheStatsError(err.message || "Failed to load cache stats");
      }
    };
    loadCacheStats();
    const interval = refreshIntervalMs > 0 ? setInterval(loadCacheStats, refreshIntervalMs) : null;
    return () => {
      isMounted = false;
      controller.abort();
      if (interval) clearInterval(interval);
    };
  }, [refreshIntervalMs]);

  const statusRows = querySummary?.statuses || [];
  const statusTotal = querySummary?.total || 0;
  const statusMap = statusRows.reduce((acc, row) => {
    acc[row.outcome] = row.count;
    return acc;
  }, {});
  const statusOrder = ["cached", "local", "stale", "upstream", "safe_search", "blocked", "upstream_error", "invalid"];
  const statusCards = statusOrder.map((key) => ({
    key,
    label: STATUS_LABELS[key] || key,
    count: statusMap[key] || 0,
  }));
  const otherCount = statusTotal - statusCards.reduce((sum, row) => sum + row.count, 0);
  if (otherCount > 0) {
    statusCards.push({ key: "other", label: "Other", count: otherCount });
  }

  const toggleSection = (id) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(COLLAPSIBLE_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  return {
    stats,
    error,
    updatedAt,
    queryWindowMinutes,
    setQueryWindowMinutes,
    querySummary,
    querySummaryError,
    queryEnabled,
    statusCards,
    statusTotal,
    timeSeries,
    bucketMinutes,
    timeSeriesError,
    queryLatency,
    queryLatencyError,
    upstreamStats,
    upstreamStatsError,
    cacheStats,
    cacheStatsError,
    collapsedSections,
    toggleSection,
  };
}
