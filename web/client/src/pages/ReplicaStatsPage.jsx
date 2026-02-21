import { METRIC_TOOLTIPS } from "../utils/constants.js";
import { formatNumber, formatUtcToLocalTime, formatPctFromDistribution, formatErrorPctFromDistribution } from "../utils/format.js";
import { SkeletonTable } from "../components/Skeleton.jsx";

export default function ReplicaStatsPage({
  syncStatus,
  instanceStats,
  instanceStatsError,
}) {
  const isPrimaryWithSync = syncStatus?.enabled && syncStatus?.role === "primary";

  return (
    <section className="section">
      <h2>Multi-Instance</h2>
      {!isPrimaryWithSync ? (
        <p className="muted">
          Multi-Instance view is only available on the primary instance when sync is enabled.
        </p>
      ) : (
        <>
          <p className="muted">
            Statistics from the primary and each replica. Replicas push stats at their heartbeat
            interval. Response distribution and latency require ClickHouse (primary) or{" "}
            <code>sync.stats_source_url</code> on replicas.
          </p>
          {instanceStatsError && <div className="error">{instanceStatsError}</div>}
          {!instanceStats && !instanceStatsError && (
            <div className="table-wrapper" style={{ marginTop: 16 }}>
              <SkeletonTable rows={3} />
            </div>
          )}
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
                      <tr className="instances-table-row">
                        <td data-label="Instance">
                          <strong>Primary</strong>
                        </td>
                        <td data-label="Release">{instanceStats.primary.release || "—"}</td>
                        <td data-label="URL">
                          {instanceStats.primary.url ? (
                            <a
                              href={instanceStats.primary.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {instanceStats.primary.url}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td data-label="Updated">—</td>
                        <td data-label="% Forwarded">
                          {formatPctFromDistribution(
                            instanceStats.primary.response_distribution,
                            "upstream"
                          )}
                        </td>
                        <td data-label="% Blocked">
                          {formatPctFromDistribution(
                            instanceStats.primary.response_distribution,
                            "blocked"
                          )}
                        </td>
                        <td data-label="% Error">
                          {formatErrorPctFromDistribution(
                            instanceStats.primary.response_distribution
                          )}
                        </td>
                        <td data-label="L0 Key Count">
                          {formatNumber(instanceStats.primary.cache?.lru?.entries)}
                        </td>
                        <td data-label="L1 Key Count">
                          {formatNumber(instanceStats.primary.cache?.redis_keys)}
                        </td>
                        <td data-label="Avg Response Time">
                          {instanceStats.primary.response_time?.count > 0
                            ? `${Number(instanceStats.primary.response_time.avg_ms)?.toFixed(2)}ms`
                            : "—"}
                        </td>
                        <td data-label="Avg Sweep Size">
                          {formatNumber(instanceStats.primary.refresh?.average_per_sweep_24h)}
                        </td>
                      </tr>
                    )}
                    {instanceStats.replicas?.map((r) => (
                      <tr key={r.token_id} className="instances-table-row">
                        <td data-label="Instance">{r.name || "Replica"}</td>
                        <td data-label="Release">{r.release || "—"}</td>
                        <td data-label="URL">
                          {r.stats_source_url ? (
                            <a
                              href={r.stats_source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {r.stats_source_url}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td data-label="Updated">
                          {r.last_updated ? formatUtcToLocalTime(r.last_updated) : "—"}
                        </td>
                        <td data-label="% Forwarded">
                          {formatPctFromDistribution(r.response_distribution, "upstream")}
                        </td>
                        <td data-label="% Blocked">
                          {formatPctFromDistribution(r.response_distribution, "blocked")}
                        </td>
                        <td data-label="% Error">
                          {formatErrorPctFromDistribution(r.response_distribution)}
                        </td>
                        <td data-label="L0 Key Count">
                          {formatNumber(r.cache?.lru?.entries)}
                        </td>
                        <td data-label="L1 Key Count">
                          {formatNumber(r.cache?.redis_keys)}
                        </td>
                        <td data-label="Avg Response Time">
                          {r.response_time?.count > 0
                            ? `${Number(r.response_time.avg_ms)?.toFixed(2)}ms`
                            : "—"}
                        </td>
                        <td data-label="Avg Sweep Size">
                          {formatNumber(r.cache_refresh?.average_per_sweep_24h)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!instanceStats.primary &&
                (!instanceStats.replicas || instanceStats.replicas.length === 0) && (
                  <p className="muted" style={{ marginTop: 16 }}>
                    No instance stats available.
                  </p>
                )}
              {instanceStats.primary &&
                (!instanceStats.replicas || instanceStats.replicas.length === 0) && (
                  <p className="muted" style={{ marginTop: 16 }}>
                    No replicas have pushed stats yet. Configure replicas with heartbeat in the
                    Sync tab.
                  </p>
                )}
            </>
          )}
        </>
      )}
    </section>
  );
}
