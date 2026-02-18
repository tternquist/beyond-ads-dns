import { useEffect, useState } from "react";
import { useLocation, useNavigate, NavLink } from "react-router-dom";
import { parse as parseYAML } from "yaml";
import { getStoredTheme, setTheme } from "./theme.js";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import {
  REFRESH_OPTIONS,
  REFRESH_MS,
  QUERY_WINDOW_OPTIONS,
  BLOCKLIST_REFRESH_DEFAULT,
  DAY_LABELS,
  BLOCKLIST_PRESETS,
  TABS,
  SUPPORTED_LOCAL_RECORD_TYPES,
  EMPTY_SYNC_VALIDATION,
  METRIC_TOOLTIPS,
  STATUS_LABELS,
  OUTCOME_COLORS,
  UPSTREAM_COLORS,
  QUERY_FILTER_PRESETS,
  COLLAPSIBLE_STORAGE_KEY,
  SIDEBAR_COLLAPSED_KEY,
} from "./utils/constants.js";
import { formatNumber, formatUtcToLocalTime, formatUtcToLocalDateTime, formatPercent, formatPctFromDistribution, formatErrorPctFromDistribution, parseSlogMessage } from "./utils/format.js";
import {
  validateBlocklistForm,
  validateScheduledPauseForm,
  validateUpstreamsForm,
  validateLocalRecordsForm,
  validateReplicaSyncSettings,
  validateResponseForm,
  getRowErrorText,
  isValidDuration,
} from "./utils/validation.js";
import { buildQueryParams } from "./utils/queryParams.js";
import Tooltip from "./components/Tooltip.jsx";
import CollapsibleSection from "./components/CollapsibleSection.jsx";
import { TabIcon } from "./components/SidebarIcons.jsx";
import AppLogo from "./components/AppLogo.jsx";
import StatCard from "./components/StatCard.jsx";
import DonutChart from "./components/DonutChart.jsx";
import FilterInput from "./components/FilterInput.jsx";
import DomainEditor from "./components/DomainEditor.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import ConfigViewer from "./components/ConfigViewer.jsx";
import { useToast } from "./context/ToastContext.jsx";
import { SkeletonCard, EmptyState } from "./components/Skeleton.jsx";

function loadInitialCollapsed() {
  try {
    const stored = localStorage.getItem(COLLAPSIBLE_STORAGE_KEY);
    if (!stored) return {};
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

function loadSidebarCollapsed() {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored === null) return true; // default collapsed on mobile
    return JSON.parse(stored);
  } catch {
    return true;
  }
}

function formatUptime(ms) {
  if (ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (seconds % 60 > 0 && hours === 0) parts.push(`${seconds % 60}s`);
  return parts.length ? parts.join(" ") : "0s";
}

function formatStatsWindow(sec) {
  if (!sec || sec <= 0) return "";
  const minutes = Math.round(sec / 60);
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export default function App() {
  const { addToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = location.pathname.replace(/^\//, "") || "overview";
  const setActiveTab = (tab) => navigate(tab === "overview" ? "/" : `/${tab}`);
  const [themePreference, setThemePreference] = useState(() => getStoredTheme());
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [queryRows, setQueryRows] = useState([]);
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [queryTotal, setQueryTotal] = useState(0);
  const [queryPage, setQueryPage] = useState(1);
  const [queryPageSize, setQueryPageSize] = useState(25);
  const [querySortBy, setQuerySortBy] = useState("ts");
  const [querySortDir, setQuerySortDir] = useState("desc");
  const [filterQName, setFilterQName] = useState("");
  const [filterOutcome, setFilterOutcome] = useState("");
  const [filterRcode, setFilterRcode] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterQtype, setFilterQtype] = useState("");
  const [filterProtocol, setFilterProtocol] = useState("");
  const [filterSinceMinutes, setFilterSinceMinutes] = useState("");
  const [filterMinLatency, setFilterMinLatency] = useState("");
  const [filterMaxLatency, setFilterMaxLatency] = useState("");
  const [querySummary, setQuerySummary] = useState(null);
  const [queryLatency, setQueryLatency] = useState(null);
  const [querySummaryError, setQuerySummaryError] = useState("");
  const [queryLatencyError, setQueryLatencyError] = useState("");
  const [timeSeries, setTimeSeries] = useState(null);
  const [timeSeriesError, setTimeSeriesError] = useState("");
  const [upstreamStats, setUpstreamStats] = useState(null);
  const [upstreamStatsError, setUpstreamStatsError] = useState("");
  const [queryWindowMinutes, setQueryWindowMinutes] = useState(
    QUERY_WINDOW_OPTIONS[1].value
  );
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(REFRESH_MS);
  const [collapsedSections, setCollapsedSections] = useState(loadInitialCollapsed);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [filterOptions, setFilterOptions] = useState(null);
  const [filterOptionsError, setFilterOptionsError] = useState("");
  const [blocklistSources, setBlocklistSources] = useState([]);
  const [allowlist, setAllowlist] = useState([]);
  const [denylist, setDenylist] = useState([]);
  const [refreshInterval, setRefreshInterval] = useState(
    BLOCKLIST_REFRESH_DEFAULT
  );
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
  const [healthCheck, setHealthCheck] = useState({
    enabled: false,
    fail_on_any: true,
  });
  const [healthCheckResults, setHealthCheckResults] = useState(null);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [showBlocklistRecommendations, setShowBlocklistRecommendations] = useState(false);
  const [refreshStats, setRefreshStats] = useState(null);
  const [refreshStatsError, setRefreshStatsError] = useState("");
  const [activeConfig, setActiveConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importError, setImportError] = useState("");
  const [configExportExcludeInstanceDetails, setConfigExportExcludeInstanceDetails] = useState(true);
  const [restartLoading, setRestartLoading] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [hostname, setHostname] = useState("");
  const [appInfo, setAppInfo] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [pauseStatus, setPauseStatus] = useState(null);
  const [pauseError, setPauseError] = useState("");
  const [pauseLoading, setPauseLoading] = useState(false);
  const [cacheStats, setCacheStats] = useState(null);
  const [cacheStatsError, setCacheStatsError] = useState("");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [localRecords, setLocalRecords] = useState([]);
  const [localRecordsError, setLocalRecordsError] = useState("");
  const [localRecordsStatus, setLocalRecordsStatus] = useState("");
  const [localRecordsLoading, setLocalRecordsLoading] = useState(false);
  const [upstreams, setUpstreams] = useState([]);
  const [resolverStrategy, setResolverStrategy] = useState("failover");
  const [upstreamTimeout, setUpstreamTimeout] = useState("10s");
  const [upstreamsError, setUpstreamsError] = useState("");
  const [upstreamsStatus, setUpstreamsStatus] = useState("");
  const [upstreamsLoading, setUpstreamsLoading] = useState(false);
  const [responseBlocked, setResponseBlocked] = useState("nxdomain");
  const [responseBlockedTtl, setResponseBlockedTtl] = useState("1h");
  const [responseError, setResponseError] = useState("");
  const [safeSearchEnabled, setSafeSearchEnabled] = useState(false);
  const [safeSearchGoogle, setSafeSearchGoogle] = useState(true);
  const [safeSearchBing, setSafeSearchBing] = useState(true);
  const [safeSearchStatus, setSafeSearchStatus] = useState("");
  const [safeSearchError, setSafeSearchError] = useState("");
  const [safeSearchLoading, setSafeSearchLoading] = useState(false);
  const [responseStatus, setResponseStatus] = useState("");
  const [responseLoading, setResponseLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncError, setSyncError] = useState("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState(null);
  const [syncSettingsPrimaryUrl, setSyncSettingsPrimaryUrl] = useState("");
  const [syncSettingsToken, setSyncSettingsToken] = useState("");
  const [syncSettingsInterval, setSyncSettingsInterval] = useState("60s");
  const [syncSettingsStatsSourceUrl, setSyncSettingsStatsSourceUrl] = useState("");
  const [syncSettingsStatus, setSyncSettingsStatus] = useState("");
  const [syncSettingsError, setSyncSettingsError] = useState("");
  const [syncConfigRole, setSyncConfigRole] = useState("primary");
  const [syncConfigLoading, setSyncConfigLoading] = useState(false);
  const [syncConfigStatus, setSyncConfigStatus] = useState("");
  const [syncConfigError, setSyncConfigError] = useState("");
  const [systemConfig, setSystemConfig] = useState(null);
  const [systemConfigError, setSystemConfigError] = useState("");
  const [systemConfigStatus, setSystemConfigStatus] = useState("");
  const [systemConfigLoading, setSystemConfigLoading] = useState(false);
  const [cpuDetectLoading, setCpuDetectLoading] = useState(false);
  const [clearRedisLoading, setClearRedisLoading] = useState(false);
  const [clearRedisError, setClearRedisError] = useState("");
  const [clearClickhouseLoading, setClearClickhouseLoading] = useState(false);
  const [clearClickhouseError, setClearClickhouseError] = useState("");
  const [confirmState, setConfirmState] = useState({ open: false });
  const [instanceStats, setInstanceStats] = useState(null);
  const [instanceStatsError, setInstanceStatsError] = useState("");
  const [instanceStatsUpdatedAt, setInstanceStatsUpdatedAt] = useState(null);
  const [appErrors, setAppErrors] = useState([]);
  const [appErrorsError, setAppErrorsError] = useState("");
  const [appErrorsLoading, setAppErrorsLoading] = useState(false);
  const [errorSortBy, setErrorSortBy] = useState("date");
  const [errorSortDir, setErrorSortDir] = useState("desc");
  const [errorFilterText, setErrorFilterText] = useState("");
  const [errorSeverityFilter, setErrorSeverityFilter] = useState("all");
  const [errorPage, setErrorPage] = useState(1);
  const [errorPageSize, setErrorPageSize] = useState(25);
  const [errorLogLevel, setErrorLogLevel] = useState("warning");
  const [errorLogLevelSaving, setErrorLogLevelSaving] = useState(false);
  const [errorLogLevelStatus, setErrorLogLevelStatus] = useState("");
  const [webhooksData, setWebhooksData] = useState(null);
  const [webhooksError, setWebhooksError] = useState("");
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [webhooksStatus, setWebhooksStatus] = useState("");
  const [webhookTestResult, setWebhookTestResult] = useState(null);
  const isReplica = syncStatus?.role === "replica" && syncStatus?.enabled;
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
  const upstreamValidation = validateUpstreamsForm(upstreams);
  const localRecordsValidation = validateLocalRecordsForm(localRecords);
  const responseValidation = validateResponseForm({
    blocked: responseBlocked,
    blockedTtl: responseBlockedTtl,
  });
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

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.reload();
    }
  };

  useEffect(() => {
    fetch("/api/auth/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAuthEnabled(d.authEnabled ?? false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/sync/status");
        if (!response.ok) throw new Error(`Sync status failed: ${response.status}`);
        const data = await response.json();
        if (!isMounted) return;
        setSyncStatus(data);
        setSyncError("");
      } catch (err) {
        if (!isMounted) return;
        setSyncStatus(null);
        setSyncError(err.message || "Failed to load sync status");
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/redis/summary");
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setStats(data);
        setUpdatedAt(new Date());
        setError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setError(err.message || "Failed to load stats");
      }
    };
    load();
    const interval = refreshIntervalMs > 0 ? setInterval(load, refreshIntervalMs) : null;
    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [queryWindowMinutes, refreshIntervalMs]);

  useEffect(() => {
    let isMounted = true;
    const loadQueries = async () => {
      try {
        const params = buildQueryParams({
          queryPage,
          queryPageSize,
          querySortBy,
          querySortDir,
          filterQName,
          filterOutcome,
          filterRcode,
          filterClient,
          filterQtype,
          filterProtocol,
          filterSinceMinutes,
          filterMinLatency,
          filterMaxLatency,
        });
        const response = await fetch(`/api/queries/recent?${params}`);
        if (!response.ok) {
          throw new Error(`Query request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQueryRows(Array.isArray(data.rows) ? data.rows : []);
        setQueryTotal(Number(data.total || 0));
        setQueryError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQueryError(err.message || "Failed to load queries");
      }
    };
    loadQueries();
    const interval = setInterval(loadQueries, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [
    queryPage,
    queryPageSize,
    querySortBy,
    querySortDir,
    filterQName,
    filterOutcome,
    filterRcode,
    filterClient,
    filterQtype,
    filterProtocol,
    filterSinceMinutes,
    filterMinLatency,
    filterMaxLatency,
  ]);

  useEffect(() => {
    let isMounted = true;
    const loadBlocklists = async () => {
      try {
        setBlocklistLoading(true);
        const response = await fetch("/api/blocklists");
        if (!response.ok) {
          throw new Error(`Blocklists request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
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
        const hc = data.health_check;
        setHealthCheck(
          hc && typeof hc.enabled === "boolean"
            ? { enabled: hc.enabled, fail_on_any: hc.fail_on_any !== false }
            : { enabled: false, fail_on_any: true }
        );
        setBlocklistError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setBlocklistError(err.message || "Failed to load blocklists");
      } finally {
        if (isMounted) {
          setBlocklistLoading(false);
        }
      }
    };
    loadBlocklists();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config");
        if (!response.ok) {
          throw new Error(`Config request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setActiveConfig(data);
        setConfigError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setConfigError(err.message || "Failed to load config");
      }
    };
    loadConfig();
    const interval = setInterval(loadConfig, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadRefreshStats = async () => {
      try {
        const response = await fetch("/api/cache/refresh/stats");
        if (!response.ok) {
          throw new Error(`Refresh stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setRefreshStats(data);
        setRefreshStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setRefreshStatsError(err.message || "Failed to load refresh stats");
      }
    };
    loadRefreshStats();
    const interval = setInterval(loadRefreshStats, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "replica-stats" || !syncStatus?.enabled || syncStatus?.role !== "primary") {
      return;
    }
    let isMounted = true;
    const loadInstanceStats = async () => {
      try {
        const response = await fetch("/api/instances/stats");
        if (!response.ok) {
          throw new Error(`Instance stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) return;
        setInstanceStats(data);
        setInstanceStatsError("");
        setInstanceStatsUpdatedAt(new Date());
      } catch (err) {
        if (!isMounted) return;
        setInstanceStatsError(err.message || "Failed to load instance stats");
      }
    };
    loadInstanceStats();
    const interval = setInterval(loadInstanceStats, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeTab, syncStatus?.enabled, syncStatus?.role]);

  useEffect(() => {
    let isMounted = true;
    const loadStats = async () => {
      try {
        const response = await fetch("/api/blocklists/stats");
        if (!response.ok) {
          throw new Error(`Blocklist stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setBlocklistStats(data);
        setBlocklistStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setBlocklistStatsError(err.message || "Failed to load blocklist stats");
      }
    };
    loadStats();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadSummary = async () => {
      try {
        const response = await fetch(
          `/api/queries/summary?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Summary request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQuerySummary(data);
        setQuerySummaryError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQuerySummaryError(err.message || "Failed to load query summary");
      }
    };
    loadSummary();
    const interval = setInterval(loadSummary, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  const bucketMinutes = queryWindowMinutes <= 15 ? 1 : queryWindowMinutes <= 60 ? 5 : queryWindowMinutes <= 360 ? 15 : 60;

  useEffect(() => {
    let isMounted = true;
    const loadTimeSeries = async () => {
      try {
        const response = await fetch(
          `/api/queries/time-series?window_minutes=${queryWindowMinutes}&bucket_minutes=${bucketMinutes}`
        );
        if (!response.ok) throw new Error("Time-series request failed");
        const data = await response.json();
        if (!isMounted) return;
        setTimeSeries(data);
        setTimeSeriesError("");
      } catch (err) {
        if (!isMounted) return;
        setTimeSeriesError(err.message || "Failed to load time-series");
      }
    };
    loadTimeSeries();
    const interval = setInterval(loadTimeSeries, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes, bucketMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadLatency = async () => {
      try {
        const response = await fetch(
          `/api/queries/latency?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Latency request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQueryLatency(data);
        setQueryLatencyError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQueryLatencyError(err.message || "Failed to load latency stats");
      }
    };
    loadLatency();
    const interval = setInterval(loadLatency, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadUpstreamStats = async () => {
      try {
        const response = await fetch(
          `/api/queries/upstream-stats?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Upstream stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setUpstreamStats(data);
        setUpstreamStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setUpstreamStatsError(err.message || "Failed to load upstream stats");
      }
    };
    loadUpstreamStats();
    const interval = setInterval(loadUpstreamStats, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadFilterOptions = async () => {
      try {
        const response = await fetch(
          `/api/queries/filter-options?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Filter options failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setFilterOptions(data.options || {});
        setFilterOptionsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setFilterOptionsError(err.message || "Failed to load filter options");
      }
    };
    loadFilterOptions();
    const interval = setInterval(loadFilterOptions, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadInfo = async () => {
      try {
        const response = await fetch("/api/info");
        if (!response.ok) {
          throw new Error(`Info request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setHostname(data.hostname || "");
        setAppInfo(data);
      } catch (err) {
        if (!isMounted) {
          return;
        }
        // Silent fail - hostname is optional
        console.warn("Failed to load hostname:", err);
      }
    };
    loadInfo();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!appInfo?.startTimestamp) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [appInfo?.startTimestamp]);

  useEffect(() => {
    document.title = hostname ? `Beyond Ads DNS — ${hostname}` : "Beyond Ads DNS";
  }, [hostname]);

  useEffect(() => {
    let isMounted = true;
    const loadPauseStatus = async () => {
      try {
        const response = await fetch("/api/blocklists/pause/status");
        if (!response.ok) {
          throw new Error(`Pause status failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setPauseStatus(data);
        setPauseError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setPauseError(err.message || "Failed to load pause status");
      }
    };
    loadPauseStatus();
    const interval = setInterval(loadPauseStatus, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadCacheStats = async () => {
      try {
        const response = await fetch("/api/cache/stats");
        if (!response.ok) {
          throw new Error(`Cache stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setCacheStats(data);
        setCacheStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setCacheStatsError(err.message || "Failed to load cache stats");
      }
    };
    loadCacheStats();
    const interval = refreshIntervalMs > 0 ? setInterval(loadCacheStats, refreshIntervalMs) : null;
    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [refreshIntervalMs]);

  useEffect(() => {
    if (activeTab === "sync" && syncStatus?.role === "replica") {
      setSyncSettingsPrimaryUrl(syncStatus.primary_url || "");
      setSyncSettingsToken(""); // Don't pre-fill token for security
      setSyncSettingsInterval(syncStatus.sync_interval || "60s");
      setSyncSettingsStatsSourceUrl(syncStatus.stats_source_url || "");
    }
  }, [activeTab, syncStatus]);

  useEffect(() => {
    if (activeTab !== "system") return;
    let isMounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/system/config");
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        const data = await response.json();
        if (!isMounted) return;
        setSystemConfig(data);
        setSystemConfigError("");
      } catch (err) {
        if (!isMounted) return;
        setSystemConfigError(err.message || "Failed to load system config");
      }
    };
    load();
    return () => { isMounted = false; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "error-viewer") return;
    let isMounted = true;
    const load = async () => {
      setAppErrorsLoading(true);
      setAppErrorsError("");
      try {
        const response = await fetch("/api/errors");
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) return;
        setAppErrors(Array.isArray(data.errors) ? data.errors : []);
        if (["error", "warning", "info", "debug"].includes(data.log_level)) {
          setErrorLogLevel(data.log_level);
        }
        setAppErrorsError("");
      } catch (err) {
        if (!isMounted) return;
        setAppErrors([]);
        setAppErrorsError(err.message || "Failed to load errors");
      } finally {
        if (isMounted) setAppErrorsLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "integrations") return;
    let isMounted = true;
    const load = async () => {
      setWebhooksLoading(true);
      setWebhooksError("");
      try {
        const response = await fetch("/api/webhooks");
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) return;
        setWebhooksData(data);
        setWebhooksError("");
      } catch (err) {
        if (!isMounted) return;
        setWebhooksData(null);
        setWebhooksError(err.message || "Failed to load webhooks");
      } finally {
        if (isMounted) setWebhooksLoading(false);
      }
    };
    load();
    return () => { isMounted = false; };
  }, [activeTab]);

  useEffect(() => {
    setErrorPage(1);
  }, [errorFilterText, errorSeverityFilter, errorSortBy, errorSortDir]);

  useEffect(() => {
    if (activeTab !== "dns") return;
    let isMounted = true;
    const loadLocalRecords = async () => {
      try {
        const response = await fetch("/api/dns/local-records");
        if (!response.ok) {
          throw new Error(`Local records request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setLocalRecords(Array.isArray(data.records) ? data.records : []);
        setLocalRecordsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setLocalRecordsError(err.message || "Failed to load local records");
      }
    };
    const loadUpstreams = async () => {
      try {
        const response = await fetch("/api/dns/upstreams");
        if (!response.ok) {
          throw new Error(`Upstreams request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setUpstreams(Array.isArray(data.upstreams) ? data.upstreams : []);
        setResolverStrategy(data.resolver_strategy || "failover");
        setUpstreamTimeout(data.upstream_timeout || "10s");
        setUpstreamsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setUpstreamsError(err.message || "Failed to load upstreams");
      }
    };
    const loadResponse = async () => {
      try {
        const response = await fetch("/api/dns/response");
        if (!response.ok) {
          throw new Error(`Response config request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setResponseBlocked(data.blocked || "nxdomain");
        setResponseBlockedTtl(data.blocked_ttl || "1h");
        setResponseError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setResponseError(err.message || "Failed to load response config");
      }
    };
    const loadSafeSearch = async () => {
      try {
        const response = await fetch("/api/dns/safe-search");
        if (!response.ok) {
          throw new Error(`Safe search request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setSafeSearchEnabled(data.enabled ?? false);
        setSafeSearchGoogle(data.google !== false);
        setSafeSearchBing(data.bing !== false);
        setSafeSearchError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setSafeSearchError(err.message || "Failed to load safe search config");
      }
    };
    loadLocalRecords();
    loadUpstreams();
    loadResponse();
    loadSafeSearch();
    return () => {
      isMounted = false;
    };
  }, [activeTab]);

  const statusRows = querySummary?.statuses || [];
  const statusTotal = querySummary?.total || 0;
  const statusMap = statusRows.reduce((acc, row) => {
    acc[row.outcome] = row.count;
    return acc;
  }, {});
  const statusOrder = ["cached", "local", "upstream", "safe_search", "blocked", "upstream_error", "invalid"];
  const statusCards = statusOrder.map((key) => ({
    key,
    label: STATUS_LABELS[key] || key,
    count: statusMap[key] || 0,
  }));
  const otherCount = statusTotal - statusCards.reduce((sum, row) => sum + row.count, 0);
  if (otherCount > 0) {
    statusCards.push({ key: "other", label: "Other", count: otherCount });
  }

  const totalPages = Math.max(1, Math.ceil(queryTotal / queryPageSize));
  const canPrev = queryPage > 1;
  const canNext = queryPage < totalPages;

  const setFilter = (setter, value) => {
    setter(value);
    setQueryPage(1);
  };

  const toggleSort = (field) => {
    if (querySortBy === field) {
      setQuerySortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setQuerySortBy(field);
      setQuerySortDir("desc");
    }
  };

  const drillDownToQueries = (outcome) => {
    setActiveTab("queries");
    setFilterOutcome(outcome);
    setQueryPage(1);
  };

  const toggleSection = (id) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(COLLAPSIBLE_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const collapseSidebar = () => {
    if (!sidebarCollapsed) {
      setSidebarCollapsed(true);
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "true");
      } catch {}
    }
  };

  const exportCsv = () => {
    const params = buildQueryParams({
      queryPage: 1,
      queryPageSize: Math.min(queryPageSize, 5000),
      querySortBy,
      querySortDir,
      filterQName,
      filterOutcome,
      filterRcode,
      filterClient,
      filterQtype,
      filterProtocol,
      filterSinceMinutes,
      filterMinLatency,
      filterMaxLatency,
    });
    window.location.href = `/api/queries/export?${params}`;
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

  const removeSource = (index) => {
    setBlocklistSources((prev) => prev.filter((_, idx) => idx !== index));
  };

  const addDomain = (setter, value) => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return;
    }
    setter((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const removeDomain = (setter, domain) => {
    setter((prev) => prev.filter((item) => item !== domain));
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
        health_check: {
          enabled: healthCheck.enabled,
          fail_on_any: healthCheck.fail_on_any,
        },
      };
      const response = await fetch("/api/blocklists", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
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
    setConfirmState({ open: false });
    const saved = await saveBlocklists();
    if (!saved) return;
    try {
      setBlocklistLoading(true);
      const response = await fetch("/api/blocklists/apply", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setBlocklistStatus("Applied");
      addToast("Blocklists applied successfully", "success");
      const statsResponse = await fetch("/api/blocklists/stats");
      if (statsResponse.ok) {
        const data = await statsResponse.json();
        setBlocklistStats(data);
      }
    } catch (err) {
      setBlocklistError(err.message || "Failed to apply blocklists");
      addToast(err.message || "Failed to apply blocklists", "error");
    } finally {
      setBlocklistLoading(false);
    }
  };
  const confirmApplyBlocklists = () => {
    setConfirmState({
      open: true,
      title: "Apply blocklist changes",
      message: "This will reload blocklists and may temporarily affect DNS resolution. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyBlocklists,
    });
  };

  const exportConfig = () => {
    const exclude = configExportExcludeInstanceDetails ? "true" : "false";
    window.location.href = `/api/config/export?exclude_instance_details=${exclude}`;
  };

  const pauseBlocking = async (minutes) => {
    setPauseLoading(true);
    setPauseError("");
    try {
      const response = await fetch("/api/blocklists/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_minutes: minutes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Pause failed: ${response.status}`);
      }
      const data = await response.json();
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
      const response = await fetch("/api/blocklists/resume", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Resume failed: ${response.status}`);
      }
      const data = await response.json();
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
      const response = await fetch("/api/blocklists/health");
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      const data = await response.json();
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
      setLocalRecordsError(
        validation.summary || "Please fix validation errors before saving."
      );
      return false;
    }
    try {
      setLocalRecordsLoading(true);
      const response = await fetch("/api/dns/local-records", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          records: validation.normalizedRecords,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
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
    setConfirmState({ open: false });
    const saved = await saveLocalRecords();
    if (!saved) return;
    try {
      setLocalRecordsLoading(true);
      const response = await fetch("/api/dns/local-records/apply", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
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
    setConfirmState({
      open: true,
      title: "Apply local records",
      message: "This will update local DNS records immediately. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyLocalRecords,
    });
  };

  const RESOLVER_STRATEGY_OPTIONS = [
    { value: "failover", label: "Failover", desc: "Try upstreams in order, use next on failure" },
    { value: "load_balance", label: "Load Balance", desc: "Round-robin across all upstreams" },
    { value: "weighted", label: "Weighted (latency)", desc: "Prefer faster upstreams by response time" },
  ];

  const updateUpstream = (index, field, value) => {
    setUpstreams((prev) =>
      prev.map((u, idx) => {
        if (idx !== index) return u;
        const next = { ...u, [field]: value };
        // Auto-set protocol when address is DoT or DoH
        if (field === "address") {
          const addr = String(value || "").trim().toLowerCase();
          if (addr.startsWith("tls://")) next.protocol = "tls";
          else if (addr.startsWith("https://")) next.protocol = "https";
        }
        return next;
      })
    );
  };

  const addUpstream = () => {
    setUpstreams((prev) => [...prev, { name: "", address: "", protocol: "udp" }]);
  };

  const removeUpstream = (index) => {
    setUpstreams((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveUpstreams = async () => {
    setUpstreamsStatus("");
    setUpstreamsError("");
    const validation = validateUpstreamsForm(upstreams);
    if (validation.hasErrors) {
      setUpstreamsError(
        validation.summary || "Please fix validation errors before saving."
      );
      return false;
    }
    const normalizedTimeout = (upstreamTimeout || "").trim() || "10s";
    if (!isValidDuration(normalizedTimeout)) {
      setUpstreamsError("Upstream timeout must be a positive duration (e.g. 2s, 10s, 30s).");
      return false;
    }
    try {
      setUpstreamsLoading(true);
      const response = await fetch("/api/dns/upstreams", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upstreams: validation.normalizedUpstreams,
          resolver_strategy: resolverStrategy,
          upstream_timeout: normalizedTimeout,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      const data = await response.json();
      setUpstreamsStatus("Saved");
      setUpstreams(validation.normalizedUpstreams);
      if (data.upstream_timeout) setUpstreamTimeout(data.upstream_timeout);
      return true;
    } catch (err) {
      setUpstreamsError(err.message || "Failed to save upstreams");
      return false;
    } finally {
      setUpstreamsLoading(false);
    }
  };

  const applyUpstreams = async () => {
    setConfirmState({ open: false });
    const saved = await saveUpstreams();
    if (!saved) return;
    try {
      setUpstreamsLoading(true);
      const response = await fetch("/api/dns/upstreams/apply", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
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
    setConfirmState({
      open: true,
      title: "Apply upstream changes",
      message: "This will update DNS resolvers immediately. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyUpstreams,
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
      setResponseError(
        validation.summary || "Please fix validation errors before saving."
      );
      return false;
    }
    try {
      setResponseLoading(true);
      const response = await fetch("/api/dns/response", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blocked: validation.normalized.blocked,
          blocked_ttl: validation.normalized.blockedTtl,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
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
    setConfirmState({ open: false });
    const saved = await saveResponse();
    if (!saved) return;
    try {
      setResponseLoading(true);
      const response = await fetch("/api/dns/response/apply", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
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
    setConfirmState({
      open: true,
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
      const response = await fetch("/api/dns/safe-search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: safeSearchEnabled,
          google: safeSearchGoogle,
          bing: safeSearchBing,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
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
    setConfirmState({ open: false });
    const saved = await saveSafeSearch();
    if (!saved) return;
    try {
      setSafeSearchLoading(true);
      const response = await fetch("/api/dns/safe-search/apply", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
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
    setConfirmState({
      open: true,
      title: "Apply safe search config",
      message: "This will update safe search settings. Continue?",
      confirmLabel: "Apply",
      onConfirm: applySafeSearch,
    });
  };

  const createSyncToken = async () => {
    setSyncLoading(true);
    setSyncError("");
    setCreatedToken(null);
    try {
      const response = await fetch("/api/sync/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName || "Replica" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Create failed: ${response.status}`);
      }
      const data = await response.json();
      setCreatedToken(data.token);
      setNewTokenName("");
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setSyncStatus(statusData);
      }
    } catch (err) {
      setSyncError(err.message || "Failed to create token");
    } finally {
      setSyncLoading(false);
    }
  };

  const revokeSyncToken = async (index) => {
    setSyncLoading(true);
    setSyncError("");
    try {
      const response = await fetch(`/api/sync/tokens/${index}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Revoke failed: ${response.status}`);
      }
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setSyncStatus(statusData);
      }
    } catch (err) {
      setSyncError(err.message || "Failed to revoke token");
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
      setSyncSettingsError(
        validation.summary || "Please fix validation errors before saving."
      );
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
      const response = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      const data = await response.json();
      setSyncSettingsStatus(data.message || "Saved");
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) setSyncStatus(await statusRes.json());
      setConfirmState({
        open: true,
        title: "Restart required",
        message: "Sync settings saved. Restart the application to apply changes.",
        confirmLabel: "Restart",
        cancelLabel: "Later",
        variant: "danger",
        onConfirm: restartService,
      });
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
        setSyncConfigError(
          validation.summary || "Please fix validation errors before saving."
        );
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
      const response = await fetch("/api/sync/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed");
      setSyncConfigStatus(data.message || "Saved");
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) setSyncStatus(await statusRes.json());
      setConfirmState({
        open: true,
        title: "Restart required",
        message: "Sync configuration saved. Restart the application to apply changes.",
        confirmLabel: "Restart",
        cancelLabel: "Later",
        variant: "danger",
        onConfirm: restartService,
      });
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

  const importConfig = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    
    setImportStatus("");
    setImportError("");
    
    try {
      const text = await file.text();
      const parsed = parseYAML(text);
      
      const response = await fetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Import failed: ${response.status}`);
      }
      
      setImportStatus("Config imported successfully.");
      setConfirmState({
        open: true,
        title: "Restart required",
        message: "Config imported successfully. Restart the application to apply changes.",
        confirmLabel: "Restart",
        cancelLabel: "Later",
        variant: "danger",
        onConfirm: restartService,
      });
      
      // Reload config display
      const configResponse = await fetch("/api/config");
      if (configResponse.ok) {
        const data = await configResponse.json();
        setActiveConfig(data);
      }
    } catch (err) {
      setImportError(err.message || "Failed to import config");
    }
    
    // Reset file input
    event.target.value = "";
  };

  const restartService = async () => {
    setConfirmState({ open: false });
    setRestartError("");
    setRestartLoading(true);
    try {
      const response = await fetch("/api/restart", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Restart failed: ${response.status}`);
      }
      setImportStatus("Service is restarting. The page will reconnect when it is back.");
      addToast("Service is restarting...", "info");
    } catch (err) {
      setRestartError(err.message || "Failed to restart service");
      addToast(err.message || "Failed to restart service", "error");
      setRestartLoading(false);
    }
  };
  const confirmRestartService = () => {
    setConfirmState({
      open: true,
      title: "Restart service",
      message: "This will restart the DNS service. The dashboard may be briefly unavailable. Continue?",
      confirmLabel: "Restart",
      variant: "danger",
      onConfirm: restartService,
    });
  };

  const clearRedisCache = async () => {
    if (!confirm("Clear all DNS cache entries from Redis? This will remove cached responses and metadata. Continue?")) return;
    setClearRedisError("");
    try {
      setClearRedisLoading(true);
      const response = await fetch("/api/system/clear/redis", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Clear failed: ${response.status}`);
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
      const response = await fetch("/api/system/clear/clickhouse", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Clear failed: ${response.status}`);
      addToast("ClickHouse data cleared", "success");
      // Refresh query-related data
      if (activeTab === "queries") {
        setQueryRows([]);
        setQuerySummary(null);
        setQueryLatency(null);
        setTimeSeries(null);
      }
    } catch (err) {
      setClearClickhouseError(err.message || "Failed to clear ClickHouse");
      addToast(err.message || "Failed to clear ClickHouse", "error");
    } finally {
      setClearClickhouseLoading(false);
    }
  };

  const updateSystemConfig = (section, field, value) => {
    setSystemConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      next[section] = { ...(next[section] || {}), [field]: value };
      return next;
    });
  };

  const saveSystemConfig = async () => {
    setSystemConfigStatus("");
    setSystemConfigError("");
    if (!systemConfig) return;
    try {
      setSystemConfigLoading(true);
      const response = await fetch("/api/system/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(systemConfig),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      const data = await response.json();
      setSystemConfigStatus(data.message || "Saved.");
      // Apply Client Identification immediately (hot-reload, no restart needed)
      try {
        const applyRes = await fetch("/api/client-identification/apply", { method: "POST" });
        if (applyRes.ok) {
          setSystemConfigStatus("Saved. Client Identification applied.");
        }
      } catch {
        // Non-fatal: client identification reload failed, but config was saved
      }
      // Prompt user to restart for other settings (server, cache, query_store, control, logging, request_log, ui)
      setConfirmState({
        open: true,
        title: "Restart required",
        message: "Settings saved. Server, Cache, Query Store, Control, Application Logging, Request Log, and UI changes require a restart to take effect. Restart now?",
        confirmLabel: "Restart",
        cancelLabel: "Later",
        variant: "danger",
        onConfirm: restartService,
      });
    } catch (err) {
      setSystemConfigError(err.message || "Failed to save system config");
    } finally {
      setSystemConfigLoading(false);
    }
  };

  const showRefresh = activeTab === "overview" || activeTab === "queries" || activeTab === "replica-stats";

  return (
    <div className="app-layout">
      <div
        className={`app-sidebar-backdrop ${sidebarCollapsed ? "hidden" : ""}`}
        aria-hidden="true"
        onClick={toggleSidebar}
      />
      <aside className={`app-sidebar ${sidebarCollapsed ? "app-sidebar--collapsed" : ""}`}>
        <button
          type="button"
          className="app-sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
        >
          <TabIcon name={sidebarCollapsed ? "chevronRight" : "chevronLeft"} />
        </button>
        <div className="app-sidebar-logo">
          <AppLogo compact={sidebarCollapsed} height={28} showText={!sidebarCollapsed} />
        </div>
        <nav className="app-sidebar-nav" role="navigation" aria-label="Main">
          {["monitor", "configure", "tools", "admin"].map((group) => (
            <div key={group}>
              <div className="app-sidebar-group">
                {group === "monitor" ? "Monitor" : group === "configure" ? "Configure" : group === "tools" ? "Tools" : "Admin"}
              </div>
              {TABS.filter((t) => t.group === group && (!t.primaryOnly || (syncStatus?.enabled && syncStatus?.role === "primary"))).map((tab) => (
                <NavLink
                  key={tab.id}
                  to={tab.id === "overview" ? "/" : `/${tab.id}`}
                  className={({ isActive }) => (isActive ? "active" : "")}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  title={tab.label}
                  onClick={collapseSidebar}
                >
                  <span className="app-sidebar-icon">
                    <TabIcon name={tab.icon} />
                  </span>
                  <span className="app-sidebar-label">{tab.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="app-main">
    <div className="page">
      {(hostname || appInfo) && (
        <div className="env-banner" aria-label="Environment">
          {hostname && <span className="env-banner-name">{hostname}</span>}
          {appInfo && (
            <span className="env-banner-build">
              {hostname && " · "}
              {appInfo.releaseTag && <span>{appInfo.releaseTag}</span>}
              {appInfo.releaseTag && " · "}
              <span>Uptime {appInfo.startTimestamp ? formatUptime(now - new Date(appInfo.startTimestamp).getTime()) : "-"}</span>
              {" · "}
              <a href="https://github.com/tternquist/beyond-ads-dns/wiki" target="_blank" rel="noopener noreferrer" className="env-banner-link">
                Wiki ↗
              </a>
            </span>
          )}
        </div>
      )}
      <header className={`header ${showRefresh ? "" : "app-header-compact"}`}>
        <div>
          <h1 className="header-title">
            <AppLogo height={28} showText />
          </h1>
        </div>
        <div className="header-actions">
          {showRefresh && (
            <div className="refresh">
              <label className="select">
                Refresh
                <select
                  value={refreshIntervalMs}
                  onChange={(e) => setRefreshIntervalMs(Number(e.target.value))}
                  aria-label="Refresh interval"
                >
                  {REFRESH_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="updated">
                {(activeTab === "replica-stats" ? instanceStatsUpdatedAt : updatedAt)
                  ? `Updated ${(activeTab === "replica-stats" ? instanceStatsUpdatedAt : updatedAt).toLocaleTimeString()}`
                  : "Loading"}
              </span>
            </div>
          )}
          <label className="select" title="Theme">
            <select
              value={themePreference}
              onChange={(e) => {
                const v = e.target.value;
                setTheme(v);
                setThemePreference(v);
              }}
              aria-label="Theme"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </label>
          {authEnabled && (
            <button type="button" className="button logout-button" onClick={logout}>
              Log out
            </button>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="blocking"
        title="Blocking Control"
        collapsed={collapsedSections.blocking}
        onToggle={toggleSection}
        badges={
          <>
            <span className={`badge ${pauseStatus?.paused ? "paused" : "active"}`}>
              {pauseStatus?.paused ? "Paused" : "Active"}
            </span>
            {isReplica && <span className="badge muted">Per instance</span>}
          </>
        }
      >
        {pauseError && <div className="error">{pauseError}</div>}
        {pauseStatus?.paused ? (
          <div>
            <p className="status">
              Blocking is paused until {new Date(pauseStatus.until).toLocaleString()}
              {isReplica && " (this instance only)"}
            </p>
            <button
              className="button primary"
              onClick={resumeBlocking}
              disabled={pauseLoading}
            >
              Resume Blocking
            </button>
          </div>
        ) : (
          <div>
            <p className="muted">
              Blocking is active. Pause for:
              {isReplica && " (applies to this instance only)"}
            </p>
            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button
                className="button"
                onClick={() => pauseBlocking(1)}
                disabled={pauseLoading}
              >
                1 min
              </button>
              <button
                className="button"
                onClick={() => pauseBlocking(5)}
                disabled={pauseLoading}
              >
                5 min
              </button>
              <button
                className="button"
                onClick={() => pauseBlocking(30)}
                disabled={pauseLoading}
              >
                30 min
              </button>
              <button
                className="button"
                onClick={() => pauseBlocking(60)}
                disabled={pauseLoading}
              >
                1 hour
              </button>
            </div>
          </div>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="queries"
        title="Query Statistics"
        collapsed={collapsedSections.queries}
        onToggle={toggleSection}
        badges={
          <label className="select">
            Window
            <select
              value={queryWindowMinutes}
              onChange={(event) => setQueryWindowMinutes(Number(event.target.value))}
            >
              {QUERY_WINDOW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        }
      >
        {querySummaryError && <div className="error">{querySummaryError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : !querySummary && !querySummaryError ? (
          <div className="grid">
            {[1, 2, 3, 4].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <>
            <DonutChart data={statusCards} total={statusTotal} />
            {timeSeries?.enabled && timeSeries.buckets?.length > 0 && (
              <div className="chart-container">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: "14px", color: "#9aa4b2" }}>Request volume over time (local time)</h3>
                  <span className="qps-indicator" title="Current QPS from latest bucket">
                    {(() => {
                      const buckets = timeSeries.buckets;
                      const last = buckets?.[buckets.length - 1];
                      const qps = last && bucketMinutes > 0 ? (last.total / (bucketMinutes * 60)).toFixed(1) : "-";
                      return <>{qps} QPS</>;
                    })()}
                  </span>
                </div>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={timeSeries.buckets.map((b) => ({
                      ...b,
                      time: formatUtcToLocalTime(b.ts),
                      rate: bucketMinutes > 0 ? b.total / (bucketMinutes * 60) : 0,
                    }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="gradientTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2563eb" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <RechartsTooltip
                      contentStyle={{ background: "#1f2430", border: "1px solid #2a3140", borderRadius: "8px" }}
                      labelStyle={{ color: "#fff" }}
                      formatter={(value) => [value?.toFixed(1) ?? value, "QPS"]}
                      labelFormatter={(v) => `Time: ${v}`}
                    />
                    <Area type="monotone" dataKey="rate" stroke="#2563eb" fill="url(#gradientTotal)" name="Queries/sec" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="upstream"
        title="Upstream Server Distribution"
        collapsed={collapsedSections.upstream}
        onToggle={toggleSection}
      >
        {upstreamStatsError && <div className="error">{upstreamStatsError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : !upstreamStats?.enabled ? (
          <p className="muted">Upstream stats unavailable.</p>
        ) : upstreamStats.upstreams?.length === 0 ? (
          <p className="muted">No upstream queries in the selected window.</p>
        ) : (
          <>
            <p className="muted">
              Distribution of forwarded queries (outcome=upstream, servfail) in the last{" "}
              {queryWindowMinutes >= 60 ? `${queryWindowMinutes / 60} hour${queryWindowMinutes / 60 > 1 ? "s" : ""}` : `${queryWindowMinutes} min`}.
            </p>
            <DonutChart
              data={(upstreamStats.upstreams || []).map((row) => ({
                key: row.address || "(unknown)",
                count: row.count,
                label: row.address || "(unknown)",
              }))}
              total={upstreamStats.total || 0}
              colorPalette={UPSTREAM_COLORS}
            />
          </>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="response"
        title="Response Time"
        collapsed={collapsedSections.response}
        onToggle={toggleSection}
      >
        {queryLatencyError && <div className="error">{queryLatencyError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <>
            {timeSeries?.enabled && timeSeries.latencyBuckets?.length > 0 && (
              <div className="response-time-section">
                <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-start", marginBottom: 12 }}>
                  <h3 style={{ margin: 0, fontSize: "14px", color: "#9aa4b2", flex: "1 1 auto" }}>Latency over time (local time, ms)</h3>
                  {queryLatency?.enabled && queryLatency.count > 0 && (
                    <div className="latency-period-stats" title={`Stats for selected window (${queryWindowMinutes} min)`}>
                      <span className="latency-stat" data-metric="avg" title={METRIC_TOOLTIPS["Avg"]}>
                        <span className="latency-stat-line" style={{ background: "#3b82f6" }} />
                        Avg: {queryLatency.avgMs != null ? queryLatency.avgMs.toFixed(2) : "-"} ms
                      </span>
                      <span className="latency-stat" data-metric="p50" title={METRIC_TOOLTIPS["P50"]}>
                        <span className="latency-stat-line" style={{ background: "#22c55e" }} />
                        P50: {queryLatency.p50Ms != null ? queryLatency.p50Ms.toFixed(2) : "-"} ms
                      </span>
                      <span className="latency-stat" data-metric="p95" title={METRIC_TOOLTIPS["P95"]}>
                        <span className="latency-stat-line" style={{ background: "#f59e0b" }} />
                        P95: {queryLatency.p95Ms != null ? queryLatency.p95Ms.toFixed(2) : "-"} ms
                      </span>
                      <span className="latency-stat" data-metric="p99" title={METRIC_TOOLTIPS["P99"]}>
                        <span className="latency-stat-line" style={{ background: "#ef4444" }} />
                        P99: {queryLatency.p99Ms != null ? queryLatency.p99Ms.toFixed(2) : "-"} ms
                      </span>
                    </div>
                  )}
                </div>
                <div className="chart-container response-time-chart">
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={timeSeries.latencyBuckets.map((b) => ({
                        ...b,
                        time: formatUtcToLocalTime(b.ts),
                      }))}
                      margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="time" />
                      <YAxis />
                      <RechartsTooltip
                        contentStyle={{ background: "#1f2430", border: "1px solid #2a3140", borderRadius: "8px" }}
                        labelStyle={{ color: "#fff" }}
                        formatter={(value) => [value != null ? value.toFixed(2) : "-", "ms"]}
                        labelFormatter={(v) => `Time: ${v}`}
                      />
                      <Line type="monotone" dataKey="avgMs" stroke="#3b82f6" name="Avg" dot={false} strokeWidth={2} />
                      <Line type="monotone" dataKey="p50Ms" stroke="#22c55e" name="P50" dot={false} strokeWidth={2} />
                      <Line type="monotone" dataKey="p95Ms" stroke="#f59e0b" name="P95" dot={false} strokeWidth={2} />
                      <Line type="monotone" dataKey="p99Ms" stroke="#ef4444" name="P99" dot={false} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                  </div>
                  <div className="latency-legend" aria-hidden="true">
                    <span className="latency-legend-item" title={METRIC_TOOLTIPS["Avg"]}>
                      <span className="latency-legend-line" style={{ background: "#3b82f6" }} />
                      Avg
                    </span>
                    <span className="latency-legend-item" title={METRIC_TOOLTIPS["P50"]}>
                      <span className="latency-legend-line" style={{ background: "#22c55e" }} />
                      P50
                    </span>
                    <span className="latency-legend-item" title={METRIC_TOOLTIPS["P95"]}>
                      <span className="latency-legend-line" style={{ background: "#f59e0b" }} />
                      P95
                    </span>
                    <span className="latency-legend-item" title={METRIC_TOOLTIPS["P99"]}>
                      <span className="latency-legend-line" style={{ background: "#ef4444" }} />
                      P99
                    </span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="cache"
        title="L0 / L1 Cache"
        collapsed={collapsedSections.cache}
        onToggle={toggleSection}
      >
        {cacheStatsError && <div className="error">{cacheStatsError}</div>}
        <table className="cache-summary-table">
          <thead>
            <tr>
              <th>Layer</th>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="cache-layer" rowSpan="4">L0 (LRU)</td><td>Entries</td><td>{formatNumber(cacheStats?.lru?.entries)} / {formatNumber(cacheStats?.lru?.max_entries)}</td></tr>
            <tr><td>Fresh</td><td>{formatNumber(cacheStats?.lru?.fresh)}</td></tr>
            <tr><td>Stale</td><td>{formatNumber(cacheStats?.lru?.stale)}</td></tr>
            <tr><td>Expired</td><td>{formatNumber(cacheStats?.lru?.expired)}</td></tr>
            <tr><td className="cache-layer" rowSpan="4">L1 (Redis)</td><td>Hit rate</td><td>{cacheStats?.hit_rate != null ? `${cacheStats.hit_rate.toFixed(2)}%` : "-"}</td></tr>
            <tr><td>Requests</td><td>{formatNumber(cacheStats?.hits != null && cacheStats?.misses != null ? cacheStats.hits + cacheStats.misses : null)}</td></tr>
            <tr><td>Evicted</td><td>{formatNumber(stats?.evictedKeys)}</td></tr>
            <tr><td>Memory</td><td>{stats?.usedMemoryHuman || "-"}</td></tr>
            <tr><td className="cache-layer" rowSpan="3">Keyspace</td><td>DNS keys</td><td>{formatNumber(stats?.keyspace?.dnsKeys)}</td></tr>
            <tr><td>Metadata</td><td>{formatNumber(stats?.keyspace?.dnsmetaKeys)}</td></tr>
            <tr><td>Other</td><td>{formatNumber(stats?.keyspace?.otherKeys)}</td></tr>
          </tbody>
        </table>
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="advanced"
        title="Advanced"
        collapsed={collapsedSections.advanced ?? true}
        onToggle={toggleSection}
      >
        <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Refresh Sweeper</h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "1rem" }}>
          The sweeper periodically refreshes cache entries nearing expiry. Stats below use a rolling window
          {refreshStats?.batch_stats_window_sec
            ? ` (${formatStatsWindow(refreshStats.batch_stats_window_sec)}).`
            : "."}
        </p>
        {refreshStatsError && <div className="error">{refreshStatsError}</div>}
        <table className="cache-summary-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Entries refreshed (last run)</td>
              <td>{formatNumber(refreshStats?.last_sweep_count)}</td>
            </tr>
            <tr>
              <td>Last run</td>
              <td>
                {refreshStats?.last_sweep_time
                  ? new Date(refreshStats.last_sweep_time).toLocaleTimeString()
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Avg entries per run</td>
              <td>
                {refreshStats?.average_per_sweep_24h !== undefined
                  ? refreshStats.average_per_sweep_24h.toFixed(2)
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Std dev per run</td>
              <td>
                {refreshStats?.std_dev_per_sweep_24h !== undefined
                  ? refreshStats.std_dev_per_sweep_24h.toFixed(2)
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Sweep runs in window</td>
              <td>
                {formatNumber(refreshStats?.sweeps_24h)}
                {refreshStats?.batch_stats_window_sec
                  ? ` (${formatStatsWindow(refreshStats.batch_stats_window_sec)} window)`
                  : ""}
              </td>
            </tr>
            <tr>
              <td>Total entries refreshed</td>
              <td>{formatNumber(refreshStats?.refreshed_24h)}</td>
            </tr>
            <tr>
              <td>Batch size</td>
              <td>{formatNumber(refreshStats?.batch_size)}</td>
            </tr>
          </tbody>
        </table>
      </CollapsibleSection>
      )}

      {activeTab === "queries" && (
      <section className="section">
        <h2>Recent Queries</h2>
        {queryError && <div className="error">{queryError}</div>}
        {!queryEnabled ? (
          <EmptyState
            title="Query store is disabled"
            description="Enable the query store in System Settings to view recent DNS queries."
          />
        ) : (
          <div className="table">
            <div className="filter-presets">
              {QUERY_FILTER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className="button"
                  onClick={() => {
                    if (preset.id === "clear") {
                      setFilterQName("");
                      setFilterOutcome("");
                      setFilterRcode("");
                      setFilterClient("");
                      setFilterQtype("");
                      setFilterProtocol("");
                      setFilterSinceMinutes("");
                      setFilterMinLatency("");
                      setFilterMaxLatency("");
                    } else {
                      if (preset.outcome) setFilterOutcome(preset.outcome);
                      if (preset.sinceMinutes !== undefined) setFilterSinceMinutes(preset.sinceMinutes);
                      if (preset.minLatency) setFilterMinLatency(preset.minLatency);
                      if (preset.maxLatency) setFilterMaxLatency(preset.maxLatency);
                    }
                    setQueryPage(1);
                  }}
                >
                  {preset.label}
                </button>
              ))}
              {[
                filterQName,
                filterOutcome,
                filterRcode,
                filterClient,
                filterQtype,
                filterProtocol,
                filterSinceMinutes,
                filterMinLatency,
                filterMaxLatency,
              ].filter(Boolean).length > 0 && (
                <span className="active-filters-badge">
                  {[
                    filterQName,
                    filterOutcome,
                    filterRcode,
                    filterClient,
                    filterQtype,
                    filterProtocol,
                    filterSinceMinutes,
                    filterMinLatency,
                    filterMaxLatency,
                  ].filter(Boolean).length} filter(s) active
                </span>
              )}
            </div>
            <div className="table-filters">
              <FilterInput
                placeholder="QName contains"
                value={filterQName}
                onChange={(value) => setFilter(setFilterQName, value)}
                options={filterOptions?.qname || []}
              />
              <FilterInput
                placeholder="Outcome"
                value={filterOutcome}
                onChange={(value) => setFilter(setFilterOutcome, value)}
                options={filterOptions?.outcome || []}
              />
              <FilterInput
                placeholder="RCode"
                value={filterRcode}
                onChange={(value) => setFilter(setFilterRcode, value)}
                options={filterOptions?.rcode || []}
              />
              <FilterInput
                placeholder="Client"
                value={filterClient}
                onChange={(value) => setFilter(setFilterClient, value)}
                options={filterOptions?.client_ip || []}
              />
              <FilterInput
                placeholder="QType"
                value={filterQtype}
                onChange={(value) => setFilter(setFilterQtype, value)}
                options={filterOptions?.qtype || []}
              />
              <FilterInput
                placeholder="Protocol"
                value={filterProtocol}
                onChange={(value) => setFilter(setFilterProtocol, value)}
                options={filterOptions?.protocol || []}
              />
              <input
                className="input"
                placeholder="Since minutes"
                value={filterSinceMinutes}
                onChange={(event) =>
                  setFilter(setFilterSinceMinutes, event.target.value)
                }
              />
              <input
                className="input"
                placeholder="Min latency ms"
                value={filterMinLatency}
                onChange={(event) =>
                  setFilter(setFilterMinLatency, event.target.value)
                }
              />
              <input
                className="input"
                placeholder="Max latency ms"
                value={filterMaxLatency}
                onChange={(event) =>
                  setFilter(setFilterMaxLatency, event.target.value)
                }
              />
            </div>
            <div className="table-header">
              <button className="table-sort" onClick={() => toggleSort("ts")}>
                Time {querySortBy === "ts" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                className="table-sort"
                onClick={() => toggleSort("client_ip")}
              >
                Client{" "}
                {querySortBy === "client_ip"
                  ? querySortDir === "asc"
                    ? "↑"
                    : "↓"
                  : ""}
              </button>
              <button className="table-sort" onClick={() => toggleSort("qname")}>
                QName{" "}
                {querySortBy === "qname" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button className="table-sort" onClick={() => toggleSort("qtype")}>
                Type{" "}
                {querySortBy === "qtype" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                className="table-sort"
                onClick={() => toggleSort("outcome")}
              >
                Outcome{" "}
                {querySortBy === "outcome"
                  ? querySortDir === "asc"
                    ? "↑"
                    : "↓"
                  : ""}
              </button>
              <button className="table-sort" onClick={() => toggleSort("rcode")}>
                RCode{" "}
                {querySortBy === "rcode" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                className="table-sort"
                onClick={() => toggleSort("duration_ms")}
              >
                Duration{" "}
                {querySortBy === "duration_ms"
                  ? querySortDir === "asc"
                    ? "↑"
                    : "↓"
                  : ""}
              </button>
            </div>
            {queryRows.length === 0 && (
              <div className="table-empty">
                <EmptyState
                  title="No recent queries"
                  description="No queries match your current filters. Try adjusting filters or the time window."
                  action={
                    <button
                      className="button"
                      onClick={() => {
                        setFilterQName("");
                        setFilterOutcome("");
                        setFilterRcode("");
                        setFilterClient("");
                        setFilterQtype("");
                        setFilterProtocol("");
                        setFilterSinceMinutes("");
                        setFilterMinLatency("");
                        setFilterMaxLatency("");
                        setQueryPage(1);
                      }}
                    >
                      Clear filters
                    </button>
                  }
                />
              </div>
            )}
            {queryRows.map((row, index) => (
              <div className="table-row" key={`${row.ts}-${index}`}>
                <span>{formatUtcToLocalDateTime(row.ts)}</span>
                <span>
                  {row.client_name
                    ? `${row.client_name} (${row.client_ip || ""})`
                    : row.client_ip || "-"}
                </span>
                <span className="mono">{row.qname || "-"}</span>
                <span>{row.qtype || "-"}</span>
                <span>{row.outcome || "-"}</span>
                <span>{row.rcode || "-"}</span>
                <span>{row.duration_ms != null ? `${Number(row.duration_ms).toFixed(2)} ms` : "-"}</span>
              </div>
            ))}
            <div className="table-footer">
              <span>
                Page {queryPage} of {totalPages} • {formatNumber(queryTotal)} total
              </span>
              <div className="pagination">
                <label className="select">
                  Page size
                  <select
                    value={queryPageSize}
                    onChange={(event) => {
                      setQueryPageSize(Number(event.target.value));
                      setQueryPage(1);
                    }}
                  >
                    {[10, 25, 50, 100].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button"
                  onClick={() => setQueryPage((prev) => Math.max(1, prev - 1))}
                  disabled={!canPrev}
                >
                  Prev
                </button>
                <button
                  className="button"
                  onClick={() =>
                    setQueryPage((prev) => Math.min(totalPages, prev + 1))
                  }
                  disabled={!canNext}
                >
                  Next
                </button>
                <button className="button primary" onClick={exportCsv}>
                  Export CSV
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
      )}

      {activeTab === "replica-stats" && (
      <section className="section">
        <h2>Multi-Instance</h2>
        {!(syncStatus?.enabled && syncStatus?.role === "primary") ? (
          <p className="muted">Multi-Instance view is only available on the primary instance when sync is enabled.</p>
        ) : (
        <>
        <p className="muted">Statistics from the primary and each replica. Replicas push stats at their heartbeat interval. Response distribution and latency require ClickHouse (primary) or <code>sync.stats_source_url</code> on replicas.</p>
        {instanceStatsError && <div className="error">{instanceStatsError}</div>}
        {!instanceStats && !instanceStatsError && <p className="muted">Loading…</p>}
        {instanceStats && (
          <>
            <div className="table-wrapper" style={{ marginTop: 16, overflowX: "auto" }}>
              <table className="table instances-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Release</th>
                    <th>URL</th>
                    <th>Updated</th>
                    <th title={METRIC_TOOLTIPS["Forwarded"]}>% Forwarded</th>
                    <th title={METRIC_TOOLTIPS["Blocked"]}>% Blocked</th>
                    <th title={METRIC_TOOLTIPS["Upstream error"]}>% Error</th>
                    <th>L0 Key Count</th>
                    <th>L1 Key Count</th>
                    <th title={METRIC_TOOLTIPS["Avg"]}>Avg Response Time</th>
                    <th>Average Sweep Size</th>
                  </tr>
                </thead>
                <tbody>
                  {instanceStats.primary && (
                    <tr>
                      <td><strong>Primary</strong></td>
                      <td>{instanceStats.primary.release || "—"}</td>
                      <td>{instanceStats.primary.url ? <a href={instanceStats.primary.url} target="_blank" rel="noopener noreferrer">{instanceStats.primary.url}</a> : "—"}</td>
                      <td>—</td>
                      <td>{formatPctFromDistribution(instanceStats.primary.response_distribution, "upstream")}</td>
                      <td>{formatPctFromDistribution(instanceStats.primary.response_distribution, "blocked")}</td>
                      <td>{formatErrorPctFromDistribution(instanceStats.primary.response_distribution)}</td>
                      <td>{formatNumber(instanceStats.primary.cache?.lru?.entries)}</td>
                      <td>{formatNumber(instanceStats.primary.cache?.redis_keys)}</td>
                      <td>{instanceStats.primary.response_time?.count > 0 ? `${Number(instanceStats.primary.response_time.avg_ms)?.toFixed(2)}ms` : "—"}</td>
                      <td>{formatNumber(instanceStats.primary.refresh?.average_per_sweep_24h)}</td>
                    </tr>
                  )}
                  {instanceStats.replicas?.map((r) => (
                    <tr key={r.token_id}>
                      <td>{r.name || "Replica"}</td>
                      <td>{r.release || "—"}</td>
                      <td>{r.stats_source_url ? <a href={r.stats_source_url} target="_blank" rel="noopener noreferrer">{r.stats_source_url}</a> : "—"}</td>
                      <td>{r.last_updated ? formatUtcToLocalTime(r.last_updated) : "—"}</td>
                      <td>{formatPctFromDistribution(r.response_distribution, "upstream")}</td>
                      <td>{formatPctFromDistribution(r.response_distribution, "blocked")}</td>
                      <td>{formatErrorPctFromDistribution(r.response_distribution)}</td>
                      <td>{formatNumber(r.cache?.lru?.entries)}</td>
                      <td>{formatNumber(r.cache?.redis_keys)}</td>
                      <td>{r.response_time?.count > 0 ? `${Number(r.response_time.avg_ms)?.toFixed(2)}ms` : "—"}</td>
                      <td>{formatNumber(r.cache_refresh?.average_per_sweep_24h)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(!instanceStats.primary && (!instanceStats.replicas || instanceStats.replicas.length === 0)) && (
              <p className="muted" style={{ marginTop: 16 }}>No instance stats available.</p>
            )}
            {instanceStats.primary && (!instanceStats.replicas || instanceStats.replicas.length === 0) && (
              <p className="muted" style={{ marginTop: 16 }}>No replicas have pushed stats yet. Configure replicas with heartbeat in the Sync tab.</p>
            )}
          </>
        )}
        </>
        )}
      </section>
      )}

      {activeTab === "blocklists" && (
      <section className="section">
        <div className="section-header">
          <h2>Blocklist Management</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveBlocklists}
              disabled={
                blocklistLoading ||
                blocklistValidation.hasErrors ||
                scheduledPauseValidation.hasErrors
              }
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={confirmApplyBlocklists}
              disabled={
                blocklistLoading ||
                blocklistValidation.hasErrors ||
                scheduledPauseValidation.hasErrors
              }
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        {isReplica && <p className="muted">Blocklists are managed by the primary instance.</p>}
        {blocklistLoading && <p className="muted">Loading…</p>}
        {blocklistStatus && <p className="status">{blocklistStatus}</p>}
        {blocklistError && <div className="error">{blocklistError}</div>}
        {blocklistStatsError && <div className="error">{blocklistStatsError}</div>}

        <div className="grid">
          <StatCard
            label="Blocked domains"
            value={
              blocklistStats
                ? formatNumber(blocklistStats.blocked + blocklistStats.deny)
                : "-"
            }
            subtext="lists + manual blocks"
          />
          <StatCard
            label="List entries"
            value={formatNumber(blocklistStats?.blocked)}
          />
          <StatCard
            label="Manual blocks"
            value={formatNumber(blocklistStats?.deny)}
          />
          <StatCard
            label="Allowlist"
            value={formatNumber(blocklistStats?.allow)}
          />
        </div>

        <div className="form-group">
          <label className="field-label">Refresh interval</label>
          <input
            className={`input ${
              blocklistValidation.fieldErrors.refreshInterval ? "input-invalid" : ""
            }`}
            value={refreshInterval}
            onChange={(event) => setRefreshInterval(event.target.value)}
          />
          {blocklistValidation.fieldErrors.refreshInterval && (
            <div className="field-error">
              {blocklistValidation.fieldErrors.refreshInterval}
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="field-label">Blocklist sources</label>
          {(blocklistSources.length === 0 || showBlocklistRecommendations) && (
            <div className="blocklist-recommendations">
              <p className="muted" style={{ marginBottom: 12 }}>
                {blocklistSources.length === 0
                  ? "Choose a preset to get started, or add your own sources below."
                  : "Apply a preset to replace your current sources, or add your own below."}
              </p>
              <div className="grid" style={{ marginBottom: 16 }}>
                {BLOCKLIST_PRESETS.map((preset) => (
                  <div
                    key={preset.id}
                    className="card card-clickable"
                    onClick={() => {
                      setBlocklistSources(preset.sources.map((s) => ({ ...s })));
                      setShowBlocklistRecommendations(false);
                    }}
                  >
                    <div className="card-label">{preset.label}</div>
                    <div className="card-value" style={{ fontSize: 16 }}>{preset.sources.length} list(s)</div>
                    <div className="card-subtext">{preset.description}</div>
                  </div>
                ))}
              </div>
              {blocklistSources.length > 0 && (
                <button
                  className="button"
                  onClick={() => setShowBlocklistRecommendations(false)}
                >
                  Hide recommendations
                </button>
              )}
            </div>
          )}
          {blocklistSources.length > 0 && !showBlocklistRecommendations && (
            <button
              className="button"
              onClick={() => setShowBlocklistRecommendations(true)}
              style={{ marginBottom: 12 }}
            >
              Show recommendations
            </button>
          )}
          <div className="list">
            {blocklistSources.map((source, index) => (
              <div key={`${source.url}-${index}`}>
                <div className="list-row">
                  <input
                    className="input"
                    placeholder="Name"
                    value={source.name || ""}
                    onChange={(event) =>
                      updateSource(index, "name", event.target.value)
                    }
                  />
                  <input
                    className={`input ${
                      blocklistValidation.rowErrors[index]?.url ? "input-invalid" : ""
                    }`}
                    placeholder="URL"
                    value={source.url || ""}
                    onChange={(event) =>
                      updateSource(index, "url", event.target.value)
                    }
                  />
                  <button
                    className="icon-button"
                    onClick={() => removeSource(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(blocklistValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(blocklistValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          {blocklistValidation.generalErrors.map((message) => (
            <div key={message} className="field-error">
              {message}
            </div>
          ))}
          <button className="button" onClick={addSource}>
            Add blocklist
          </button>
        </div>

        <div className="grid">
          <div className="form-group">
            <label className="field-label">Allowlist (exceptions)</label>
            <DomainEditor
              items={allowlist}
              onAdd={(value) => addDomain(setAllowlist, value)}
              onRemove={(value) => removeDomain(setAllowlist, value)}
            />
          </div>
          <div className="form-group">
            <label className="field-label">Manual blocklist</label>
            <DomainEditor
              items={denylist}
              onAdd={(value) => addDomain(setDenylist, value)}
              onRemove={(value) => removeDomain(setDenylist, value)}
            />
          </div>
        </div>

        <div className="form-group">
          <label className="field-label">Scheduled pause</label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
            Don&apos;t block during specific hours (e.g. work hours). Useful for allowing work tools.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={scheduledPause.enabled}
              onChange={(e) =>
                setScheduledPause((prev) => ({ ...prev, enabled: e.target.checked }))
              }
            />
            Enable scheduled pause
          </label>
          {scheduledPause.enabled && (
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>Start</label>
                <input
                  className={`input ${scheduledPauseValidation.fieldErrors.start ? "input-invalid" : ""}`}
                  type="text"
                  placeholder="09:00"
                  value={scheduledPause.start}
                  onChange={(e) => setScheduledPause((prev) => ({ ...prev, start: e.target.value }))}
                  style={{ width: 80 }}
                />
                {scheduledPauseValidation.fieldErrors.start && (
                  <div className="field-error">{scheduledPauseValidation.fieldErrors.start}</div>
                )}
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>End</label>
                <input
                  className={`input ${scheduledPauseValidation.fieldErrors.end ? "input-invalid" : ""}`}
                  type="text"
                  placeholder="17:00"
                  value={scheduledPause.end}
                  onChange={(e) => setScheduledPause((prev) => ({ ...prev, end: e.target.value }))}
                  style={{ width: 80 }}
                />
                {scheduledPauseValidation.fieldErrors.end && (
                  <div className="field-error">{scheduledPauseValidation.fieldErrors.end}</div>
                )}
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>Days (0=Sun, 6=Sat)</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  {DAY_LABELS.map((label, i) => (
                    <label key={i} className="checkbox" style={{ marginRight: 4 }}>
                      <input
                        type="checkbox"
                        checked={scheduledPause.days?.includes(i) ?? false}
                        onChange={() => toggleScheduledPauseDay(i)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {scheduledPauseValidation.fieldErrors.days && (
                  <div className="field-error">{scheduledPauseValidation.fieldErrors.days}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="field-label">Blocklist health check</label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
            Validate blocklist URLs before apply. When enabled, apply can fail if sources are unreachable.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={healthCheck.enabled}
              onChange={(e) =>
                setHealthCheck((prev) => ({ ...prev, enabled: e.target.checked }))
              }
            />
            Validate blocklist URLs before apply
          </label>
          {healthCheck.enabled && (
            <label className="checkbox" style={{ display: "block", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={healthCheck.fail_on_any}
                onChange={(e) =>
                  setHealthCheck((prev) => ({ ...prev, fail_on_any: e.target.checked }))
                }
              />
              Fail apply if any source fails
            </label>
          )}
          <div style={{ marginTop: 12 }}>
            <button
              className="button"
              onClick={checkBlocklistHealth}
              disabled={healthCheckLoading}
            >
              {healthCheckLoading ? "Checking…" : "Check health now"}
            </button>
          </div>
          {healthCheckResults && (
            <div style={{ marginTop: 12 }}>
              {healthCheckResults.error ? (
                <div className="error">{healthCheckResults.error}</div>
              ) : (
                <div className="table-container">
                  <div className="table-header">
                    <span>Source</span>
                    <span>URL</span>
                    <span>Status</span>
                  </div>
                  {(healthCheckResults.sources || []).map((s, i) => (
                    <div key={i} className="table-row">
                      <span>{s.name || "-"}</span>
                      <span className="mono" style={{ fontSize: 12 }}>{s.url || "-"}</span>
                      <span>
                        {s.ok ? (
                          <span className="badge active">OK</span>
                        ) : (
                          <span className="badge paused" title={s.error}>{s.error || "Failed"}</span>
                        )}
                      </span>
                    </div>
                  ))}
                  {(!healthCheckResults.sources || healthCheckResults.sources.length === 0) && (
                    <div className="table-row muted">No sources to check</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      )}

      {activeTab === "dns" && (
      <>
      <section className="section">
        <div className="section-header">
          <h2>Upstream Resolvers</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveUpstreams}
              disabled={upstreamsLoading || upstreamValidation.hasErrors}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={confirmApplyUpstreams}
              disabled={upstreamsLoading || upstreamValidation.hasErrors}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        {isReplica && <p className="muted">DNS settings are managed by the primary instance.</p>}
        <p className="muted">
          Configure upstream DNS resolvers and how queries are distributed. Changes take effect immediately when applied.
        </p>
        {upstreamsStatus && <p className="status">{upstreamsStatus}</p>}
        {upstreamsError && <div className="error">{upstreamsError}</div>}

        <div className="form-group">
          <label className="field-label">Resolver strategy</label>
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}>
            How to distribute queries across upstreams: Failover tries in order and uses the next on failure; Load Balance round-robins; Weighted prefers faster upstreams by response time.
          </p>
          <select
            className="input"
            value={resolverStrategy}
            onChange={(e) => setResolverStrategy(e.target.value)}
            style={{ maxWidth: "280px" }}
          >
            {RESOLVER_STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} – {opt.desc}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="field-label">Upstream timeout</label>
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}>
            How long to wait for upstream DNS responses (e.g. 10s, 30s). Increase if seeing &quot;i/o timeout&quot; errors on refresh.
          </p>
          <input
            className="input"
            type="text"
            value={upstreamTimeout}
            onChange={(e) => setUpstreamTimeout(e.target.value)}
            placeholder="10s"
            style={{ maxWidth: "120px" }}
          />
        </div>

        <div className="form-group">
          <label className="field-label">Upstream servers</label>
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}>
            Add DNS resolvers to use. Use host:port for plain DNS (e.g. 1.1.1.1:53), tls://host:853 for DoT, or https://host/dns-query for DoH. Order matters for failover strategy.
          </p>
          <div className="list">
            {upstreams.map((u, index) => (
              <div key={index}>
                <div className="list-row">
                  <input
                    className="input"
                    placeholder="Name (e.g. cloudflare)"
                    value={u.name || ""}
                    onChange={(e) => updateUpstream(index, "name", e.target.value)}
                    style={{ minWidth: "100px" }}
                  />
                  <input
                    className={`input ${
                      upstreamValidation.rowErrors[index]?.address ? "input-invalid" : ""
                    }`}
                    placeholder="1.1.1.1:53, tls://host:853, or https://host/dns-query"
                    value={u.address || ""}
                    onChange={(e) => updateUpstream(index, "address", e.target.value)}
                    style={{ minWidth: "180px" }}
                  />
                  <select
                    className={`input ${
                      upstreamValidation.rowErrors[index]?.protocol ? "input-invalid" : ""
                    }`}
                    value={u.protocol || "udp"}
                    onChange={(e) => updateUpstream(index, "protocol", e.target.value)}
                    style={{ minWidth: "80px" }}
                  >
                    <option value="udp">UDP</option>
                    <option value="tcp">TCP</option>
                    <option value="tls">DoT</option>
                    <option value="https">DoH</option>
                  </select>
                  <button
                    className="icon-button"
                    onClick={() => removeUpstream(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(upstreamValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(upstreamValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          {upstreamValidation.generalErrors.map((message) => (
            <div key={message} className="field-error">
              {message}
            </div>
          ))}
          <button className="button" onClick={addUpstream}>
            Add upstream
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Local DNS Records</h2>
          {!isReplica && (
          <div className="actions">
            <button
              className="button"
              onClick={saveLocalRecords}
              disabled={localRecordsLoading || localRecordsValidation.hasErrors}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={confirmApplyLocalRecords}
              disabled={localRecordsLoading || localRecordsValidation.hasErrors}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        <p className="muted">
          Local records are returned immediately without upstream lookup. They work even when the internet is down.
        </p>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
          Use A for IPv4, AAAA for IPv6, CNAME for aliases, TXT for text records, or PTR for reverse lookups. Name can be a hostname (e.g. router.local); value is the IP or target.
        </p>
        {localRecordsStatus && <p className="status">{localRecordsStatus}</p>}
        {localRecordsError && <div className="error">{localRecordsError}</div>}

        <div className="form-group">
          <label className="field-label">Records</label>
          <div className="list">
            {localRecords.map((rec, index) => (
              <div key={index}>
                <div className="list-row">
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.name
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="Name (e.g. router.local)"
                    value={rec.name || ""}
                    onChange={(e) => updateLocalRecord(index, "name", e.target.value)}
                  />
                  <select
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.type
                        ? "input-invalid"
                        : ""
                    }`}
                    value={rec.type || "A"}
                    onChange={(e) => updateLocalRecord(index, "type", e.target.value)}
                  >
                    <option value="A">A</option>
                    <option value="AAAA">AAAA</option>
                    <option value="CNAME">CNAME</option>
                    <option value="TXT">TXT</option>
                    <option value="PTR">PTR</option>
                  </select>
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.value
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="Value (IP or hostname)"
                    value={rec.value || ""}
                    onChange={(e) => updateLocalRecord(index, "value", e.target.value)}
                  />
                  <button
                    className="icon-button"
                    onClick={() => removeLocalRecord(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(localRecordsValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(localRecordsValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button className="button" onClick={addLocalRecord}>
            Add record
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Blocked Response</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveResponse}
              disabled={responseLoading || responseValidation.hasErrors}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={confirmApplyResponse}
              disabled={responseLoading || responseValidation.hasErrors}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        {isReplica && <p className="muted">Response config is managed by the primary instance.</p>}
        <p className="muted">
          How to respond when a domain is blocked. Use nxdomain (NXDOMAIN) or an IP address (e.g. 0.0.0.0) to sinkhole.
        </p>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
          Response type: nxdomain returns NXDOMAIN (domain does not exist); 0.0.0.0 or another IP sinkholes to that address. Blocked TTL controls how long clients cache the response (e.g. 1h).
        </p>
        {responseStatus && <p className="status">{responseStatus}</p>}
        {responseError && <div className="error">{responseError}</div>}

        <div className="form-group">
          <label className="field-label">Response type</label>
          <input
            className={`input ${
              responseValidation.fieldErrors.blocked ? "input-invalid" : ""
            }`}
            placeholder="nxdomain or 0.0.0.0"
            value={responseBlocked}
            onChange={(e) => setResponseBlocked(e.target.value)}
            style={{ maxWidth: "200px" }}
          />
          {responseValidation.fieldErrors.blocked && (
            <div className="field-error">
              {responseValidation.fieldErrors.blocked}
            </div>
          )}
        </div>
        <div className="form-group">
          <label className="field-label">Blocked TTL</label>
          <input
            className={`input ${
              responseValidation.fieldErrors.blockedTtl ? "input-invalid" : ""
            }`}
            placeholder="1h"
            value={responseBlockedTtl}
            onChange={(e) => setResponseBlockedTtl(e.target.value)}
            style={{ maxWidth: "120px" }}
          />
          {responseValidation.fieldErrors.blockedTtl && (
            <div className="field-error">
              {responseValidation.fieldErrors.blockedTtl}
            </div>
          )}
        </div>

        <div className="form-group" style={{ marginTop: 32 }}>
          <div className="section-header">
            <h2 style={{ margin: 0 }}>Safe Search</h2>
            {isReplica ? (
              <span className="badge muted">Synced from primary</span>
            ) : (
            <div className="actions">
              <button
                className="button"
                onClick={saveSafeSearch}
                disabled={safeSearchLoading}
              >
                Save
              </button>
              <button
                className="button primary"
                onClick={confirmApplySafeSearch}
                disabled={safeSearchLoading}
              >
                Apply changes
              </button>
            </div>
            )}
          </div>
          <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
            Force safe search for Google and Bing. Redirects search queries to family-friendly results.
          </p>
          {safeSearchStatus && <p className="status">{safeSearchStatus}</p>}
          {safeSearchError && <div className="error">{safeSearchError}</div>}
          {!isReplica && (
            <>
              <label className="checkbox" style={{ display: "block", marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={safeSearchEnabled}
                  onChange={(e) => setSafeSearchEnabled(e.target.checked)}
                />
                Enable safe search
              </label>
              {safeSearchEnabled && (
                <div style={{ marginLeft: 20 }}>
                  <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={safeSearchGoogle}
                      onChange={(e) => setSafeSearchGoogle(e.target.checked)}
                    />
                    Google (forcesafesearch.google.com)
                  </label>
                  <label className="checkbox" style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      checked={safeSearchBing}
                      onChange={(e) => setSafeSearchBing(e.target.checked)}
                    />
                    Bing (strict.bing.com)
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      </>
      )}

      {activeTab === "sync" && (
      <section className="section">
        <div className="section-header">
          <h2>Instance Sync</h2>
          {syncStatus?.enabled && (
            <span className={`badge ${syncStatus.role === "primary" ? "primary" : "muted"}`}>
              {syncStatus.role === "primary" ? "Primary" : "Replica"}
            </span>
          )}
        </div>
        {syncError && <div className="error">{syncError}</div>}
        {!syncStatus ? (
          <p className="muted">Loading sync status...</p>
        ) : !syncStatus.enabled ? (
          <>
            <h3>Enable Sync</h3>
            <p className="muted">Keep multiple instances in sync: one primary (source of truth) and replicas that pull config from it.</p>
            <div className="form-group">
              <label className="field-label">Role</label>
              <select
                className="input"
                value={syncConfigRole}
                onChange={(e) => setSyncConfigRole(e.target.value)}
                style={{ maxWidth: "280px" }}
              >
                <option value="primary">Primary — source of truth for DNS config</option>
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
                  <input
                    className="input"
                    placeholder="http://localhost:80"
                    value={syncSettingsStatsSourceUrl}
                    onChange={(e) => setSyncSettingsStatsSourceUrl(e.target.value)}
                  />
                  <p className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                    This replica&apos;s web server URL (port 80, not 8080). For response distribution and latency in Multi-Instance view.
                  </p>
                </div>
              </>
            )}
            <button
              className="button primary"
              onClick={() => saveSyncConfig(true, syncConfigRole, syncConfigRole === "replica" ? {
                primary_url: syncSettingsPrimaryUrl,
                sync_token: syncSettingsToken,
                sync_interval: syncSettingsInterval || "60s",
                stats_source_url: syncSettingsStatsSourceUrl,
              } : null)}
              disabled={
                syncConfigLoading ||
                (syncConfigRole === "replica" && syncEnableReplicaValidation.hasErrors)
              }
            >
              {syncConfigLoading ? "Saving..." : "Enable sync"}
            </button>
            {syncConfigStatus && <p className="status">{syncConfigStatus}</p>}
            {syncConfigError && <div className="error">{syncConfigError}</div>}
          </>
        ) : syncStatus.role === "primary" ? (
          <>
            <h3>Sync Tokens</h3>
            <p className="muted">Create tokens for replicas to authenticate when pulling config.</p>
            <div className="form-group" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <input
                className="input"
                placeholder="Token name (e.g. Replica A)"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                style={{ maxWidth: "200px" }}
              />
              <button className="button primary" onClick={createSyncToken} disabled={syncLoading}>
                Create token
              </button>
            </div>
            {createdToken && (
              <div className="status" style={{ marginTop: "12px", padding: "12px", background: "#f0f0f0", borderRadius: "4px" }}>
                <strong>New token (copy now, it will not be shown again):</strong>
                <pre style={{ margin: "8px 0 0", wordBreak: "break-all" }}>{createdToken}</pre>
              </div>
            )}
            <div className="form-group" style={{ marginTop: "24px" }}>
              <label className="field-label">Active tokens</label>
              {syncStatus.tokens?.length === 0 ? (
                <p className="muted">No tokens yet. Create one above.</p>
              ) : (
                <div className="list">
                  {syncStatus.tokens?.map((t) => (
                    <div key={t.index} className="list-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                      <span>
                        {t.name || "Unnamed"} — {t.id}
                        {t.last_used && (
                          <span className="muted" style={{ marginLeft: "8px", fontSize: "0.9em" }}>
                            (last pulled: {new Date(t.last_used).toLocaleString()})
                          </span>
                        )}
                      </span>
                      <button
                        className="icon-button"
                        onClick={() => revokeSyncToken(t.index)}
                        disabled={syncLoading}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="form-group" style={{ marginTop: "24px", paddingTop: "16px", borderTop: "1px solid #eee" }}>
              <button className="button" onClick={disableSync} disabled={syncConfigLoading}>
                Disable sync
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Replica Settings</h3>
            <p className="muted">Configure connection to primary. Restart the application after saving.</p>
            {syncStatus.last_pulled_at && (
              <div className="card" style={{ marginBottom: "16px" }}>
                <div className="card-label">Sync status</div>
                <div className="card-value">Last pulled: {new Date(syncStatus.last_pulled_at).toLocaleString()}</div>
              </div>
            )}
            <div className="form-group">
              <label className="field-label">Primary URL</label>
              <input
                className={`input ${
                  syncSettingsValidation.fieldErrors.primaryUrl ? "input-invalid" : ""
                }`}
                placeholder="http://primary-host:8081"
                value={syncSettingsPrimaryUrl}
                onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
              />
              {syncSettingsValidation.fieldErrors.primaryUrl && (
                <div className="field-error">
                  {syncSettingsValidation.fieldErrors.primaryUrl}
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label">Sync token</label>
              <input
                className={`input ${
                  syncSettingsValidation.fieldErrors.syncToken ? "input-invalid" : ""
                }`}
                type="password"
                placeholder="Token from primary"
                value={syncSettingsToken}
                onChange={(e) => setSyncSettingsToken(e.target.value)}
              />
              {syncSettingsValidation.fieldErrors.syncToken && (
                <div className="field-error">
                  {syncSettingsValidation.fieldErrors.syncToken}
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label">Sync interval</label>
              <input
                className={`input ${
                  syncSettingsValidation.fieldErrors.syncInterval ? "input-invalid" : ""
                }`}
                placeholder="60s"
                value={syncSettingsInterval}
                onChange={(e) => setSyncSettingsInterval(e.target.value)}
              />
              {syncSettingsValidation.fieldErrors.syncInterval && (
                <div className="field-error">
                  {syncSettingsValidation.fieldErrors.syncInterval}
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label">Stats source URL (optional)</label>
              <input
                className="input"
                placeholder="http://localhost:80"
                value={syncSettingsStatsSourceUrl}
                onChange={(e) => setSyncSettingsStatsSourceUrl(e.target.value)}
              />
              <p className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                This replica&apos;s web server URL (port 80, not 8080). For response distribution and latency in Multi-Instance view. Leave empty if not used.
              </p>
            </div>
            <button
              className="button primary"
              onClick={saveSyncSettings}
              disabled={syncSettingsValidation.hasErrors}
            >
              Save settings
            </button>
            {syncSettingsStatus && <p className="status">{syncSettingsStatus}</p>}
            {syncSettingsError && <div className="error">{syncSettingsError}</div>}
            <div className="form-group" style={{ marginTop: "24px", paddingTop: "16px", borderTop: "1px solid #eee" }}>
              <button className="button" onClick={disableSync} disabled={syncConfigLoading}>
                Disable sync
              </button>
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "system" && (
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
          Most settings require a restart to take effect. Client Identification applies immediately when saved.
        </p>
        {systemConfigStatus && <p className="status">{systemConfigStatus}</p>}
        {systemConfigError && <div className="error">{systemConfigError}</div>}
        {!systemConfig ? (
          <p className="muted">Loading...</p>
        ) : (
          <>
            <h3>Server</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              DNS server listen addresses and timeouts. Restart required.
            </p>
            <div className="form-group">
              <label className="field-label">Listen addresses (comma-separated)</label>
              <input
                className="input"
                value={systemConfig.server?.listen || ""}
                onChange={(e) => updateSystemConfig("server", "listen", e.target.value)}
                placeholder="0.0.0.0:53"
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Addresses and ports to listen on (e.g. 0.0.0.0:53 for all interfaces, or 127.0.0.1:53 for localhost only).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Protocols</label>
              <input
                className="input"
                value={systemConfig.server?.protocols || "udp, tcp"}
                onChange={(e) => updateSystemConfig("server", "protocols", e.target.value)}
                placeholder="udp, tcp"
                style={{ maxWidth: "150px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Comma-separated: udp, tcp. Both are typically needed for compatibility.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Read timeout</label>
              <input
                className="input"
                value={systemConfig.server?.read_timeout || ""}
                onChange={(e) => updateSystemConfig("server", "read_timeout", e.target.value)}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Max time to wait for reading a DNS request (e.g. 5s, 10s). Increase if clients are slow.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Write timeout</label>
              <input
                className="input"
                value={systemConfig.server?.write_timeout || ""}
                onChange={(e) => updateSystemConfig("server", "write_timeout", e.target.value)}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Max time to wait for writing a DNS response (e.g. 5s, 10s).
              </p>
            </div>
            <div className="form-group">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={systemConfig.server?.reuse_port === true}
                  onChange={(e) => updateSystemConfig("server", "reuse_port", e.target.checked)}
                />
                {" "}SO_REUSEPORT (multiple listeners on same port)
              </label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Enables multiple UDP/TCP listeners on the same port for better throughput on multi-core systems.
              </p>
            </div>
            {systemConfig.server?.reuse_port && (
              <div className="form-group">
                <label className="field-label">Reuse port listeners</label>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={64}
                    value={systemConfig.server?.reuse_port_listeners ?? 4}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      updateSystemConfig("server", "reuse_port_listeners", Number.isNaN(v) ? 4 : Math.max(1, Math.min(64, v)));
                    }}
                    style={{ maxWidth: "80px" }}
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={async () => {
                      setCpuDetectLoading(true);
                      try {
                        const res = await fetch("/api/system/cpu-count");
                        if (!res.ok) throw new Error("Failed to detect");
                        const { cpuCount } = await res.json();
                        updateSystemConfig("server", "reuse_port_listeners", cpuCount);
                      } catch {
                        // Silently fail; user can still set manually
                      } finally {
                        setCpuDetectLoading(false);
                      }
                    }}
                    disabled={cpuDetectLoading}
                  >
                    {cpuDetectLoading ? "Detecting…" : "Auto-detect"}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  Number of listeners per address (1–64). Default: CPU thread count.
                </p>
              </div>
            )}

            <h3>Cache (Redis)</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Redis cache settings. TTLs control how long responses are cached. Restart required.
            </p>
            <div className="form-group">
              <label className="field-label">Redis address</label>
              <input
                className="input"
                value={systemConfig.cache?.redis_address || ""}
                onChange={(e) => updateSystemConfig("cache", "redis_address", e.target.value)}
                placeholder="redis:6379"
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Redis host and port (e.g. redis:6379 for Docker, localhost:6379 for local).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Redis DB</label>
              <input
                className="input"
                type="number"
                min={0}
                value={systemConfig.cache?.redis_db ?? 0}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("cache", "redis_db", Number.isNaN(v) ? 0 : Math.max(0, v));
                }}
                style={{ maxWidth: "80px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Redis database number (0–15). Use different DBs to isolate multiple instances.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Redis password</label>
              <input
                className="input"
                type="password"
                value={systemConfig.cache?.redis_password || ""}
                onChange={(e) => updateSystemConfig("cache", "redis_password", e.target.value)}
                placeholder="Leave empty if no auth"
                style={{ maxWidth: "200px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Redis AUTH password. Leave empty if Redis has no password.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Redis mode</label>
              <select
                className="input"
                value={systemConfig.cache?.redis_mode || "standalone"}
                onChange={(e) => updateSystemConfig("cache", "redis_mode", e.target.value)}
                style={{ maxWidth: "150px" }}
              >
                <option value="standalone">Standalone</option>
                <option value="sentinel">Sentinel (HA)</option>
                <option value="cluster">Cluster</option>
              </select>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Standalone = single Redis. Sentinel = HA with failover. Cluster = sharded Redis.
              </p>
            </div>
            {(systemConfig.cache?.redis_mode === "sentinel") && (
              <>
                <div className="form-group">
                  <label className="field-label">Sentinel master name</label>
                  <input
                    className="input"
                    value={systemConfig.cache?.redis_master_name || ""}
                    onChange={(e) => updateSystemConfig("cache", "redis_master_name", e.target.value)}
                    placeholder="mymaster"
                    style={{ maxWidth: "150px" }}
                  />
                </div>
                <div className="form-group">
                  <label className="field-label">Sentinel addresses (comma-separated)</label>
                  <input
                    className="input"
                    value={systemConfig.cache?.redis_sentinel_addrs || ""}
                    onChange={(e) => updateSystemConfig("cache", "redis_sentinel_addrs", e.target.value)}
                    placeholder="sentinel1:26379, sentinel2:26379"
                  />
                </div>
              </>
            )}
            {(systemConfig.cache?.redis_mode === "cluster") && (
              <div className="form-group">
                <label className="field-label">Cluster addresses (comma-separated)</label>
                <input
                  className="input"
                  value={systemConfig.cache?.redis_cluster_addrs || ""}
                  onChange={(e) => updateSystemConfig("cache", "redis_cluster_addrs", e.target.value)}
                  placeholder="redis1:6379, redis2:6379, redis3:6379"
                />
              </div>
            )}
            <div className="form-group">
              <label className="field-label">Redis LRU size</label>
              <input
                className="input"
                type="number"
                min={0}
                value={systemConfig.cache?.redis_lru_size ?? 10000}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("cache", "redis_lru_size", Number.isNaN(v) ? 10000 : Math.max(0, v));
                }}
                style={{ maxWidth: "100px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                L0 in-memory cache size. 0 disables. Higher values reduce Redis lookups for hot keys.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Min TTL</label>
              <input
                className="input"
                value={systemConfig.cache?.min_ttl || ""}
                onChange={(e) => updateSystemConfig("cache", "min_ttl", e.target.value)}
                placeholder="300s"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Minimum cache TTL. Responses with shorter TTLs are extended to this (e.g. 300s, 5m).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Max TTL</label>
              <input
                className="input"
                value={systemConfig.cache?.max_ttl || ""}
                onChange={(e) => updateSystemConfig("cache", "max_ttl", e.target.value)}
                placeholder="1h"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Maximum cache TTL. Longer upstream TTLs are capped to this (e.g. 1h, 24h).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Negative TTL</label>
              <input
                className="input"
                value={systemConfig.cache?.negative_ttl || "5m"}
                onChange={(e) => updateSystemConfig("cache", "negative_ttl", e.target.value || "5m")}
                placeholder="5m"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                How long to cache NXDOMAIN and other negative responses (e.g. 5m). Reduces repeated lookups for non-existent domains.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Servfail backoff</label>
              <input
                className="input"
                value={systemConfig.cache?.servfail_backoff || "60s"}
                onChange={(e) => updateSystemConfig("cache", "servfail_backoff", e.target.value || "60s")}
                placeholder="60s"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Duration to wait before retrying after upstream SERVFAIL (e.g. 60s). Helps avoid hammering a misconfigured upstream.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Servfail refresh threshold</label>
              <input
                className="input"
                type="number"
                min={0}
                value={systemConfig.cache?.servfail_refresh_threshold ?? 10}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("cache", "servfail_refresh_threshold", Number.isNaN(v) ? 10 : Math.max(0, v));
                }}
                placeholder="10"
                style={{ maxWidth: "80px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Stop retrying refresh after this many SERVFAILs (0 = no limit). Prevents endless retries for persistently failing domains.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Servfail log interval</label>
              <input
                className="input"
                value={systemConfig.cache?.servfail_log_interval ?? ""}
                onChange={(e) => updateSystemConfig("cache", "servfail_log_interval", e.target.value)}
                placeholder="default: servfail_backoff"
                style={{ maxWidth: "180px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Min interval between servfail log messages per cache key (e.g. 60s). Helps avoid log spam. Default: servfail_backoff. 0 = no limit.
              </p>
            </div>
            <div className="form-group">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={systemConfig.cache?.respect_source_ttl === true}
                  onChange={(e) => updateSystemConfig("cache", "respect_source_ttl", e.target.checked)}
                />
                {" "}Respect source TTL (no min_ttl extension)
              </label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                When enabled, do not extend short TTLs with min_ttl. Use for strict Unbound-style behavior; may increase upstream load.
              </p>
            </div>
            <h4 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>Advanced (Refresh Sweeper)</h4>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
              The sweeper refreshes entries nearing expiry. Entries with fewer queries in the &quot;hit window&quot; are deleted instead of refreshed to limit memory use.
            </p>
            <div className="form-group">
              <label className="field-label">Min hits to refresh</label>
              <input
                className="input"
                type="number"
                min={0}
                value={systemConfig.cache?.sweep_min_hits ?? 1}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("cache", "sweep_min_hits", Number.isNaN(v) ? 1 : Math.max(0, v));
                }}
                placeholder="1"
                style={{ maxWidth: "100px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Minimum queries in the hit window for an entry to be refreshed. 0 = refresh all entries.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Hit window</label>
              <input
                className="input"
                value={systemConfig.cache?.sweep_hit_window || "168h"}
                onChange={(e) => updateSystemConfig("cache", "sweep_hit_window", e.target.value || "168h")}
                placeholder="168h"
                style={{ maxWidth: "120px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                How far back to count queries (e.g. 48h, 168h). Entries need at least min hits in this window to be refreshed.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Hit count sample rate</label>
              <input
                className="input"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={systemConfig.cache?.hit_count_sample_rate ?? 1}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  updateSystemConfig("cache", "hit_count_sample_rate", Number.isNaN(v) ? 1 : Math.max(0.01, Math.min(1, v)));
                }}
                placeholder="1"
                style={{ maxWidth: "100px" }}
                title="Fraction of cache hits to count in Redis (0.01–1.0). Lower values reduce Redis load."
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Fraction of hits to count (0.01–1.0). Use &lt;1.0 on high-QPS instances to reduce Redis load.
              </p>
            </div>

            <h3>Query Store (ClickHouse)</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Query store settings (including flush intervals) are not replicated via sync; each instance uses its own. Restart required.
            </p>
            <div className="form-group">
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={systemConfig.query_store?.enabled !== false}
                  onChange={(e) => updateSystemConfig("query_store", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                When enabled, DNS queries are sent to ClickHouse for analytics. Disable to run without ClickHouse (e.g. Queries tab will be empty).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Address</label>
              <input
                className="input"
                value={systemConfig.query_store?.address || ""}
                onChange={(e) => updateSystemConfig("query_store", "address", e.target.value)}
                placeholder="http://clickhouse:8123"
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                ClickHouse HTTP interface URL (e.g. http://clickhouse:8123 for Docker, http://localhost:8123 for local).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Database</label>
              <input
                className="input"
                value={systemConfig.query_store?.database || ""}
                onChange={(e) => updateSystemConfig("query_store", "database", e.target.value)}
                placeholder="beyond_ads"
                style={{ maxWidth: "200px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                ClickHouse database name. Create it in ClickHouse if it does not exist.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Table</label>
              <input
                className="input"
                value={systemConfig.query_store?.table || ""}
                onChange={(e) => updateSystemConfig("query_store", "table", e.target.value)}
                placeholder="dns_queries"
                style={{ maxWidth: "200px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Table name for query events. The app creates it on first write if missing.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Username</label>
              <input
                className="input"
                value={systemConfig.query_store?.username || "default"}
                onChange={(e) => updateSystemConfig("query_store", "username", e.target.value)}
                placeholder="default"
                style={{ maxWidth: "150px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                ClickHouse user for authentication.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Password</label>
              <input
                className="input"
                type="password"
                value={systemConfig.query_store?.password || ""}
                onChange={(e) => updateSystemConfig("query_store", "password", e.target.value)}
                placeholder="Leave empty if no auth"
                style={{ maxWidth: "200px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                ClickHouse password. Leave empty if ClickHouse has no password.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Flush to store interval</label>
              <input
                className="input"
                value={systemConfig.query_store?.flush_to_store_interval || "5s"}
                onChange={(e) => updateSystemConfig("query_store", "flush_to_store_interval", e.target.value || "5s")}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
                title="How often the app sends buffered events to ClickHouse (e.g. 5m, 1m, 30s). Not replicated via sync."
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                How often the app sends buffered query events to ClickHouse.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Flush to disk interval</label>
              <input
                className="input"
                value={systemConfig.query_store?.flush_to_disk_interval || "5s"}
                onChange={(e) => updateSystemConfig("query_store", "flush_to_disk_interval", e.target.value || "5s")}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
                title="How often ClickHouse flushes async inserts to disk (e.g. 5m, 1m, 30s). Not replicated via sync."
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                How often ClickHouse flushes buffered inserts to disk (async_insert_busy_timeout_ms).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Batch size</label>
              <input
                className="input"
                type="number"
                min={1}
                value={systemConfig.query_store?.batch_size ?? 2000}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("query_store", "batch_size", Number.isNaN(v) || v < 1 ? 2000 : v);
                }}
                style={{ maxWidth: "100px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Max events per batch sent to ClickHouse. Larger batches reduce write frequency but increase memory.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Retention days</label>
              <input
                className="input"
                type="number"
                min={1}
                value={systemConfig.query_store?.retention_days ?? 7}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("query_store", "retention_days", Number.isNaN(v) || v < 1 ? 7 : v);
                }}
                style={{ maxWidth: "80px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Days to keep query data. Older data is dropped. Lower values save disk; higher keep more history.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Sample rate</label>
              <input
                className="input"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={systemConfig.query_store?.sample_rate ?? 1}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  updateSystemConfig("query_store", "sample_rate", Number.isNaN(v) ? 1 : Math.max(0.01, Math.min(1, v)));
                }}
                style={{ maxWidth: "80px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Fraction of queries to record (0.01–1.0). 1.0 = all. Use &lt;1.0 at high QPS to reduce ClickHouse load.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Anonymize client IP</label>
              <select
                className="input"
                value={systemConfig.query_store?.anonymize_client_ip || "none"}
                onChange={(e) => updateSystemConfig("query_store", "anonymize_client_ip", e.target.value)}
                style={{ maxWidth: "150px" }}
              >
                <option value="none">None</option>
                <option value="hash">Hash (SHA256 prefix)</option>
                <option value="truncate">Truncate (/24 IPv4, /64 IPv6)</option>
              </select>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                For GDPR/privacy: hash anonymizes fully; truncate keeps subnet for analytics while hiding host.
              </p>
            </div>

            <h3>Data Management</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Clear cached or stored data. Use when troubleshooting or resetting analytics.
            </p>
            <div className="form-group" style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="button"
                onClick={clearRedisCache}
                disabled={clearRedisLoading}
              >
                {clearRedisLoading ? "Clearing…" : "Clear Redis cache"}
              </button>
              <button
                type="button"
                className="button"
                onClick={clearClickhouseData}
                disabled={clearClickhouseLoading || !systemConfig?.query_store?.enabled}
              >
                {clearClickhouseLoading ? "Clearing…" : "Clear ClickHouse"}
              </button>
            </div>
            {clearRedisError && <div className="error" style={{ marginTop: "0.5rem" }}>{clearRedisError}</div>}
            {clearClickhouseError && <div className="error" style={{ marginTop: "0.5rem" }}>{clearClickhouseError}</div>}
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Clear Redis: removes all DNS cache entries and metadata from Redis. Clear ClickHouse: truncates the query store table (all query analytics data).
            </p>

            <h3>Client Identification</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Map client IPs to friendly names for per-device analytics. Enables &quot;Which device queries X?&quot; in query logs. Applies immediately when saved.
            </p>
            <div className="form-group">
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={systemConfig.client_identification?.enabled === true}
                  onChange={(e) => updateSystemConfig("client_identification", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
            </div>
            <div className="form-group">
              <label className="field-label">Client mappings (IP → name)</label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}>
                Map client IP addresses to friendly names (e.g. 192.168.1.10 → kids-phone). Used in Queries tab for per-device analytics.
              </p>
              {(systemConfig.client_identification?.clients || []).map((c, i) => (
                <div key={i} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                  <input
                    className="input"
                    placeholder="IP (e.g. 192.168.1.10)"
                    value={c.ip || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], ip: e.target.value };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ flex: 1, maxWidth: "180px" }}
                  />
                  <span>→</span>
                  <input
                    className="input"
                    placeholder="Name (e.g. kids-phone)"
                    value={c.name || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], name: e.target.value };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ flex: 1, maxWidth: "180px" }}
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const clients = (systemConfig.client_identification?.clients || []).filter((_, j) => j !== i);
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                onClick={() => {
                  const clients = [...(systemConfig.client_identification?.clients || []), { ip: "", name: "" }];
                  updateSystemConfig("client_identification", "clients", clients);
                }}
              >
                Add client
              </button>
            </div>

            <h3>Control API</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Control API for config management, blocklist reload, and sync. Used by the web UI and replicas. Restart required.
            </p>
            <div className="form-group">
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={systemConfig.control?.enabled !== false}
                  onChange={(e) => updateSystemConfig("control", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
            </div>
            <div className="form-group">
              <label className="field-label">Listen address</label>
              <input
                className="input"
                value={systemConfig.control?.listen || ""}
                onChange={(e) => updateSystemConfig("control", "listen", e.target.value)}
                placeholder="0.0.0.0:8081"
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Address and port for the control API (e.g. 0.0.0.0:8081). Restrict to localhost in production if not using sync.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">API token</label>
              <input
                className="input"
                type="password"
                value={systemConfig.control?.token || ""}
                onChange={(e) => updateSystemConfig("control", "token", e.target.value)}
                placeholder="Leave empty for no auth"
                style={{ maxWidth: "250px" }}
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Optional token for API auth. When set, requests must include the token. Leave empty for open access (e.g. behind firewall).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Error persistence</label>
              <label className="checkbox" style={{ display: "block", marginBottom: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={systemConfig.control?.errors_enabled !== false}
                  onChange={(e) => updateSystemConfig("control", "errors_enabled", e.target.checked)}
                />
                {" "}Enabled (persist errors to disk)
              </label>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}>
                When enabled, DNS errors are persisted to a log file for the Error Viewer. Configure retention below.
              </p>
              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                <div>
                  <label className="field-label" style={{ fontSize: 12 }}>Retention days</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={systemConfig.control?.errors_retention_days ?? 7}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      updateSystemConfig("control", "errors_retention_days", Number.isNaN(v) || v < 1 ? 7 : v);
                    }}
                    style={{ maxWidth: "80px" }}
                  />
                </div>
                <div>
                  <label className="field-label" style={{ fontSize: 12 }}>Directory</label>
                  <input
                    className="input"
                    value={systemConfig.control?.errors_directory || "logs"}
                    onChange={(e) => updateSystemConfig("control", "errors_directory", e.target.value)}
                    placeholder="logs"
                    style={{ maxWidth: "120px" }}
                  />
                </div>
                <div>
                  <label className="field-label" style={{ fontSize: 12 }}>Filename prefix</label>
                  <input
                    className="input"
                    value={systemConfig.control?.errors_filename_prefix || "errors"}
                    onChange={(e) => updateSystemConfig("control", "errors_filename_prefix", e.target.value)}
                    placeholder="errors"
                    style={{ maxWidth: "120px" }}
                  />
                </div>
                <div>
                  <label className="field-label" style={{ fontSize: 12 }}>Log level</label>
                  <select
                    className="input"
                    value={systemConfig.control?.errors_log_level || "warning"}
                    onChange={(e) => updateSystemConfig("control", "errors_log_level", e.target.value)}
                    style={{ maxWidth: "120px" }}
                    title="Minimum severity to buffer: error (only errors), warning (errors+warnings), info, or debug (all)"
                  >
                    <option value="error">Error only</option>
                    <option value="warning">Warning (default)</option>
                    <option value="info">Info</option>
                    <option value="debug">Debug (all)</option>
                  </select>
                  <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    Minimum level to buffer. Default: warning.
                  </p>
                </div>
              </div>
            </div>

            <h3>Application Logging</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Format and level for structured application logs (slog). JSON format is recommended for Grafana/Loki integration. Restart required.
            </p>
            <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>Format</label>
                <select
                  className="input"
                  value={systemConfig.logging?.format || "text"}
                  onChange={(e) => updateSystemConfig("logging", "format", e.target.value)}
                  style={{ maxWidth: "120px" }}
                  title="JSON: structured output for log aggregation (Grafana/Loki). Text: human-readable."
                >
                  <option value="text">Text (human-readable)</option>
                  <option value="json">JSON (for Grafana/Loki)</option>
                </select>
                <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                  JSON recommended for log aggregation.
                </p>
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>Level</label>
                <select
                  className="input"
                  value={systemConfig.logging?.level || systemConfig.control?.errors_log_level || "warning"}
                  onChange={(e) => updateSystemConfig("logging", "level", e.target.value)}
                  style={{ maxWidth: "120px" }}
                  title="Minimum severity to output: error, warning, info, or debug"
                >
                  <option value="error">Error only</option>
                  <option value="warning">Warning (default)</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug (all)</option>
                </select>
                <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                  Minimum level to output to stdout.
                </p>
              </div>
            </div>

            <h3>Request Log</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Log DNS requests to disk (text or JSON). Useful for debugging and external analysis. Restart required.
            </p>
            <div className="form-group">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={systemConfig.request_log?.enabled === true}
                  onChange={(e) => updateSystemConfig("request_log", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
            </div>
            {systemConfig.request_log?.enabled && (
              <>
                <div className="form-group">
                  <label className="field-label">Directory</label>
                  <input
                    className="input"
                    value={systemConfig.request_log?.directory || "logs"}
                    onChange={(e) => updateSystemConfig("request_log", "directory", e.target.value)}
                    placeholder="logs"
                    style={{ maxWidth: "150px" }}
                  />
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    Directory for log files (e.g. logs). Files are rotated daily.
                  </p>
                </div>
                <div className="form-group">
                  <label className="field-label">Filename prefix</label>
                  <input
                    className="input"
                    value={systemConfig.request_log?.filename_prefix || "dns-requests"}
                    onChange={(e) => updateSystemConfig("request_log", "filename_prefix", e.target.value)}
                    placeholder="dns-requests"
                    style={{ maxWidth: "150px" }}
                  />
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    Prefix for log files (e.g. dns-requests-2025-02-15.log).
                  </p>
                </div>
                <div className="form-group">
                  <label className="field-label">Format</label>
                  <select
                    className="input"
                    value={systemConfig.request_log?.format || "text"}
                    onChange={(e) => updateSystemConfig("request_log", "format", e.target.value)}
                    style={{ maxWidth: "120px" }}
                  >
                    <option value="text">Text</option>
                    <option value="json">JSON</option>
                  </select>
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    Text = human-readable. JSON = structured with query_id, qname, outcome, latency for parsing.
                  </p>
                </div>
              </>
            )}

            <h3>UI</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Display settings for the web interface. Restart required.
            </p>
            <div className="form-group">
              <label className="field-label">Hostname (displayed in header)</label>
              <input
                className="input"
                value={systemConfig.ui?.hostname || ""}
                onChange={(e) => updateSystemConfig("ui", "hostname", e.target.value)}
                placeholder="Leave empty for system hostname"
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                Override the hostname shown in the UI header. Leave empty to use the system hostname.
              </p>
            </div>

            <h3>Usage tips</h3>
            <details className="form-group" style={{ marginTop: "0.5rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 500 }}>Performance and tuning tips</summary>
              <ul className="muted" style={{ fontSize: "0.9rem", marginTop: "0.75rem", paddingLeft: "1.25rem", lineHeight: 1.6 }}>
                <li><strong>Hit count sample rate</strong> — Hit counts use a local sharded cache and return immediately; Redis is updated asynchronously. Use 0.1 or 0.05 to further reduce Redis write load if needed.</li>
                <li><strong>Min TTL / Max TTL</strong> — Shorter TTLs mean more upstream lookups but fresher data. Longer TTLs reduce load but may serve stale records longer.</li>
                <li><strong>Flush intervals (Query Store)</strong> — Longer intervals reduce ClickHouse load but delay query visibility. Shorter intervals increase write frequency.</li>
                <li><strong>Retention days</strong> — Lower values save disk; higher values keep more history for analytics.</li>
                <li><strong>Read/Write timeout</strong> — Increase if clients or upstreams are slow; default 5s is usually sufficient.</li>
              </ul>
            </details>
          </>
        )}
      </section>
      )}

      {activeTab === "integrations" && (
      <section className="section">
        <div className="section-header">
          <h2>Integrations</h2>
        </div>
        <p className="muted">Manage webhooks for block and error events. Webhooks send HTTP POST requests to your configured URLs when DNS queries are blocked or result in errors. Restart required after saving.</p>
        {webhooksError && <div className="error">{webhooksError}</div>}
        {webhooksStatus && <div className="success">{webhooksStatus}</div>}
        {webhooksLoading && !webhooksData ? (
          <SkeletonCard />
        ) : webhooksData ? (
          <div className="integrations-webhooks">
            {[
              { key: "on_block", label: "Block webhook", description: "Fires when a DNS query is blocked by the blocklist (ads, trackers, malware)." },
              { key: "on_error", label: "Error webhook", description: "Fires when a DNS query results in an error (upstream failure, SERVFAIL, invalid query)." },
            ].map(({ key, label, description }) => {
              const hook = webhooksData[key] || {};
              const targetTypes = webhooksData.targets || [];
              const hookTargets = Array.isArray(hook.targets) ? hook.targets : [];
              return (
                <CollapsibleSection
                  key={key}
                  id={`webhook-${key}`}
                  title={label}
                  defaultCollapsed={false}
                  collapsedSections={collapsedSections}
                  onToggle={setCollapsedSections}
                >
                  <p className="muted" style={{ marginTop: 0 }}>{description}</p>
                  <div className="integrations-form">
                    <div className="form-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={hook.enabled ?? false}
                          onChange={(e) => {
                            setWebhooksData((prev) => ({
                              ...prev,
                              [key]: { ...prev[key], enabled: e.target.checked },
                            }));
                          }}
                        />
                        <span>Enable webhook</span>
                      </label>
                    </div>
                    <div className="form-row" style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                      <label>
                        Rate limit (max messages in timeframe, default for new targets)
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.25rem" }}>
                          <input
                            type="number"
                            className="input"
                            min={-1}
                            max={10000}
                            style={{ width: 100 }}
                            value={hook.rate_limit_max_messages ?? 60}
                            onChange={(e) => setWebhooksData((prev) => ({
                              ...prev,
                              [key]: { ...prev[key], rate_limit_max_messages: e.target.value === "" ? 60 : Number(e.target.value) },
                            }))}
                            placeholder="60"
                          />
                          <span className="muted">per</span>
                          <input
                            type="text"
                            className="input"
                            style={{ width: 100 }}
                            value={hook.rate_limit_timeframe ?? "1m"}
                            onChange={(e) => setWebhooksData((prev) => ({
                              ...prev,
                              [key]: { ...prev[key], rate_limit_timeframe: e.target.value || "1m" },
                            }))}
                            placeholder="1m"
                            list="timeframe-suggestions"
                          />
                          <datalist id="timeframe-suggestions">
                            <option value="30s" />
                            <option value="1m" />
                            <option value="5m" />
                            <option value="15m" />
                            <option value="1h" />
                          </datalist>
                        </div>
                      </label>
                      <span className="muted" style={{ fontSize: 12 }}>Use -1 for unlimited. Timeframe: 30s, 1m, 5m, 1h, etc.</span>
                    </div>
                    <div className="form-row">
                      <label>Targets (each target gets its own URL, format, and context)</label>
                      <div className="webhook-targets-list">
                        {hookTargets.map((tgt, idx) => (
                          <div key={idx} className="webhook-target-card">
                            <div className="form-row">
                              <label>
                                URL <span className="required">*</span>
                                <input
                                  type="url"
                                  className="input"
                                  value={tgt.url || ""}
                                  onChange={(e) => {
                                    const next = [...hookTargets];
                                    next[idx] = { ...next[idx], url: e.target.value };
                                    setWebhooksData((prev) => ({ ...prev, [key]: { ...prev[key], targets: next } }));
                                  }}
                                  placeholder="https://example.com/webhook"
                                />
                              </label>
                            </div>
                            <div className="form-row">
                              <label>
                                Format
                                <select
                                  className="input"
                                  value={tgt.target || "default"}
                                  onChange={(e) => {
                                    const next = [...hookTargets];
                                    next[idx] = { ...next[idx], target: e.target.value };
                                    setWebhooksData((prev) => ({ ...prev, [key]: { ...prev[key], targets: next } }));
                                  }}
                                >
                                  {targetTypes.map((t) => (
                                    <option key={t.id} value={t.id}>{t.label}</option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="form-row">
                              <label>Context (optional metadata for this target)</label>
                              <div className="context-items">
                                {Object.entries(tgt.context || {}).map(([k, v]) => (
                                  <div key={k} className="context-item">
                                    <input type="text" className="input" value={k} readOnly style={{ width: 120 }} />
                                    <span className="context-value">{Array.isArray(v) ? v.join(", ") : String(v)}</span>
                                    <button
                                      type="button"
                                      className="button"
                                      onClick={() => {
                                        const ctx = { ...(tgt.context || {}) };
                                        delete ctx[k];
                                        const next = [...hookTargets];
                                        next[idx] = { ...next[idx], context: ctx };
                                        setWebhooksData((prev) => ({ ...prev, [key]: { ...prev[key], targets: next } }));
                                      }}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                                <div className="context-add">
                                  <input
                                    type="text"
                                    id={`ctx-key-${key}-${idx}`}
                                    className="input"
                                    placeholder="Key (e.g. environment)"
                                    style={{ width: 140 }}
                                  />
                                  <input
                                    type="text"
                                    id={`ctx-val-${key}-${idx}`}
                                    className="input"
                                    placeholder="Value or comma-separated list"
                                    style={{ width: 180 }}
                                  />
                                  <button
                                    type="button"
                                    className="button"
                                    onClick={() => {
                                      const keyInput = document.getElementById(`ctx-key-${key}-${idx}`);
                                      const valInput = document.getElementById(`ctx-val-${key}-${idx}`);
                                      const k = (keyInput?.value || "").trim();
                                      const v = (valInput?.value || "").trim();
                                      if (!k) return;
                                      const parsed = v.includes(",") ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
                                      const ctx = { ...(tgt.context || {}) };
                                      ctx[k] = Array.isArray(parsed) && parsed.length > 1 ? parsed : (parsed || "");
                                      const next = [...hookTargets];
                                      next[idx] = { ...next[idx], context: ctx };
                                      setWebhooksData((prev) => ({ ...prev, [key]: { ...prev[key], targets: next } }));
                                      if (keyInput) keyInput.value = "";
                                      if (valInput) valInput.value = "";
                                    }}
                                  >
                                    Add
                                  </button>
                                </div>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="button"
                              onClick={() => {
                                const next = hookTargets.filter((_, i) => i !== idx);
                                setWebhooksData((prev) => ({ ...prev, [key]: { ...prev[key], targets: next } }));
                                if (webhookTestResult?.key === key) setWebhookTestResult(null);
                              }}
                            >
                              Remove target
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            const next = [...hookTargets, { url: "", target: "default", context: {} }];
                            setWebhooksData((prev) => ({ ...prev, [key]: { ...prev[key], targets: next } }));
                          }}
                        >
                          Add target
                        </button>
                      </div>
                    </div>
                    <div className="form-row integrations-actions">
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          setWebhooksData((prev) => ({
                            ...prev,
                            [key]: { enabled: false, targets: [], rate_limit_max_messages: 60, rate_limit_timeframe: "1m" },
                          }));
                          setWebhookTestResult(null);
                        }}
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={async () => {
                          setWebhookTestResult(null);
                          const validTargets = hookTargets.filter((t) => t?.url?.trim());
                          if (validTargets.length === 0) {
                            setWebhookTestResult({ key, ok: false, error: "Add at least one target with URL" });
                            return;
                          }
                          try {
                            const res = await fetch("/api/webhooks/test", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                type: key,
                                targets: validTargets.map((t) => ({
                                  url: t.url,
                                  target: t.target || "default",
                                  context: t.context || {},
                                })),
                              }),
                            });
                            const data = await res.json();
                            setWebhookTestResult({
                              key,
                              ok: data.ok,
                              message: data.message,
                              error: data.error,
                              results: data.results,
                            });
                          } catch (err) {
                            setWebhookTestResult({ key, ok: false, error: err.message || "Test failed" });
                          }
                        }}
                        disabled={hookTargets.filter((t) => t?.url?.trim()).length === 0}
                      >
                        Test webhook
                      </button>
                      {webhookTestResult?.key === key && (
                        <span className={webhookTestResult.ok ? "success" : "error"}>
                          {webhookTestResult.ok ? webhookTestResult.message : webhookTestResult.error}
                          {webhookTestResult.results?.length > 1 && webhookTestResult.ok && (
                            <span className="muted" style={{ marginLeft: 8 }}>
                              ({webhookTestResult.results.map((r) => r.ok ? "✓" : "✗").join(" ")})
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </CollapsibleSection>
              );
            })}
            <div className="integrations-save">
              <button
                type="button"
                className="button button-primary"
                onClick={async () => {
                  setWebhooksStatus("");
                  setWebhooksError("");
                  try {
                    const res = await fetch("/api/webhooks", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        on_block: webhooksData.on_block,
                        on_error: webhooksData.on_error,
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || "Save failed");
                    setWebhooksStatus(data.message || "Saved");
                    addToast("Webhooks saved. Restart required to apply.", "success");
                    setConfirmState({
                      open: true,
                      title: "Restart required",
                      message: "Webhooks saved. Restart the DNS service to apply webhook changes.",
                      confirmLabel: "Restart",
                      cancelLabel: "Later",
                      variant: "danger",
                      onConfirm: restartService,
                    });
                  } catch (err) {
                    setWebhooksError(err.message || "Failed to save webhooks");
                  }
                }}
              >
                Save webhooks
              </button>
            </div>
          </div>
        ) : null}
      </section>
      )}

      {activeTab === "error-viewer" && (
      <section className="section">
        <div className="section-header">
          <h2>Error Viewer</h2>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setAppErrorsLoading(true);
                setAppErrorsError("");
                fetch("/api/errors")
                  .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error || `Request failed: ${r.status}`)))))
                  .then((data) => {
                    setAppErrors(Array.isArray(data.errors) ? data.errors : []);
                    setAppErrorsError("");
                  })
                  .catch((err) => {
                    setAppErrors([]);
                    setAppErrorsError(err.message || "Failed to load errors");
                  })
                  .finally(() => setAppErrorsLoading(false));
              }}
              disabled={appErrorsLoading}
            >
              {appErrorsLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        <p className="muted">Recent application errors from the DNS resolver. Data is pulled from the control API /errors endpoint.</p>
        <div className="error-viewer-controls" style={{ marginBottom: "0.5rem" }}>
          <div className="error-viewer-filters">
            <label className="field-label" style={{ fontSize: 12, marginRight: "0.5rem" }}>Log level</label>
            <select
              className="input"
              value={errorLogLevel}
              onChange={async (e) => {
                const level = e.target.value;
                const prevLevel = errorLogLevel;
                setErrorLogLevel(level);
                setErrorLogLevelStatus("");
                setErrorLogLevelSaving(true);
                try {
                  const res = await fetch("/api/errors/log-level", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ log_level: level }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `Save failed: ${res.status}`);
                  setErrorLogLevelStatus(data.message || "Saved. Restart DNS service to apply.");
                  addToast("Log level saved. Restart the DNS service to apply.", "info");
                } catch (err) {
                  setErrorLogLevelStatus("");
                  setErrorLogLevel(prevLevel);
                  addToast(err.message || "Failed to save log level", "error");
                } finally {
                  setErrorLogLevelSaving(false);
                }
              }}
              disabled={errorLogLevelSaving}
              style={{ width: "auto", minWidth: 120 }}
              title="Minimum severity to buffer: error (only errors), warning (errors+warnings), info, or debug (all)"
            >
              <option value="error">Error only</option>
              <option value="warning">Warning (default)</option>
              <option value="info">Info</option>
              <option value="debug">Debug (all)</option>
            </select>
            {errorLogLevelStatus && <span className="muted" style={{ marginLeft: "0.5rem", fontSize: 12 }}>{errorLogLevelStatus}</span>}
          </div>
        </div>
        {appErrorsError && <div className="error">{appErrorsError}</div>}
        {appErrorsLoading && appErrors.length === 0 ? (
          <SkeletonCard />
        ) : appErrors.length === 0 ? (
          <EmptyState title="No errors recorded" description="The DNS resolver has not recorded any errors." />
        ) : (
          <>
            <div className="error-viewer-controls">
              <div className="error-viewer-filters">
                <input
                  type="text"
                  className="input filter-input"
                  placeholder="Filter by message..."
                  value={errorFilterText}
                  onChange={(e) => setErrorFilterText(e.target.value)}
                  style={{ maxWidth: 280 }}
                />
                <select
                  className="input"
                  value={errorSeverityFilter}
                  onChange={(e) => setErrorSeverityFilter(e.target.value)}
                  style={{ width: "auto", minWidth: 120 }}
                  title="Filter by severity"
                >
                  <option value="all">All levels</option>
                  <option value="error">Error</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug</option>
                </select>
                <div className="error-viewer-sort">
                  <span className="error-viewer-sort-label">Sort:</span>
                  <select
                    className="input"
                    value={`${errorSortBy}-${errorSortDir}`}
                    onChange={(e) => {
                      const [by, dir] = e.target.value.split("-");
                      setErrorSortBy(by);
                      setErrorSortDir(dir);
                    }}
                    style={{ width: "auto", minWidth: 140 }}
                  >
                    <option value="date-desc">Date (newest first)</option>
                    <option value="date-asc">Date (oldest first)</option>
                    <option value="message-asc">Message (A–Z)</option>
                    <option value="message-desc">Message (Z–A)</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="error-viewer-list">
              {(() => {
                const filterLower = errorFilterText.trim().toLowerCase();
                const normalized = appErrors.map((err, idx) => {
                  const rawMsg = typeof err === "string" ? err : err?.message ?? JSON.stringify(err);
                  const ts = typeof err === "object" && err?.timestamp ? err.timestamp : null;
                  const tsLocal = ts ? new Date(ts).toLocaleString() : null;
                  const severity = typeof err === "object" && err?.severity ? String(err.severity).toLowerCase() : "error";
                  const docRef = typeof err === "object" && err?.doc_ref ? err.doc_ref : null;
                  const parsed = parseSlogMessage(rawMsg);
                  const msg = parsed?.msg ?? rawMsg;
                  const attrs = parsed?.attrs ?? {};
                  const isStructured = parsed?.isStructured ?? false;
                  const display = typeof err === "string" ? err : err?.message && err?.timestamp ? `[${tsLocal}] ${err.message}` : JSON.stringify(err, null, 2);
                  return { idx, msg, rawMsg, ts, severity, display, docRef, attrs, isStructured, tsLocal };
                });
                let filtered = normalized;
                if (filterLower) {
                  filtered = filtered.filter((e) => e.msg.toLowerCase().includes(filterLower));
                }
                if (errorSeverityFilter !== "all") {
                  filtered = filtered.filter((e) => e.severity === errorSeverityFilter);
                }
                const sorted = [...filtered].sort((a, b) => {
                  if (errorSortBy === "date") {
                    const ta = a.ts ? new Date(a.ts).getTime() : 0;
                    const tb = b.ts ? new Date(b.ts).getTime() : 0;
                    if (ta !== tb) return errorSortDir === "desc" ? tb - ta : ta - tb;
                    return a.idx - b.idx;
                  }
                  const cmp = a.msg.localeCompare(b.msg, undefined, { sensitivity: "base" });
                  return errorSortDir === "desc" ? -cmp : cmp;
                });
                if (sorted.length === 0) {
                  return <p className="muted">No errors match the filter.</p>;
                }
                const errorTotal = sorted.length;
                const errorTotalPages = Math.max(1, Math.ceil(errorTotal / errorPageSize));
                const safePage = Math.min(errorPage, errorTotalPages);
                const errorCanPrev = safePage > 1;
                const errorCanNext = safePage < errorTotalPages;
                const paginated = sorted.slice((safePage - 1) * errorPageSize, safePage * errorPageSize);
                return (
                  <>
                    {paginated.map((e) => (
                      <div key={e.idx} className="error-viewer-item">
                        <div className="error-viewer-item-header">
                          {e.severity && (
                            <span className={`error-viewer-severity error-viewer-severity-${e.severity}`}>
                              {e.severity}
                            </span>
                          )}
                          {e.tsLocal && (
                            <span className="error-viewer-timestamp" title={e.ts}>
                              {e.tsLocal}
                            </span>
                          )}
                          <div className="error-viewer-actions">
                            {e.docRef && (
                              <a
                                href={`/api/docs/errors.html#${encodeURIComponent(e.docRef)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="button error-viewer-doc-link"
                              >
                                Documentation
                              </a>
                            )}
                            <button
                              type="button"
                              className="button error-viewer-doc-link"
                              onClick={() => {
                                const isInfo = e.severity === "info" || e.severity === "debug";
                                const prompt = isInfo
                                  ? `I'm looking at this informational log from my DNS resolver (beyond-ads-dns: https://github.com/tternquist/beyond-ads-dns):\n\n${e.display}\n\nCan you explain what this log message means, what it indicates about the system's behavior, and any relevant context from the beyond-ads-dns cache refresh architecture?`
                                  : `I'm seeing this error in my DNS resolver (beyond-ads-dns: https://github.com/tternquist/beyond-ads-dns):\n\n${e.display}\n\nCan you explain what it means and suggest possible causes and fixes?`;
                                const url = `https://chat.openai.com/?q=${encodeURIComponent(prompt)}`;
                                window.open(url, "_blank", "noopener noreferrer");
                                addToast("Opening ChatGPT with prompt pre-filled.", "info");
                              }}
                            >
                              Ask ChatGPT
                            </button>
                          </div>
                        </div>
                        {e.isStructured ? (
                          <div className="error-viewer-body">
                            <div className="error-viewer-message">{e.msg || "(no message)"}</div>
                            {Object.keys(e.attrs).length > 0 && (
                              <div className="error-viewer-attrs">
                                {Object.entries(e.attrs).map(([k, v]) => (
                                  <span key={k} className="error-viewer-attr">
                                    <span className="error-viewer-attr-key">{k}</span>={String(v)}
                                  </span>
                                ))}
                              </div>
                            )}
                            <details className="error-viewer-raw-toggle">
                              <summary>View raw log</summary>
                              <pre className="error-viewer-raw">{e.rawMsg}</pre>
                            </details>
                          </div>
                        ) : (
                          <pre className="error-viewer-raw">{e.display}</pre>
                        )}
                      </div>
                    ))}
                    <div className="table-footer">
                      <span>
                        Page {safePage} of {errorTotalPages} • {formatNumber(errorTotal)} total
                      </span>
                      <div className="pagination">
                        <label className="select">
                          Page size
                          <select
                            value={errorPageSize}
                            onChange={(e) => {
                              setErrorPageSize(Number(e.target.value));
                              setErrorPage(1);
                            }}
                          >
                            {[10, 25, 50, 100].map((size) => (
                              <option key={size} value={size}>
                                {size}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="button"
                          onClick={() => setErrorPage((prev) => Math.max(1, prev - 1))}
                          disabled={!errorCanPrev}
                        >
                          Prev
                        </button>
                        <button
                          className="button"
                          onClick={() =>
                            setErrorPage((prev) => Math.min(errorTotalPages, prev + 1))
                          }
                          disabled={!errorCanNext}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "config" && (
      <section className="section">
        <div className="section-header">
          <h2>Active Configuration</h2>
          <div className="actions">
            <label className="button">
              Import
              <input
                type="file"
                accept=".yaml,.yml"
                onChange={importConfig}
                style={{ display: "none" }}
              />
            </label>
            <label className="select" title="Export mode: portable removes hostname and replica config for sharing across instances">
              <select
                value={configExportExcludeInstanceDetails ? "portable" : "exact"}
                onChange={(e) => setConfigExportExcludeInstanceDetails(e.target.value === "portable")}
                aria-label="Export mode"
              >
                <option value="portable">Export: Remove instance details</option>
                <option value="exact">Export: Exact replica</option>
              </select>
            </label>
            <button className="button primary" onClick={exportConfig}>
              Export
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
        {configError && <div className="error">{configError}</div>}
        {importStatus && <p className="status">{importStatus}</p>}
        {importError && <div className="error">{importError}</div>}
        {restartError && <div className="error">{restartError}</div>}
        <ConfigViewer config={activeConfig} />
      </section>
      )}
    </div>
      </main>
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel ?? "Cancel"}
        variant={confirmState.variant || "primary"}
        onConfirm={() => {
          if (confirmState.onConfirm) confirmState.onConfirm();
          setConfirmState({ open: false });
        }}
        onCancel={() => setConfirmState({ open: false })}
      />
    </div>
  );
}

