import { useEffect, useState } from "react";
import { parse as parseYAML } from "yaml";

const REFRESH_MS = 5000;
const QUERY_WINDOW_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];
const BLOCKLIST_REFRESH_DEFAULT = "6h";
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "queries", label: "Queries" },
  { id: "blocklists", label: "Blocklists" },
  { id: "dns", label: "DNS Settings" },
  { id: "sync", label: "Sync" },
  { id: "config", label: "Config" },
];

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return value.toLocaleString();
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function formatRequestRate(total, windowMinutes) {
  if (!total || !windowMinutes || total === 0) {
    return { value: "-", unit: "" };
  }
  
  const queriesPerSecond = total / (windowMinutes * 60);
  
  // Use QPS if rate is >= 1, otherwise use QPM
  if (queriesPerSecond >= 1) {
    return {
      value: queriesPerSecond.toFixed(2),
      unit: "per second"
    };
  } else {
    const queriesPerMinute = total / windowMinutes;
    return {
      value: queriesPerMinute.toFixed(2),
      unit: "per minute"
    };
  }
}

function StatCard({ label, value, subtext }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {subtext && <div className="card-subtext">{subtext}</div>}
    </div>
  );
}

const STATUS_LABELS = {
  cached: "Cached",
  local: "Local",
  upstream: "Forwarded",
  blocked: "Blocked",
  upstream_error: "Upstream error",
  invalid: "Invalid",
};

function FilterInput({ value, onChange, placeholder, options = [] }) {
  const [showDropdown, setShowDropdown] = useState(false);

  const handleSelect = (selectedValue) => {
    onChange(selectedValue);
    setShowDropdown(false);
  };

  const handleInputChange = (e) => {
    onChange(e.target.value);
  };

  const handleInputFocus = () => {
    if (options.length > 0) {
      setShowDropdown(true);
    }
  };

  const handleInputBlur = () => {
    setTimeout(() => setShowDropdown(false), 200);
  };

  return (
    <div className="filter-input-wrapper">
      <input
        className="input filter-input"
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
      />
      {showDropdown && options.length > 0 && (
        <div className="filter-dropdown">
          {options.map((option, index) => (
            <button
              key={index}
              className="filter-dropdown-item"
              onClick={() => handleSelect(option.value)}
              type="button"
            >
              <span className="filter-dropdown-value">{option.value || "-"}</span>
              <span className="filter-dropdown-count">
                {(option.count || 0).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
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
  const [upstreamStats, setUpstreamStats] = useState(null);
  const [upstreamStatsError, setUpstreamStatsError] = useState("");
  const [queryWindowMinutes, setQueryWindowMinutes] = useState(
    QUERY_WINDOW_OPTIONS[1].value
  );
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
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshStats, setRefreshStats] = useState(null);
  const [refreshStatsError, setRefreshStatsError] = useState("");
  const [activeConfig, setActiveConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importError, setImportError] = useState("");
  const [restartLoading, setRestartLoading] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [hostname, setHostname] = useState("");
  const [appInfo, setAppInfo] = useState(null);
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
  const [upstreamsError, setUpstreamsError] = useState("");
  const [upstreamsStatus, setUpstreamsStatus] = useState("");
  const [upstreamsLoading, setUpstreamsLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncError, setSyncError] = useState("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState(null);
  const [syncSettingsPrimaryUrl, setSyncSettingsPrimaryUrl] = useState("");
  const [syncSettingsToken, setSyncSettingsToken] = useState("");
  const [syncSettingsInterval, setSyncSettingsInterval] = useState("60s");
  const [syncSettingsStatus, setSyncSettingsStatus] = useState("");
  const [syncSettingsError, setSyncSettingsError] = useState("");
  const [syncConfigRole, setSyncConfigRole] = useState("primary");
  const [syncConfigLoading, setSyncConfigLoading] = useState(false);
  const [syncConfigStatus, setSyncConfigStatus] = useState("");
  const [syncConfigError, setSyncConfigError] = useState("");

  const isReplica = syncStatus?.role === "replica" && syncStatus?.enabled;

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
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

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
    const interval = setInterval(loadCacheStats, REFRESH_MS);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (activeTab === "sync" && syncStatus?.role === "replica") {
      setSyncSettingsPrimaryUrl(syncStatus.primary_url || "");
      setSyncSettingsToken(""); // Don't pre-fill token for security
      setSyncSettingsInterval(syncStatus.sync_interval || "60s");
    }
  }, [activeTab, syncStatus]);

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
        setUpstreamsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setUpstreamsError(err.message || "Failed to load upstreams");
      }
    };
    loadLocalRecords();
    loadUpstreams();
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
  const statusOrder = ["cached", "local", "upstream", "blocked", "upstream_error", "invalid"];
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
    try {
      setBlocklistLoading(true);
      const response = await fetch("/api/blocklists", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshInterval,
          sources: blocklistSources,
          allowlist,
          denylist,
        }),
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
    const saved = await saveBlocklists();
    if (!saved) {
      return;
    }
    try {
      setBlocklistLoading(true);
      const response = await fetch("/api/blocklists/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setBlocklistStatus("Applied");
      const statsResponse = await fetch("/api/blocklists/stats");
      if (statsResponse.ok) {
        const data = await statsResponse.json();
        setBlocklistStats(data);
      }
    } catch (err) {
      setBlocklistError(err.message || "Failed to apply blocklists");
    } finally {
      setBlocklistLoading(false);
    }
  };

  const exportConfig = () => {
    window.location.href = "/api/config/export";
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
    try {
      setLocalRecordsLoading(true);
      const valid = localRecords.filter(
        (r) => (r.name || "").trim() && (r.value || "").trim()
      );
      const response = await fetch("/api/dns/local-records", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          records: valid.map((r) => ({
            name: String(r.name || "").trim().toLowerCase(),
            type: String(r.type || "A").trim().toUpperCase(),
            value: String(r.value || "").trim(),
          })),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      setLocalRecordsStatus("Saved");
      setLocalRecords(valid);
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
      const response = await fetch("/api/dns/local-records/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setLocalRecordsStatus("Applied");
    } catch (err) {
      setLocalRecordsError(err.message || "Failed to apply local records");
    } finally {
      setLocalRecordsLoading(false);
    }
  };

  const RESOLVER_STRATEGY_OPTIONS = [
    { value: "failover", label: "Failover", desc: "Try upstreams in order, use next on failure" },
    { value: "load_balance", label: "Load Balance", desc: "Round-robin across all upstreams" },
    { value: "weighted", label: "Weighted (latency)", desc: "Prefer faster upstreams by response time" },
  ];

  const updateUpstream = (index, field, value) => {
    setUpstreams((prev) =>
      prev.map((u, idx) =>
        idx === index ? { ...u, [field]: value } : u
      )
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
    try {
      setUpstreamsLoading(true);
      const valid = upstreams.filter((u) => (u.address || "").trim());
      if (valid.length === 0) {
        throw new Error("At least one upstream with address is required");
      }
      const response = await fetch("/api/dns/upstreams", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upstreams: valid.map((u) => ({
            name: String(u.name || "").trim() || "upstream",
            address: String(u.address || "").trim(),
            protocol: String(u.protocol || "udp").trim().toLowerCase() || "udp",
          })),
          resolver_strategy: resolverStrategy,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      setUpstreamsStatus("Saved");
      setUpstreams(valid);
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
      const response = await fetch("/api/dns/upstreams/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setUpstreamsStatus("Applied");
    } catch (err) {
      setUpstreamsError(err.message || "Failed to apply upstreams");
    } finally {
      setUpstreamsLoading(false);
    }
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
    const body = { primary_url: syncSettingsPrimaryUrl, sync_interval: syncSettingsInterval };
    if (syncSettingsToken) body.sync_token = syncSettingsToken;
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
    } catch (err) {
      setSyncSettingsError(err.message || "Failed to save sync settings");
    }
  };

  const saveSyncConfig = async (enabled, role, replicaSettings = null) => {
    setSyncConfigLoading(true);
    setSyncConfigStatus("");
    setSyncConfigError("");
    try {
      const body = { enabled, role };
      if (enabled && role === "replica" && replicaSettings) {
        body.primary_url = replicaSettings.primary_url;
        body.sync_token = replicaSettings.sync_token;
        body.sync_interval = replicaSettings.sync_interval;
      }
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
      
      setImportStatus("Config imported successfully. Restart the application to apply changes.");
      
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
    setRestartError("");
    setRestartLoading(true);
    try {
      const response = await fetch("/api/restart", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Restart failed: ${response.status}`);
      }
      setImportStatus("Service is restarting. The page will reconnect when it is back.");
      // Server will exit; connection may drop. No need to setRestartLoading(false).
    } catch (err) {
      setRestartError(err.message || "Failed to restart service");
      setRestartLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Beyond Ads DNS Metrics</h1>
          <div className="subtitle">
            {hostname && (
              <span>Environment: <strong>{hostname}</strong></span>
            )}
            {appInfo && (
              <>
                {hostname && <span> • </span>}
                <span>App memory: <strong>{appInfo.memoryUsage || "-"}</strong></span>
                <span> • </span>
                <span>Build: <strong>{appInfo.buildTimestamp ? new Date(appInfo.buildTimestamp).toLocaleString() : "-"}</strong></span>
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          {authEnabled && (
            <button type="button" className="button logout-button" onClick={logout}>
              Log out
            </button>
          )}
          <div className="refresh">
          <span>Refresh: {REFRESH_MS / 1000}s</span>
          <span className="updated">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Loading"}
          </span>
          </div>
        </div>
      </header>

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {activeTab === "overview" && (
      <section className="section">
        <div className="section-header">
          <h2>Blocking Control</h2>
          {isReplica && <span className="badge muted">Synced from primary</span>}
        </div>
        {pauseError && <div className="error">{pauseError}</div>}
        {isReplica ? (
          <p className="muted">Blocking control is managed by the primary instance.</p>
        ) : pauseStatus?.paused ? (
          <div>
            <p className="status">
              Blocking is paused until {new Date(pauseStatus.until).toLocaleString()}
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
            <p className="muted">Blocking is active. Pause for:</p>
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
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <div className="section-header">
          <h2>Query Statistics</h2>
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
        </div>
        {querySummaryError && <div className="error">{querySummaryError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <>
            <div className="grid">
              <StatCard
                label="Request Rate"
                value={formatRequestRate(statusTotal, queryWindowMinutes).value}
                subtext={formatRequestRate(statusTotal, queryWindowMinutes).unit}
              />
              <StatCard
                label="Total Queries"
                value={formatNumber(statusTotal)}
                subtext={`in last ${queryWindowMinutes >= 60 ? `${queryWindowMinutes / 60} hour${queryWindowMinutes / 60 > 1 ? 's' : ''}` : `${queryWindowMinutes} min`}`}
              />
            </div>
            <div className="grid">
              {statusCards.map((row) => (
                <StatCard
                  key={row.key}
                  label={row.label}
                  value={formatNumber(row.count)}
                  subtext={
                    statusTotal
                      ? formatPercent(row.count / statusTotal)
                      : "No data"
                  }
                />
              ))}
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <h2>Upstream Server Distribution</h2>
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
            <div className="grid">
              {(upstreamStats.upstreams || []).map((row) => (
                <StatCard
                  key={row.address}
                  label={row.address || "(unknown)"}
                  value={formatNumber(row.count)}
                  subtext={
                    upstreamStats.total
                      ? formatPercent(row.count / upstreamStats.total)
                      : "-"
                  }
                />
              ))}
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <h2>Response Time</h2>
        {queryLatencyError && <div className="error">{queryLatencyError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <div className="grid">
            <StatCard
              label="Avg"
              value={
                queryLatency?.avgMs != null ? `${queryLatency.avgMs.toFixed(2)} ms` : "-"
              }
            />
            <StatCard
              label="P50"
              value={
                queryLatency?.p50Ms != null ? `${queryLatency.p50Ms.toFixed(2)} ms` : "-"
              }
            />
            <StatCard
              label="P95"
              value={
                queryLatency?.p95Ms != null ? `${queryLatency.p95Ms.toFixed(2)} ms` : "-"
              }
            />
            <StatCard
              label="P99"
              value={
                queryLatency?.p99Ms != null ? `${queryLatency.p99Ms.toFixed(2)} ms` : "-"
              }
            />
            <StatCard
              label="Min"
              value={
                queryLatency?.minMs != null ? `${queryLatency.minMs.toFixed(2)} ms` : "-"
              }
            />
            <StatCard
              label="Max"
              value={
                queryLatency?.maxMs != null ? `${queryLatency.maxMs.toFixed(2)} ms` : "-"
              }
            />
          </div>
        )}
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <h2>L0 Cache (In-Memory LRU)</h2>
        {cacheStatsError && <div className="error">{cacheStatsError}</div>}
        <div className="grid">
          <StatCard
            label="Entries"
            value={formatNumber(cacheStats?.lru?.entries)}
            subtext={`of ${formatNumber(cacheStats?.lru?.max_entries)} max`}
          />
          <StatCard
            label="Fresh entries"
            value={formatNumber(cacheStats?.lru?.fresh)}
            subtext="valid and not expired"
          />
          <StatCard
            label="Stale entries"
            value={formatNumber(cacheStats?.lru?.stale)}
            subtext="expired but cached"
          />
          <StatCard
            label="Expired entries"
            value={formatNumber(cacheStats?.lru?.expired)}
            subtext="ready for cleanup"
          />
        </div>
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <h2>L1 Cache (Redis)</h2>
        <div className="grid">
          <StatCard
            label="Hit rate"
            value={
              cacheStats?.hit_rate != null
                ? `${cacheStats.hit_rate.toFixed(2)}%`
                : "-"
            }
            subtext={`${formatNumber(cacheStats?.hits)} hits / ${formatNumber(
              cacheStats?.misses
            )} misses`}
          />
          <StatCard
            label="Total requests"
            value={formatNumber(
              cacheStats?.hits != null && cacheStats?.misses != null
                ? cacheStats.hits + cacheStats.misses
                : null
            )}
            subtext="L0 + L1 combined"
          />
          <StatCard
            label="Evicted keys"
            value={formatNumber(stats?.evictedKeys)}
            subtext="from Redis"
          />
          <StatCard
            label="Memory used"
            value={stats?.usedMemoryHuman || "-"}
            subtext={`${formatNumber(stats?.usedMemory)} bytes`}
          />
        </div>
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <h2>L1 Keyspace (Redis)</h2>
        <div className="grid">
          <StatCard label="Total keys" value={formatNumber(stats?.keyspace?.keys)} />
          <StatCard
            label="DNS keys"
            value={formatNumber(stats?.keyspace?.dnsKeys)}
            subtext="dns: cache entries"
          />
          <StatCard
            label="DNS metadata"
            value={formatNumber(stats?.keyspace?.dnsmetaKeys)}
            subtext="dnsmeta: hit counters, locks"
          />
          <StatCard
            label="Other keys"
            value={formatNumber(stats?.keyspace?.otherKeys)}
          />
        </div>
      </section>
      )}

      {activeTab === "overview" && (
      <section className="section">
        <h2>Refresh Sweeper (24h)</h2>
        {refreshStatsError && <div className="error">{refreshStatsError}</div>}
        <div className="grid">
          <StatCard
            label="Last sweep"
            value={formatNumber(refreshStats?.last_sweep_count)}
            subtext={
              refreshStats?.last_sweep_time
                ? new Date(refreshStats.last_sweep_time).toLocaleTimeString()
                : "-"
            }
          />
          <StatCard
            label="Avg per sweep"
            value={
              refreshStats?.average_per_sweep_24h !== undefined
                ? refreshStats.average_per_sweep_24h.toFixed(2)
                : "-"
            }
            subtext={`${formatNumber(refreshStats?.sweeps_24h)} sweeps`}
          />
          <StatCard
            label="Refreshed (24h)"
            value={formatNumber(refreshStats?.refreshed_24h)}
          />
        </div>
      </section>
      )}

      {activeTab === "queries" && (
      <section className="section">
        <h2>Recent Queries</h2>
        {queryError && <div className="error">{queryError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <div className="table">
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
                placeholder="Client IP"
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
              <div className="table-row muted">No recent queries.</div>
            )}
            {queryRows.map((row, index) => (
              <div className="table-row" key={`${row.ts}-${index}`}>
                <span>{row.ts}</span>
                <span>{row.client_ip || "-"}</span>
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
              disabled={blocklistLoading}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyBlocklists}
              disabled={blocklistLoading}
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
            className="input"
            value={refreshInterval}
            onChange={(event) => setRefreshInterval(event.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="field-label">Blocklist sources</label>
          <div className="list">
            {blocklistSources.map((source, index) => (
              <div key={`${source.url}-${index}`} className="list-row">
                <input
                  className="input"
                  placeholder="Name"
                  value={source.name || ""}
                  onChange={(event) =>
                    updateSource(index, "name", event.target.value)
                  }
                />
                <input
                  className="input"
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
            ))}
          </div>
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
              disabled={upstreamsLoading}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyUpstreams}
              disabled={upstreamsLoading}
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
          <label className="field-label">Upstream servers</label>
          <div className="list">
            {upstreams.map((u, index) => (
              <div key={index} className="list-row">
                <input
                  className="input"
                  placeholder="Name (e.g. cloudflare)"
                  value={u.name || ""}
                  onChange={(e) => updateUpstream(index, "name", e.target.value)}
                  style={{ minWidth: "100px" }}
                />
                <input
                  className="input"
                  placeholder="Address (e.g. 1.1.1.1:53)"
                  value={u.address || ""}
                  onChange={(e) => updateUpstream(index, "address", e.target.value)}
                  style={{ minWidth: "120px" }}
                />
                <select
                  className="input"
                  value={u.protocol || "udp"}
                  onChange={(e) => updateUpstream(index, "protocol", e.target.value)}
                  style={{ minWidth: "70px" }}
                >
                  <option value="udp">UDP</option>
                  <option value="tcp">TCP</option>
                </select>
                <button
                  className="icon-button"
                  onClick={() => removeUpstream(index)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
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
              disabled={localRecordsLoading}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyLocalRecords}
              disabled={localRecordsLoading}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        <p className="muted">
          Local records are returned immediately without upstream lookup. They work even when the internet is down.
        </p>
        {localRecordsStatus && <p className="status">{localRecordsStatus}</p>}
        {localRecordsError && <div className="error">{localRecordsError}</div>}

        <div className="form-group">
          <label className="field-label">Records</label>
          <div className="list">
            {localRecords.map((rec, index) => (
              <div key={index} className="list-row">
                <input
                  className="input"
                  placeholder="Name (e.g. router.local)"
                  value={rec.name || ""}
                  onChange={(e) => updateLocalRecord(index, "name", e.target.value)}
                />
                <select
                  className="input"
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
                  className="input"
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
            ))}
          </div>
          <button className="button" onClick={addLocalRecord}>
            Add record
          </button>
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
                    className="input"
                    placeholder="http://primary-host:8081"
                    value={syncSettingsPrimaryUrl}
                    onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="field-label">Sync token</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Token from primary"
                    value={syncSettingsToken}
                    onChange={(e) => setSyncSettingsToken(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="field-label">Sync interval</label>
                  <input
                    className="input"
                    placeholder="60s"
                    value={syncSettingsInterval}
                    onChange={(e) => setSyncSettingsInterval(e.target.value)}
                  />
                </div>
              </>
            )}
            <button
              className="button primary"
              onClick={() => saveSyncConfig(true, syncConfigRole, syncConfigRole === "replica" ? {
                primary_url: syncSettingsPrimaryUrl,
                sync_token: syncSettingsToken,
                sync_interval: syncSettingsInterval || "60s",
              } : null)}
              disabled={syncConfigLoading || (syncConfigRole === "replica" && !syncSettingsPrimaryUrl.trim())}
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
                className="input"
                placeholder="http://primary-host:8081"
                value={syncSettingsPrimaryUrl}
                onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="field-label">Sync token</label>
              <input
                className="input"
                type="password"
                placeholder="Token from primary"
                value={syncSettingsToken}
                onChange={(e) => setSyncSettingsToken(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="field-label">Sync interval</label>
              <input
                className="input"
                placeholder="60s"
                value={syncSettingsInterval}
                onChange={(e) => setSyncSettingsInterval(e.target.value)}
              />
            </div>
            <button className="button primary" onClick={saveSyncSettings}>
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
            <button className="button primary" onClick={exportConfig}>
              Export
            </button>
            <button
              className="button"
              onClick={restartService}
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
        <pre className="code-block">
          {activeConfig ? JSON.stringify(activeConfig, null, 2) : "Loading..."}
        </pre>
      </section>
      )}
    </div>
  );
}

function DomainEditor({ items, onAdd, onRemove }) {
  const [value, setValue] = useState("");
  return (
    <div className="domain-editor">
      <div className="domain-input">
        <input
          className="input"
          placeholder="example.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          className="button"
          onClick={() => {
            onAdd(value);
            setValue("");
          }}
        >
          Add
        </button>
      </div>
      <div className="tags">
        {items.length === 0 && <span className="muted">None</span>}
        {items.map((item) => (
          <span key={item} className="tag">
            {item}
            <button className="tag-remove" onClick={() => onRemove(item)}>
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function buildQueryParams({
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
}) {
  const params = new URLSearchParams({
    page: String(queryPage),
    page_size: String(queryPageSize),
    sort_by: querySortBy,
    sort_dir: querySortDir,
  });
  if (filterQName) params.set("qname", filterQName);
  if (filterOutcome) params.set("outcome", filterOutcome);
  if (filterRcode) params.set("rcode", filterRcode);
  if (filterClient) params.set("client_ip", filterClient);
  if (filterQtype) params.set("qtype", filterQtype);
  if (filterProtocol) params.set("protocol", filterProtocol);
  if (filterSinceMinutes) params.set("since_minutes", filterSinceMinutes);
  if (filterMinLatency) params.set("min_duration_ms", filterMinLatency);
  if (filterMaxLatency) params.set("max_duration_ms", filterMaxLatency);
  return params;
}
