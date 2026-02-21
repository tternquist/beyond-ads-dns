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
import { QUERY_WINDOW_OPTIONS, METRIC_TOOLTIPS, UPSTREAM_COLORS } from "../utils/constants.js";
import { formatNumber, formatUtcToLocalTime } from "../utils/format.js";
import DonutChart from "../components/DonutChart.jsx";
import CollapsibleSection from "../components/CollapsibleSection.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";

function formatStatsWindow(sec) {
  if (!sec || sec <= 0) return "";
  const minutes = Math.round(sec / 60);
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export default function OverviewPage({
  pauseStatus,
  pauseError,
  pauseLoading,
  isReplica,
  resumeBlocking,
  pauseBlocking,
  queryWindowMinutes,
  setQueryWindowMinutes,
  querySummary,
  querySummaryError,
  queryEnabled,
  statusCards,
  statusTotal,
  timeSeries,
  bucketMinutes,
  upstreamStatsError,
  upstreamStats,
  queryLatencyError,
  queryLatency,
  cacheStatsError,
  cacheStats,
  stats,
  collapsedSections,
  toggleSection,
  refreshStatsError,
  refreshStats,
}) {
  return (
    <>
      <section className="section">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h2>Blocking Control</h2>
          <span className={`badge ${pauseStatus?.paused ? "paused" : "active"}`}>
            {pauseStatus?.paused ? "Paused" : "Active"}
          </span>
          {isReplica && <span className="badge muted">Per instance</span>}
        </div>
        <div style={{ marginTop: "16px" }}>
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
                <button className="button" onClick={() => pauseBlocking(1)} disabled={pauseLoading}>
                  1 min
                </button>
                <button className="button" onClick={() => pauseBlocking(5)} disabled={pauseLoading}>
                  5 min
                </button>
                <button className="button" onClick={() => pauseBlocking(30)} disabled={pauseLoading}>
                  30 min
                </button>
                <button className="button" onClick={() => pauseBlocking(60)} disabled={pauseLoading}>
                  1 hour
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
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
        <div style={{ marginTop: "16px" }}>
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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 12,
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <h3 style={{ margin: 0, fontSize: "14px", color: "#9aa4b2" }}>
                      Request volume over time (local time)
                    </h3>
                    <span className="qps-indicator" title="Current QPS from latest bucket">
                      {(() => {
                        const buckets = timeSeries.buckets;
                        const last = buckets?.[buckets.length - 1];
                        const qps =
                          last && bucketMinutes > 0
                            ? (last.total / (bucketMinutes * 60)).toFixed(1)
                            : "-";
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
                        contentStyle={{
                          background: "#1f2430",
                          border: "1px solid #2a3140",
                          borderRadius: "8px",
                        }}
                        labelStyle={{ color: "#fff" }}
                        formatter={(value) => [value?.toFixed(1) ?? value, "QPS"]}
                        labelFormatter={(v) => `Time: ${v}`}
                      />
                      <Area
                        type="monotone"
                        dataKey="rate"
                        stroke="#2563eb"
                        fill="url(#gradientTotal)"
                        name="Queries/sec"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="section">
        <h2>Upstream Server Distribution</h2>
        <div style={{ marginTop: "16px" }}>
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
                {queryWindowMinutes >= 60
                  ? `${queryWindowMinutes / 60} hour${queryWindowMinutes / 60 > 1 ? "s" : ""}`
                  : `${queryWindowMinutes} min`}
                .
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
        </div>
      </section>

      <section className="section">
        <h2>Response Time</h2>
        <div style={{ marginTop: "16px" }}>
          {queryLatencyError && <div className="error">{queryLatencyError}</div>}
          {!queryEnabled ? (
            <p className="muted">Query store is disabled.</p>
          ) : (
            <>
              {timeSeries?.enabled && timeSeries.latencyBuckets?.length > 0 && (
                <div className="response-time-section">
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "16px",
                      alignItems: "flex-start",
                      marginBottom: 12,
                    }}
                  >
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        color: "#9aa4b2",
                        flex: "1 1 auto",
                      }}
                    >
                      Latency over time (local time, ms)
                    </h3>
                    {queryLatency?.enabled && queryLatency.count > 0 && (
                      <div
                        className="latency-period-stats"
                        title={`Stats for selected window (${queryWindowMinutes} min)`}
                      >
                        <span
                          className="latency-stat"
                          data-metric="avg"
                          title={METRIC_TOOLTIPS["Avg"]}
                        >
                          <span
                            className="latency-stat-line"
                            style={{ background: "#3b82f6" }}
                          />
                          Avg:{" "}
                          {queryLatency.avgMs != null
                            ? queryLatency.avgMs.toFixed(2)
                            : "-"}{" "}
                          ms
                        </span>
                        <span
                          className="latency-stat"
                          data-metric="p50"
                          title={METRIC_TOOLTIPS["P50"]}
                        >
                          <span
                            className="latency-stat-line"
                            style={{ background: "#22c55e" }}
                          />
                          P50:{" "}
                          {queryLatency.p50Ms != null
                            ? queryLatency.p50Ms.toFixed(2)
                            : "-"}{" "}
                          ms
                        </span>
                        <span
                          className="latency-stat"
                          data-metric="p95"
                          title={METRIC_TOOLTIPS["P95"]}
                        >
                          <span
                            className="latency-stat-line"
                            style={{ background: "#f59e0b" }}
                          />
                          P95:{" "}
                          {queryLatency.p95Ms != null
                            ? queryLatency.p95Ms.toFixed(2)
                            : "-"}{" "}
                          ms
                        </span>
                        <span
                          className="latency-stat"
                          data-metric="p99"
                          title={METRIC_TOOLTIPS["P99"]}
                        >
                          <span
                            className="latency-stat-line"
                            style={{ background: "#ef4444" }}
                          />
                          P99:{" "}
                          {queryLatency.p99Ms != null
                            ? queryLatency.p99Ms.toFixed(2)
                            : "-"}{" "}
                          ms
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
                            contentStyle={{
                              background: "#1f2430",
                              border: "1px solid #2a3140",
                              borderRadius: "8px",
                            }}
                            labelStyle={{ color: "#fff" }}
                            formatter={(value) => [
                              value != null ? value.toFixed(2) : "-",
                              "ms",
                            ]}
                            labelFormatter={(v) => `Time: ${v}`}
                          />
                          <Line
                            type="monotone"
                            dataKey="avgMs"
                            stroke="#3b82f6"
                            name="Avg"
                            dot={false}
                            strokeWidth={2}
                          />
                          <Line
                            type="monotone"
                            dataKey="p50Ms"
                            stroke="#22c55e"
                            name="P50"
                            dot={false}
                            strokeWidth={2}
                          />
                          <Line
                            type="monotone"
                            dataKey="p95Ms"
                            stroke="#f59e0b"
                            name="P95"
                            dot={false}
                            strokeWidth={2}
                          />
                          <Line
                            type="monotone"
                            dataKey="p99Ms"
                            stroke="#ef4444"
                            name="P99"
                            dot={false}
                            strokeWidth={2}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="latency-legend" aria-hidden="true">
                      <span
                        className="latency-legend-item"
                        title={METRIC_TOOLTIPS["Avg"]}
                      >
                        <span
                          className="latency-legend-line"
                          style={{ background: "#3b82f6" }}
                        />
                        Avg
                      </span>
                      <span
                        className="latency-legend-item"
                        title={METRIC_TOOLTIPS["P50"]}
                      >
                        <span
                          className="latency-legend-line"
                          style={{ background: "#22c55e" }}
                        />
                        P50
                      </span>
                      <span
                        className="latency-legend-item"
                        title={METRIC_TOOLTIPS["P95"]}
                      >
                        <span
                          className="latency-legend-line"
                          style={{ background: "#f59e0b" }}
                        />
                        P95
                      </span>
                      <span
                        className="latency-legend-item"
                        title={METRIC_TOOLTIPS["P99"]}
                      >
                        <span
                          className="latency-legend-line"
                          style={{ background: "#ef4444" }}
                        />
                        P99
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="section">
        <h2>L0 / L1 Cache</h2>
        <div style={{ marginTop: "16px" }}>
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
              <tr>
                <td className="cache-layer" rowSpan="4">
                  L0 (LRU)
                </td>
                <td>Entries</td>
                <td>
                  {formatNumber(cacheStats?.lru?.entries)} /{" "}
                  {formatNumber(cacheStats?.lru?.max_entries)}
                </td>
              </tr>
              <tr>
                <td>Fresh</td>
                <td>{formatNumber(cacheStats?.lru?.fresh)}</td>
              </tr>
              <tr>
                <td>Stale</td>
                <td>{formatNumber(cacheStats?.lru?.stale)}</td>
              </tr>
              <tr>
                <td>Expired</td>
                <td>{formatNumber(cacheStats?.lru?.expired)}</td>
              </tr>
              <tr>
                <td className="cache-layer" rowSpan="4">
                  L1 (Redis)
                </td>
                <td>Hit rate</td>
                <td>
                  {cacheStats?.hit_rate != null
                    ? `${cacheStats.hit_rate.toFixed(2)}%`
                    : "-"}
                </td>
              </tr>
              <tr>
                <td>Requests</td>
                <td>
                  {formatNumber(
                    cacheStats?.hits != null && cacheStats?.misses != null
                      ? cacheStats.hits + cacheStats.misses
                      : null
                  )}
                </td>
              </tr>
              <tr>
                <td>Evicted</td>
                <td>{formatNumber(stats?.evictedKeys)}</td>
              </tr>
              <tr>
                <td>Memory</td>
                <td>{stats?.usedMemoryHuman || "-"}</td>
              </tr>
              <tr>
                <td className="cache-layer" rowSpan="3">
                  Keyspace
                </td>
                <td>DNS keys</td>
                <td>{formatNumber(stats?.keyspace?.dnsKeys)}</td>
              </tr>
              <tr>
                <td>Metadata</td>
                <td>{formatNumber(stats?.keyspace?.dnsmetaKeys)}</td>
              </tr>
              <tr>
                <td>Other</td>
                <td>{formatNumber(stats?.keyspace?.otherKeys)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <CollapsibleSection
        id="advanced"
        title="Advanced"
        collapsed={collapsedSections.advanced ?? true}
        onToggle={toggleSection}
      >
        <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Refresh Sweeper</h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "1rem" }}>
          The sweeper periodically refreshes cache entries nearing expiry. Stats below use
          a rolling window
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
    </>
  );
}
