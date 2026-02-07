import { useEffect, useState } from "react";

const REFRESH_MS = 5000;
const QUERY_WINDOW_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
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
  const [querySummary, setQuerySummary] = useState(null);
  const [queryLatency, setQueryLatency] = useState(null);
  const [querySummaryError, setQuerySummaryError] = useState("");
  const [queryLatencyError, setQueryLatencyError] = useState("");
  const [queryWindowMinutes, setQueryWindowMinutes] = useState(
    QUERY_WINDOW_OPTIONS[1].value
  );

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
        const response = await fetch("/api/queries/recent?limit=20");
        if (!response.ok) {
          throw new Error(`Query request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQueryRows(Array.isArray(data.rows) ? data.rows : []);
        setQueryError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQueryError(err.message || "Failed to load recent queries");
      }
    };
    loadQueries();
    const interval = setInterval(loadQueries, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

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

      {error && <div className="error">{error}</div>}

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

      <section className="section">
        <h2>Recent Queries</h2>
        {queryError && <div className="error">{queryError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <div className="table">
            <div className="table-header">
              <span>Time</span>
              <span>Client</span>
              <span>QName</span>
              <span>Type</span>
              <span>Outcome</span>
              <span>RCode</span>
              <span>Duration</span>
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
          </div>
        )}
      </section>

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
    </div>
  );
}
