import { useEffect, useState } from "react";

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
  upstream: "Forwarded",
  blocked: "Blocked",
  upstream_error: "Upstream error",
  invalid: "Invalid",
};

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
  const [querySummary, setQuerySummary] = useState(null);
  const [queryLatency, setQueryLatency] = useState(null);
  const [querySummaryError, setQuerySummaryError] = useState("");
  const [queryLatencyError, setQueryLatencyError] = useState("");
  const [queryWindowMinutes, setQueryWindowMinutes] = useState(
    QUERY_WINDOW_OPTIONS[1].value
  );
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

  const statusRows = querySummary?.statuses || [];
  const statusTotal = querySummary?.total || 0;
  const statusMap = statusRows.reduce((acc, row) => {
    acc[row.outcome] = row.count;
    return acc;
  }, {});
  const statusOrder = ["cached", "upstream", "blocked", "upstream_error", "invalid"];
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

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Beyond Ads DNS Metrics</h1>
          <p className="subtitle">
            Redis cache statistics for the ad-blocking resolver.
          </p>
        </div>
        <div className="refresh">
          <span>Refresh: {REFRESH_MS / 1000}s</span>
          <span className="updated">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Loading"}
          </span>
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
        <h2>Cache Summary</h2>
        <div className="grid">
          <StatCard
            label="Hit rate"
            value={formatPercent(stats?.hitRate)}
            subtext={`${formatNumber(stats?.hits)} hits / ${formatNumber(
              stats?.misses
            )} misses`}
          />
          <StatCard
            label="Total requests"
            value={formatNumber(stats?.totalRequests)}
            subtext="hits + misses"
          />
          <StatCard
            label="Evicted keys"
            value={formatNumber(stats?.evictedKeys)}
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
        <h2>Keyspace</h2>
        <div className="grid">
          <StatCard label="DB0 keys" value={formatNumber(stats?.keyspace?.keys)} />
          <StatCard
            label="DB0 expires"
            value={formatNumber(stats?.keyspace?.expires)}
          />
          <StatCard
            label="Average TTL"
            value={
              stats?.keyspace?.avgTtlMs
                ? `${formatNumber(stats?.keyspace?.avgTtlMs)} ms`
                : "-"
            }
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
        <div className="section-header">
          <h2>Query Status</h2>
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
        )}
      </section>
      )}

      {activeTab === "queries" && (
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
                queryLatency?.avgMs ? `${formatNumber(queryLatency.avgMs)} ms` : "-"
              }
            />
            <StatCard
              label="P50"
              value={
                queryLatency?.p50Ms ? `${formatNumber(queryLatency.p50Ms)} ms` : "-"
              }
            />
            <StatCard
              label="P95"
              value={
                queryLatency?.p95Ms ? `${formatNumber(queryLatency.p95Ms)} ms` : "-"
              }
            />
            <StatCard
              label="P99"
              value={
                queryLatency?.p99Ms ? `${formatNumber(queryLatency.p99Ms)} ms` : "-"
              }
            />
            <StatCard
              label="Min"
              value={
                queryLatency?.minMs ? `${formatNumber(queryLatency.minMs)} ms` : "-"
              }
            />
            <StatCard
              label="Max"
              value={
                queryLatency?.maxMs ? `${formatNumber(queryLatency.maxMs)} ms` : "-"
              }
            />
          </div>
        )}
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
              <input
                className="input"
                placeholder="QName contains"
                value={filterQName}
                onChange={(event) => setFilter(setFilterQName, event.target.value)}
              />
              <input
                className="input"
                placeholder="Outcome"
                value={filterOutcome}
                onChange={(event) => setFilter(setFilterOutcome, event.target.value)}
              />
              <input
                className="input"
                placeholder="RCode"
                value={filterRcode}
                onChange={(event) => setFilter(setFilterRcode, event.target.value)}
              />
              <input
                className="input"
                placeholder="Client IP"
                value={filterClient}
                onChange={(event) => setFilter(setFilterClient, event.target.value)}
              />
              <input
                className="input"
                placeholder="QType"
                value={filterQtype}
                onChange={(event) => setFilter(setFilterQtype, event.target.value)}
              />
              <input
                className="input"
                placeholder="Protocol"
                value={filterProtocol}
                onChange={(event) => setFilter(setFilterProtocol, event.target.value)}
              />
              <input
                className="input"
                placeholder="Since minutes"
                value={filterSinceMinutes}
                onChange={(event) =>
                  setFilter(setFilterSinceMinutes, event.target.value)
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
                <span>{row.duration_ms ? `${row.duration_ms} ms` : "-"}</span>
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
        </div>
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
