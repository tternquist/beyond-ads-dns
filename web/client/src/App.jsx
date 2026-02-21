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
  SUGGESTED_BLOCKLISTS,
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
  SETTINGS_SHOW_ADVANCED_KEY,
  BLOCKABLE_SERVICES,
} from "./utils/constants.js";
import { formatNumber, formatUtcToLocalTime, formatUtcToLocalDateTime, formatPercent, formatPctFromDistribution, formatErrorPctFromDistribution } from "./utils/format.js";
import {
  validateBlocklistForm,
  validateScheduledPauseForm,
  validateFamilyTimeForm,
  validateUpstreamsForm,
  validateLocalRecordsForm,
  validateReplicaSyncSettings,
  validateResponseForm,
  getRowErrorText,
  isValidDuration,
} from "./utils/validation.js";
import { buildQueryParams } from "./utils/queryParams.js";
import { api } from "./utils/apiClient.js";
import { useDebounce } from "./hooks/useDebounce.js";
import Tooltip from "./components/Tooltip.jsx";
import { TabIcon } from "./components/SidebarIcons.jsx";
import AppLogo from "./components/AppLogo.jsx";
import StatCard from "./components/StatCard.jsx";
import DonutChart from "./components/DonutChart.jsx";
import FilterInput from "./components/FilterInput.jsx";
import DomainEditor from "./components/DomainEditor.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import ConfigViewer from "./components/ConfigViewer.jsx";
import { useToast } from "./context/ToastContext.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import QueriesPage from "./pages/QueriesPage.jsx";
import ReplicaStatsPage from "./pages/ReplicaStatsPage.jsx";
import BlocklistsPage from "./pages/BlocklistsPage.jsx";
import ClientsPage from "./pages/ClientsPage.jsx";
import DnsPage from "./pages/DnsPage.jsx";
import SyncPage from "./pages/SyncPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import IntegrationsPage from "./pages/IntegrationsPage.jsx";
import ErrorViewerPage from "./pages/ErrorViewerPage.jsx";
import {
  normalizeDomainForBlocklist,
  isDomainBlockedByDenylist,
  isDomainInAllowlist,
  getDenylistEntriesBlocking,
  isServiceBlockedByDenylist,
  escapeDomainForRegex,
} from "./utils/blocklist.js";

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

function loadSettingsShowAdvanced() {
  try {
    const stored = localStorage.getItem(SETTINGS_SHOW_ADVANCED_KEY);
    if (stored === null) return false;
    return JSON.parse(stored);
  } catch {
    return false;
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

export default function App() {
  const { addToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const pathSegment = location.pathname.replace(/^\//, "").split("/")[0] || "";
  const rawTab = (pathSegment.trim() || "overview").toLowerCase();
  // Normalize system-settings -> system for backwards compatibility
  const activeTab = rawTab === "system-settings" ? "system" : rawTab;
  const setActiveTab = (tab) => navigate(tab === "overview" ? "/" : `/${tab}`);

  // Redirect /system-settings to canonical /system
  useEffect(() => {
    if (rawTab === "system-settings") {
      navigate("/system", { replace: true });
    }
  }, [rawTab, navigate]);
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
  const [filterSearch, setFilterSearch] = useState("");
  const [filterQName, setFilterQName] = useState("");
  const [filterOutcome, setFilterOutcome] = useState("");
  const [filterRcode, setFilterRcode] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterQtype, setFilterQtype] = useState("");
  const [filterProtocol, setFilterProtocol] = useState("");
  const [filterSinceMinutes, setFilterSinceMinutes] = useState("");
  const [filterMinLatency, setFilterMinLatency] = useState("");
  const [filterMaxLatency, setFilterMaxLatency] = useState("");
  const [queryFiltersExpanded, setQueryFiltersExpanded] = useState(false);
  const debouncedFilterSearch = useDebounce(filterSearch, 300);
  const debouncedFilterQName = useDebounce(filterQName, 300);
  const debouncedFilterClient = useDebounce(filterClient, 300);
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
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(loadSettingsShowAdvanced);
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
  const [passwordEditable, setPasswordEditable] = useState(false);
  const [canSetInitialPassword, setCanSetInitialPassword] = useState(false);
  const [adminCurrentPassword, setAdminCurrentPassword] = useState("");
  const [adminNewPassword, setAdminNewPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");
  const [adminPasswordLoading, setAdminPasswordLoading] = useState(false);
  const [adminPasswordError, setAdminPasswordError] = useState("");
  const [adminPasswordStatus, setAdminPasswordStatus] = useState("");
  const [localRecords, setLocalRecords] = useState([]);
  const [localRecordsError, setLocalRecordsError] = useState("");
  const [localRecordsStatus, setLocalRecordsStatus] = useState("");
  const [localRecordsLoading, setLocalRecordsLoading] = useState(false);
  const [upstreams, setUpstreams] = useState([]);
  const [resolverStrategy, setResolverStrategy] = useState("failover");
  const [upstreamTimeout, setUpstreamTimeout] = useState("10s");
  const [upstreamBackoff, setUpstreamBackoff] = useState("30s");
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
  const [autodetectLoading, setAutodetectLoading] = useState(false);
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
  const [traceEvents, setTraceEvents] = useState([]);
  const [traceEventsAll, setTraceEventsAll] = useState([]);
  const [traceEventsLoading, setTraceEventsLoading] = useState(false);
  const [traceEventsSaving, setTraceEventsSaving] = useState(false);
  const [traceEventsExpanded, setTraceEventsExpanded] = useState(false);
  const [webhooksData, setWebhooksData] = useState(null);
  const [webhooksError, setWebhooksError] = useState("");
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [webhooksStatus, setWebhooksStatus] = useState("");
  const [webhookTestResult, setWebhookTestResult] = useState(null);
  const [discoveredClients, setDiscoveredClients] = useState(null);
  const [discoverClientsLoading, setDiscoverClientsLoading] = useState(false);
  const [discoverClientsError, setDiscoverClientsError] = useState("");
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
  const familyTimeValidation = validateFamilyTimeForm({
    enabled: familyTime.enabled,
    start: familyTime.start,
    end: familyTime.end,
    days: familyTime.days,
    services: familyTime.services,
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
      await api.post("/api/auth/logout");
    } finally {
      window.location.reload();
    }
  };

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

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/sync/status", { signal: controller.signal });
        if (!isMounted) return;
        setSyncStatus(data);
        setSyncError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setSyncStatus(null);
        setSyncError(err.message || "Failed to load sync status");
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
    const loadQueries = async () => {
      try {
        const params = buildQueryParams({
          queryPage,
          queryPageSize,
          querySortBy,
          querySortDir,
          filterSearch: debouncedFilterSearch,
          filterQName: debouncedFilterQName,
          filterOutcome,
          filterRcode,
          filterClient: debouncedFilterClient,
          filterQtype,
          filterProtocol,
          filterSinceMinutes,
          filterMinLatency,
          filterMaxLatency,
        });
        const data = await api.get(`/api/queries/recent?${params}`, { signal: controller.signal });
        if (!isMounted) return;
        setQueryEnabled(Boolean(data.enabled));
        setQueryRows(Array.isArray(data.rows) ? data.rows : []);
        setQueryTotal(Number(data.total || 0));
        setQueryError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setQueryError(err.message || "Failed to load queries");
      }
    };
    loadQueries();
    const interval = setInterval(loadQueries, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [
    queryPage,
    queryPageSize,
    querySortBy,
    querySortDir,
    debouncedFilterSearch,
    debouncedFilterQName,
    filterOutcome,
    filterRcode,
    debouncedFilterClient,
    filterQtype,
    filterProtocol,
    filterSinceMinutes,
    filterMinLatency,
    filterMaxLatency,
  ]);

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
    const loadConfig = async () => {
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
    loadConfig();
    const interval = setInterval(loadConfig, 30000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
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
        if (err?.name === "AbortError") return;
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
    if (activeTab !== "replica-stats" || !syncStatus?.enabled || syncStatus?.role !== "primary") {
      return;
    }
    let isMounted = true;
    const controller = new AbortController();
    const loadInstanceStats = async () => {
      try {
        const data = await api.get("/api/instances/stats", { signal: controller.signal });
        if (!isMounted) return;
        setInstanceStats(data);
        setInstanceStatsError("");
        setInstanceStatsUpdatedAt(new Date());
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setInstanceStatsError(err.message || "Failed to load instance stats");
      }
    };
    loadInstanceStats();
    const interval = setInterval(loadInstanceStats, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [activeTab, syncStatus?.enabled, syncStatus?.role]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadStats = async () => {
      try {
        const data = await api.get("/api/blocklists/stats", { signal: controller.signal });
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
    const controller = new AbortController();
    const loadSummary = async () => {
      try {
        const data = await api.get(
          `/api/queries/summary?window_minutes=${queryWindowMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setQueryEnabled(Boolean(data.enabled));
        setQuerySummary(data);
        setQuerySummaryError("");
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

  const bucketMinutes = queryWindowMinutes <= 15 ? 1 : queryWindowMinutes <= 60 ? 5 : queryWindowMinutes <= 360 ? 15 : 60;

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
        setTimeSeries(data);
        setTimeSeriesError("");
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
        setQueryLatency(data);
        setQueryLatencyError("");
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
        setUpstreamStats(data);
        setUpstreamStatsError("");
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
    const loadFilterOptions = async () => {
      try {
        const data = await api.get(
          `/api/queries/filter-options?window_minutes=${queryWindowMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setFilterOptions(data.options || {});
        setFilterOptionsError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setFilterOptionsError(err.message || "Failed to load filter options");
      }
    };
    loadFilterOptions();
    const interval = setInterval(loadFilterOptions, 30000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadInfo = async () => {
      try {
        const data = await api.get("/api/info", { signal: controller.signal });
        if (!isMounted) return;
        setHostname(data.hostname || "");
        setAppInfo(data);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        console.warn("Failed to load hostname:", err);
      }
    };
    loadInfo();
    const interval = setInterval(loadInfo, 60000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
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

  useEffect(() => {
    if (activeTab === "sync" && syncStatus?.role === "replica") {
      setSyncSettingsPrimaryUrl(syncStatus.primary_url || "");
      setSyncSettingsToken(""); // Don't pre-fill token for security
      setSyncSettingsInterval(syncStatus.sync_interval || "60s");
      setSyncSettingsStatsSourceUrl(syncStatus.stats_source_url || "");
    }
  }, [activeTab, syncStatus]);

  useEffect(() => {
    if (activeTab !== "system" && activeTab !== "clients" && activeTab !== "error-viewer") return;
    let isMounted = true;
    const controller = new AbortController();
    setSystemConfigError("");
    const load = async () => {
      try {
        const data = await api.get("/api/system/config", { signal: controller.signal });
        if (!isMounted) return;
        setSystemConfig(data);
        if (["error", "warning", "info", "debug"].includes(data.control?.errors_log_level || "")) {
          setErrorLogLevel(data.control.errors_log_level);
        }
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
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "error-viewer") return;
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      setAppErrorsLoading(true);
      setAppErrorsError("");
      try {
        const data = await api.get("/api/errors", { signal: controller.signal });
        if (!isMounted) return;
        setAppErrors(Array.isArray(data.errors) ? data.errors : []);
        if (["error", "warning", "info", "debug"].includes(data.log_level)) {
          setErrorLogLevel(data.log_level);
        }
        setAppErrorsError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
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
      controller.abort();
      clearInterval(interval);
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "integrations") return;
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      setWebhooksLoading(true);
      setWebhooksError("");
      try {
        const data = await api.get("/api/webhooks", { signal: controller.signal });
        if (!isMounted) return;
        setWebhooksData(data);
        setWebhooksError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setWebhooksData(null);
        setWebhooksError(err.message || "Failed to load webhooks");
      } finally {
        if (isMounted) setWebhooksLoading(false);
      }
    };
    load();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [activeTab]);

  useEffect(() => {
    setErrorPage(1);
  }, [errorFilterText, errorSeverityFilter, errorSortBy, errorSortDir]);

  useEffect(() => {
    if (activeTab !== "error-viewer") return;
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      setTraceEventsLoading(true);
      try {
        const data = await api.get("/api/trace-events", { signal: controller.signal });
        if (!isMounted) return;
        setTraceEvents(Array.isArray(data.events) ? data.events : []);
        setTraceEventsAll(Array.isArray(data.all_events) ? data.all_events : []);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (isMounted) {
          setTraceEvents([]);
          setTraceEventsAll([]);
        }
      } finally {
        if (isMounted) setTraceEventsLoading(false);
      }
    };
    load();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "dns") return;
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
  }, [activeTab]);

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

  const onApplyQueryPreset = (preset) => {
    if (preset.id === "clear") {
      setFilterSearch("");
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
  };

  const onClearQueryFilters = () => {
    setFilterSearch("");
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

  const toggleShowAdvancedSettings = () => {
    setShowAdvancedSettings((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SETTINGS_SHOW_ADVANCED_KEY, JSON.stringify(next));
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
      filterSearch,
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

  const addSuggestedBlocklist = (suggestion) => {
    setBlocklistSources((prev) => [...prev, { name: suggestion.name, url: suggestion.url }]);
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
      const applied = await applyBlocklistsReload();
      if (applied) addToast(checked ? `Blocked ${service.name} for group` : `Unblocked ${service.name} for group`, "success");
    } catch (err) {
      addToast(err.message || "Failed to save", "error");
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
      const data = await api.put("/api/blocklists", body);
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
      const data = await api.put("/api/blocklists", body);
      setBlocklistStatus("Saved");
      return true;
    } catch (err) {
      setBlocklistError(err.message || "Failed to save blocklists");
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

  const applyBlocklists = async () => {
    setConfirmState({ open: false });
    const saved = await saveBlocklists();
    if (!saved) return;
    const applied = await applyBlocklistsReload();
    if (applied) addToast("Blocklists applied successfully", "success");
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
      const data = await api.get("/api/blocklists/resume", {
        method: "POST",
      });
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
    setConfirmState({ open: false });
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
    setConfirmState({
      open: true,
      title: "Apply local records",
      message: "This will update local DNS records immediately. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyLocalRecords,
    });
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
      setUpstreamsError(
        validation.summary || "Please fix validation errors before saving."
      );
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
    setConfirmState({ open: false });
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
    setConfirmState({ open: false });
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
      const data = await api.put("/api/dns/safe-search", {
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
    setConfirmState({ open: false });
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
      const data = await api.post("/api/sync/tokens", { name: newTokenName || "Replica" });
      setCreatedToken(data.token);
      setNewTokenName("");
      try {
        const statusData = await api.get("/api/sync/status");
        setSyncStatus(statusData);
      } catch { /* ignore */ }
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
      await api.del(`/api/sync/tokens/${index}`);
      try {
        const statusData = await api.get("/api/sync/status");
        setSyncStatus(statusData);
      } catch { /* ignore */ }
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
      const data = await api.put("/api/sync/settings", body);
      setSyncSettingsStatus(data.message || "Saved");
      try {
        const statusData = await api.get("/api/sync/status");
        setSyncStatus(statusData);
      } catch { /* ignore */ }
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
      const data = await api.put("/api/sync/config", body);
      setSyncConfigStatus(data.message || "Saved");
      try {
        const statusData = await api.get("/api/sync/status");
        setSyncStatus(statusData);
      } catch { /* ignore */ }
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

  const enableSyncAsReplica = () =>
    saveSyncConfig(true, "replica", {
      primary_url: syncSettingsPrimaryUrl,
      sync_token: syncSettingsToken,
      sync_interval: syncSettingsInterval,
      stats_source_url: syncSettingsStatsSourceUrl,
    });
  const enableSyncAsPrimary = () => saveSyncConfig(true, "primary");

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
      
      const data = await api.post("/api/config/import", parsed);
      
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
      try {
        const configData = await api.get("/api/config");
        setActiveConfig(configData);
      } catch { /* ignore */ }
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
      await api.post("/api/restart");
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
      if (field == null) {
        next[section] = value;
      } else {
        next[section] = { ...(next[section] || {}), [field]: value };
      }
      return next;
    });
    if (section === "logging" && field === "level" && ["error", "warning", "info", "debug"].includes(value)) {
      setErrorLogLevel(value);
    }
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
      setConfirmState({
        open: true,
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

  const saveSystemConfig = async (opts = {}) => {
    const { skipRestartPrompt = false } = opts;
    setSystemConfigStatus("");
    setSystemConfigError("");
    if (!systemConfig) return;
    try {
      setSystemConfigLoading(true);
      const data = await api.put("/api/system/config", systemConfig);
      setSystemConfigStatus(data.message || "Saved.");
      if (["error", "warning", "info", "debug"].includes(systemConfig.logging?.level || systemConfig.control?.errors_log_level || "")) {
        setErrorLogLevel(systemConfig.logging?.level || systemConfig.control?.errors_log_level);
      }
      // Apply Client Identification immediately (hot-reload, no restart needed)
      try {
        await api.post("/api/client-identification/apply");
        setSystemConfigStatus("Saved. Client Identification applied.");
      } catch {
        // Non-fatal: client identification reload failed, but config was saved
      }
      // Prompt user to restart for other settings (server, cache, query_store, control, logging, request_log, ui)
      // Skip when saving from Clients page (client identification applies immediately)
      if (!skipRestartPrompt) {
        setConfirmState({
          open: true,
          title: "Restart required",
          message: "Settings saved. Server, Cache, Query Store, Control, Application Logging, Request Log, and UI changes require a restart to take effect. Restart now?",
          confirmLabel: "Restart",
          cancelLabel: "Later",
          variant: "danger",
          onConfirm: restartService,
        });
      }
    } catch (err) {
      setSystemConfigError(err.message || "Failed to save system config");
    } finally {
      setSystemConfigLoading(false);
    }
  };

  const saveAdminPassword = async () => {
    setAdminPasswordError("");
    setAdminPasswordStatus("");
    const newPwd = adminNewPassword.trim();
    const confirm = adminConfirmPassword.trim();
    if (newPwd.length < 6) {
      setAdminPasswordError("Password must be at least 6 characters");
      return;
    }
    if (newPwd !== confirm) {
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
        addToast?.("Password set. You will need to log in.", "info");
        window.location.reload();
      }
    } catch (err) {
      setAdminPasswordError(err.message || "Failed to set password");
    } finally {
      setAdminPasswordLoading(false);
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
              {appInfo.load1 != null && (
                <>
                  {" · "}
                  <span>Load {appInfo.load1}</span>
                </>
              )}
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

      <ErrorBoundary>
      {activeTab === "overview" && (
        <OverviewPage
          pauseStatus={pauseStatus}
          pauseError={pauseError}
          pauseLoading={pauseLoading}
          isReplica={isReplica}
          resumeBlocking={resumeBlocking}
          pauseBlocking={pauseBlocking}
          queryWindowMinutes={queryWindowMinutes}
          setQueryWindowMinutes={setQueryWindowMinutes}
          querySummary={querySummary}
          querySummaryError={querySummaryError}
          queryEnabled={queryEnabled}
          statusCards={statusCards}
          statusTotal={statusTotal}
          timeSeries={timeSeries}
          bucketMinutes={bucketMinutes}
          upstreamStatsError={upstreamStatsError}
          upstreamStats={upstreamStats}
          queryLatencyError={queryLatencyError}
          queryLatency={queryLatency}
          cacheStatsError={cacheStatsError}
          cacheStats={cacheStats}
          stats={stats}
          collapsedSections={collapsedSections}
          toggleSection={toggleSection}
          refreshStatsError={refreshStatsError}
          refreshStats={refreshStats}
        />
      )}

      {activeTab === "queries" && (
        <QueriesPage
          queryError={queryError}
          queryEnabled={queryEnabled}
          queryRows={queryRows}
          queryTotal={queryTotal}
          queryPage={queryPage}
          setQueryPage={setQueryPage}
          queryPageSize={queryPageSize}
          setQueryPageSize={setQueryPageSize}
          querySortBy={querySortBy}
          querySortDir={querySortDir}
          toggleSort={toggleSort}
          filterSearch={filterSearch}
          setFilterSearch={setFilterSearch}
          filterQName={filterQName}
          setFilterQName={setFilterQName}
          filterOutcome={filterOutcome}
          setFilterOutcome={setFilterOutcome}
          filterRcode={filterRcode}
          setFilterRcode={setFilterRcode}
          filterClient={filterClient}
          setFilterClient={setFilterClient}
          filterQtype={filterQtype}
          setFilterQtype={setFilterQtype}
          filterProtocol={filterProtocol}
          setFilterProtocol={setFilterProtocol}
          filterSinceMinutes={filterSinceMinutes}
          setFilterSinceMinutes={setFilterSinceMinutes}
          filterMinLatency={filterMinLatency}
          setFilterMinLatency={setFilterMinLatency}
          filterMaxLatency={filterMaxLatency}
          setFilterMaxLatency={setFilterMaxLatency}
          setFilter={setFilter}
          filterOptions={filterOptions}
          queryFiltersExpanded={queryFiltersExpanded}
          setQueryFiltersExpanded={setQueryFiltersExpanded}
          totalPages={totalPages}
          canPrev={canPrev}
          canNext={canNext}
          exportCsv={exportCsv}
          isReplica={isReplica}
          allowlist={allowlist}
          denylist={denylist}
          blocklistLoading={blocklistLoading}
          addDomainToAllowlist={addDomainToAllowlist}
          addDomainToDenylist={addDomainToDenylist}
          removeDomainFromDenylist={removeDomainFromDenylist}
          onApplyPreset={onApplyQueryPreset}
          onClearFilters={onClearQueryFilters}
        />
      )}

      {activeTab === "replica-stats" && (
        <ReplicaStatsPage
          syncStatus={syncStatus}
          instanceStats={instanceStats}
          instanceStatsError={instanceStatsError}
        />
      )}

      {activeTab === "blocklists" && (
        <BlocklistsPage
          isReplica={isReplica}
          saveBlocklists={saveBlocklists}
          confirmApplyBlocklists={confirmApplyBlocklists}
          blocklistLoading={blocklistLoading}
          blocklistValidation={blocklistValidation}
          scheduledPauseValidation={scheduledPauseValidation}
          familyTimeValidation={familyTimeValidation}
          blocklistStatus={blocklistStatus}
          blocklistError={blocklistError}
          blocklistStatsError={blocklistStatsError}
          blocklistStats={blocklistStats}
          refreshInterval={refreshInterval}
          setRefreshInterval={setRefreshInterval}
          blocklistSources={blocklistSources}
          updateSource={updateSource}
          removeSource={removeSource}
          addSource={addSource}
          addSuggestedBlocklist={addSuggestedBlocklist}
          addDomain={addDomain}
          removeDomain={removeDomain}
          allowlist={allowlist}
          setAllowlist={setAllowlist}
          denylist={denylist}
          setDenylist={setDenylist}
          toggleServiceBlockingGlobal={toggleServiceBlockingGlobal}
          scheduledPause={scheduledPause}
          setScheduledPause={setScheduledPause}
          toggleScheduledPauseDay={toggleScheduledPauseDay}
          familyTime={familyTime}
          setFamilyTime={setFamilyTime}
          toggleFamilyTimeDay={toggleFamilyTimeDay}
          toggleFamilyTimeService={toggleFamilyTimeService}
          healthCheck={healthCheck}
          setHealthCheck={setHealthCheck}
          checkBlocklistHealth={checkBlocklistHealth}
          healthCheckLoading={healthCheckLoading}
          healthCheckResults={healthCheckResults}
        />
      )}

      {activeTab === "clients" && (
        <ClientsPage
          isReplica={isReplica}
          systemConfig={systemConfig}
          systemConfigLoading={systemConfigLoading}
          systemConfigStatus={systemConfigStatus}
          systemConfigError={systemConfigError}
          updateSystemConfig={updateSystemConfig}
          saveSystemConfig={saveSystemConfig}
          discoveredClients={discoveredClients}
          setDiscoveredClients={setDiscoveredClients}
          discoverClientsLoading={discoverClientsLoading}
          discoverClientsError={discoverClientsError}
          onDiscoverClients={onDiscoverClients}
          toggleServiceBlockingForGroup={toggleServiceBlockingForGroup}
        />
      )}

      {activeTab === "dns" && (
        <DnsPage
          isReplica={isReplica}
          upstreams={upstreams}
          resolverStrategy={resolverStrategy}
          setResolverStrategy={setResolverStrategy}
          upstreamTimeout={upstreamTimeout}
          setUpstreamTimeout={setUpstreamTimeout}
          upstreamBackoff={upstreamBackoff}
          setUpstreamBackoff={setUpstreamBackoff}
          upstreamsError={upstreamsError}
          upstreamsStatus={upstreamsStatus}
          upstreamsLoading={upstreamsLoading}
          upstreamValidation={upstreamValidation}
          saveUpstreams={saveUpstreams}
          confirmApplyUpstreams={confirmApplyUpstreams}
          updateUpstream={updateUpstream}
          removeUpstream={removeUpstream}
          addUpstream={addUpstream}
          addSuggestedUpstream={addSuggestedUpstream}
          localRecords={localRecords}
          localRecordsError={localRecordsError}
          localRecordsStatus={localRecordsStatus}
          localRecordsLoading={localRecordsLoading}
          localRecordsValidation={localRecordsValidation}
          saveLocalRecords={saveLocalRecords}
          confirmApplyLocalRecords={confirmApplyLocalRecords}
          updateLocalRecord={updateLocalRecord}
          removeLocalRecord={removeLocalRecord}
          addLocalRecord={addLocalRecord}
          responseBlocked={responseBlocked}
          setResponseBlocked={setResponseBlocked}
          responseBlockedTtl={responseBlockedTtl}
          setResponseBlockedTtl={setResponseBlockedTtl}
          responseError={responseError}
          responseStatus={responseStatus}
          responseLoading={responseLoading}
          responseValidation={responseValidation}
          saveResponse={saveResponse}
          confirmApplyResponse={confirmApplyResponse}
          safeSearchEnabled={safeSearchEnabled}
          setSafeSearchEnabled={setSafeSearchEnabled}
          safeSearchGoogle={safeSearchGoogle}
          setSafeSearchGoogle={setSafeSearchGoogle}
          safeSearchBing={safeSearchBing}
          setSafeSearchBing={setSafeSearchBing}
          safeSearchError={safeSearchError}
          safeSearchStatus={safeSearchStatus}
          safeSearchLoading={safeSearchLoading}
          saveSafeSearch={saveSafeSearch}
          confirmApplySafeSearch={confirmApplySafeSearch}
        />
      )}

      {activeTab === "sync" && (
        <SyncPage
          syncStatus={syncStatus}
          syncError={syncError}
          syncConfigRole={syncConfigRole}
          setSyncConfigRole={setSyncConfigRole}
          syncConfigLoading={syncConfigLoading}
          syncEnableReplicaValidation={syncEnableReplicaValidation}
          syncSettingsPrimaryUrl={syncSettingsPrimaryUrl}
          setSyncSettingsPrimaryUrl={setSyncSettingsPrimaryUrl}
          syncSettingsToken={syncSettingsToken}
          setSyncSettingsToken={setSyncSettingsToken}
          syncSettingsInterval={syncSettingsInterval}
          setSyncSettingsInterval={setSyncSettingsInterval}
          syncSettingsStatsSourceUrl={syncSettingsStatsSourceUrl}
          setSyncSettingsStatsSourceUrl={setSyncSettingsStatsSourceUrl}
          enableSyncAsReplica={enableSyncAsReplica}
          enableSyncAsPrimary={enableSyncAsPrimary}
          newTokenName={newTokenName}
          setNewTokenName={setNewTokenName}
          createSyncToken={createSyncToken}
          syncLoading={syncLoading}
          createdToken={createdToken}
          revokeSyncToken={revokeSyncToken}
          syncSettingsStatus={syncSettingsStatus}
          syncSettingsError={syncSettingsError}
          disableSync={disableSync}
        />
      )}

      {activeTab === "system" && (
        <SettingsPage
          systemConfig={systemConfig}
          systemConfigLoading={systemConfigLoading}
          systemConfigStatus={systemConfigStatus}
          systemConfigError={systemConfigError}
          saveSystemConfig={saveSystemConfig}
          confirmRestartService={confirmRestartService}
          restartLoading={restartLoading}
          runAutodetectResourceSettings={runAutodetectResourceSettings}
          autodetectLoading={autodetectLoading}
          showAdvancedSettings={showAdvancedSettings}
          toggleShowAdvancedSettings={toggleShowAdvancedSettings}
          passwordEditable={passwordEditable}
          canSetInitialPassword={canSetInitialPassword}
          authEnabled={authEnabled}
          adminCurrentPassword={adminCurrentPassword}
          setAdminCurrentPassword={setAdminCurrentPassword}
          adminNewPassword={adminNewPassword}
          setAdminNewPassword={setAdminNewPassword}
          adminConfirmPassword={adminConfirmPassword}
          setAdminConfirmPassword={setAdminConfirmPassword}
          adminPasswordLoading={adminPasswordLoading}
          adminPasswordStatus={adminPasswordStatus}
          adminPasswordError={adminPasswordError}
          handleSetPassword={saveAdminPassword}
          updateSystemConfig={updateSystemConfig}
          runCpuDetect={runCpuDetect}
          cpuDetectLoading={cpuDetectLoading}
          clearRedisData={clearRedisCache}
          clearRedisLoading={clearRedisLoading}
          clearClickhouseData={clearClickhouseData}
          clearClickhouseLoading={clearClickhouseLoading}
          clearRedisError={clearRedisError}
          clearClickhouseError={clearClickhouseError}
        />
      )}

      {activeTab === "integrations" && (
        <IntegrationsPage
          webhooksData={webhooksData}
          setWebhooksData={setWebhooksData}
          webhookTestResult={webhookTestResult}
          setWebhookTestResult={setWebhookTestResult}
          webhooksError={webhooksError}
          webhooksStatus={webhooksStatus}
          setWebhooksStatus={setWebhooksStatus}
          setWebhooksError={setWebhooksError}
          webhooksLoading={webhooksLoading}
          collapsedSections={collapsedSections}
          setCollapsedSections={setCollapsedSections}
          setConfirmState={setConfirmState}
          addToast={addToast}
          restartService={restartService}
        />
      )}

      {activeTab === "error-viewer" && (
        <ErrorViewerPage
          appErrors={appErrors}
          setAppErrors={setAppErrors}
          appErrorsError={appErrorsError}
          setAppErrorsError={setAppErrorsError}
          appErrorsLoading={appErrorsLoading}
          setAppErrorsLoading={setAppErrorsLoading}
          errorLogLevel={errorLogLevel}
          errorFilterText={errorFilterText}
          setErrorFilterText={setErrorFilterText}
          errorSeverityFilter={errorSeverityFilter}
          setErrorSeverityFilter={setErrorSeverityFilter}
          errorSortBy={errorSortBy}
          setErrorSortBy={setErrorSortBy}
          errorSortDir={errorSortDir}
          setErrorSortDir={setErrorSortDir}
          errorPage={errorPage}
          setErrorPage={setErrorPage}
          errorPageSize={errorPageSize}
          setErrorPageSize={setErrorPageSize}
          traceEvents={traceEvents}
          setTraceEvents={setTraceEvents}
          traceEventsAll={traceEventsAll}
          traceEventsLoading={traceEventsLoading}
          traceEventsSaving={traceEventsSaving}
          setTraceEventsSaving={setTraceEventsSaving}
          traceEventsExpanded={traceEventsExpanded}
          setTraceEventsExpanded={setTraceEventsExpanded}
          addToast={addToast}
        />
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
      </ErrorBoundary>
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

