import { QUERY_FILTER_PRESETS } from "../utils/constants.js";
import { formatNumber, formatUtcToLocalDateTime } from "../utils/format.js";
import {
  normalizeDomainForBlocklist,
  isDomainBlockedByDenylist,
  isDomainInAllowlist,
} from "../utils/blocklist.js";
import FilterInput from "../components/FilterInput.jsx";
import { EmptyState, SkeletonTable } from "../components/Skeleton.jsx";

export default function QueriesPage({
  queryError,
  queryEnabled,
  queryLoading,
  queryRows,
  queryTotal,
  queryPage,
  setQueryPage,
  queryPageSize,
  setQueryPageSize,
  querySortBy,
  querySortDir,
  toggleSort,
  filterSearch,
  setFilterSearch,
  filterQName,
  setFilterQName,
  filterOutcome,
  setFilterOutcome,
  filterRcode,
  setFilterRcode,
  filterClient,
  setFilterClient,
  filterQtype,
  setFilterQtype,
  filterProtocol,
  setFilterProtocol,
  filterSinceMinutes,
  setFilterSinceMinutes,
  filterMinLatency,
  setFilterMinLatency,
  filterMaxLatency,
  setFilterMaxLatency,
  setFilter,
  filterOptions,
  queryFiltersExpanded,
  setQueryFiltersExpanded,
  totalPages,
  canPrev,
  canNext,
  exportCsv,
  isReplica,
  allowlist,
  denylist,
  blocklistLoading,
  addDomainToAllowlist,
  addDomainToDenylist,
  removeDomainFromDenylist,
  onApplyPreset,
  onClearFilters,
}) {
  const activeFilterCount = [
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
  ].filter(Boolean).length;

  return (
    <section className="section">
      <h2>Recent Queries</h2>
      {queryError && <div className="error">{queryError}</div>}
      {!queryEnabled ? (
        <EmptyState
          title="Query store is disabled"
          description="Enable the query store in System Settings to view recent DNS queries."
        />
      ) : (
        <div className={`table ${!isReplica ? "queries-table-with-actions" : ""}`}>
          <div className="filter-presets">
            {QUERY_FILTER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="button"
                onClick={() => onApplyPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
            {activeFilterCount > 0 && (
              <span className="active-filters-badge">
                {activeFilterCount} filter(s) active
              </span>
            )}
          </div>
          <div className="table-filters-toggle-wrapper">
            <button
              type="button"
              className="button table-filters-toggle"
              onClick={() => setQueryFiltersExpanded((e) => !e)}
              aria-expanded={queryFiltersExpanded}
              aria-controls="query-filters-panel"
            >
              Filters {activeFilterCount > 0 ? `(${activeFilterCount} active)` : ""}
              {queryFiltersExpanded ? "▼" : "▶"}
            </button>
          </div>
          <div
            id="query-filters-panel"
            className={`table-filters-wrapper ${queryFiltersExpanded ? "table-filters-wrapper--expanded" : ""}`}
          >
            <div className="table-filters">
              <FilterInput
                placeholder="Search (domain, client, IP…)"
                value={filterSearch}
                onChange={(value) => setFilter(setFilterSearch, value)}
              />
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
                placeholder="Client (name or IP)"
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
                onChange={(event) => setFilter(setFilterSinceMinutes, event.target.value)}
              />
              <input
                className="input"
                placeholder="Min latency ms"
                value={filterMinLatency}
                onChange={(event) => setFilter(setFilterMinLatency, event.target.value)}
              />
              <input
                className="input"
                placeholder="Max latency ms"
                value={filterMaxLatency}
                onChange={(event) => setFilter(setFilterMaxLatency, event.target.value)}
              />
            </div>
          </div>
          <div className="table-header">
            <button className="table-sort" onClick={() => toggleSort("ts")}>
              Time {querySortBy === "ts" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
            </button>
            <button className="table-sort" onClick={() => toggleSort("client_ip")}>
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
            <button className="table-sort" onClick={() => toggleSort("outcome")}>
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
            <button className="table-sort" onClick={() => toggleSort("duration_ms")}>
              Duration{" "}
              {querySortBy === "duration_ms"
                ? querySortDir === "asc"
                  ? "↑"
                  : "↓"
                : ""}
            </button>
            {!isReplica && <span className="table-sort">Actions</span>}
          </div>
          {queryLoading && queryRows.length === 0 ? (
            <SkeletonTable rows={10} />
          ) : queryRows.length === 0 ? (
            <div className="table-empty">
              <EmptyState
                title="No recent queries"
                description="No queries match your current filters. Try adjusting filters or the time window."
                action={
                  <button className="button" onClick={onClearFilters}>
                    Clear filters
                  </button>
                }
              />
            </div>
          ) : null}
          {queryRows.map((row, index) => {
            const qname = row.qname || "";
            const normalizedQname = normalizeDomainForBlocklist(qname);
            const isBlockedByDenylistVal =
              normalizedQname && isDomainBlockedByDenylist(qname, denylist);
            const isInAllowlistVal =
              normalizedQname && isDomainInAllowlist(qname, allowlist);
            const outcomeBlocked = row.outcome === "blocked";
            const showUnblock = isBlockedByDenylistVal;
            const showAllow =
              outcomeBlocked && !isBlockedByDenylistVal && !isInAllowlistVal;
            const showBlockActions = !isBlockedByDenylistVal;
            return (
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
                <span>
                  {row.duration_ms != null
                    ? `${Number(row.duration_ms).toFixed(2)} ms`
                    : "-"}
                </span>
                {!isReplica && normalizedQname && (
                  <span className="query-row-actions">
                    {showUnblock ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => removeDomainFromDenylist(qname)}
                        disabled={blocklistLoading}
                        title={`Remove ${normalizedQname} from manual blocklist`}
                      >
                        Unblock
                      </button>
                    ) : showAllow ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => addDomainToAllowlist(qname)}
                        disabled={blocklistLoading}
                        title={`Add ${normalizedQname} to allowlist to bypass blocklist`}
                      >
                        Allow
                      </button>
                    ) : showBlockActions ? (
                      <>
                        <button
                          type="button"
                          className="link"
                          onClick={() => addDomainToDenylist(qname, "exact")}
                          disabled={blocklistLoading}
                          title={`Block only ${normalizedQname} (exact match)`}
                        >
                          Block exact
                        </button>
                        <span className="query-row-actions-sep">·</span>
                        <button
                          type="button"
                          className="link"
                          onClick={() => addDomainToDenylist(qname, "entire")}
                          disabled={blocklistLoading}
                          title={`Block ${normalizedQname} and all subdomains`}
                        >
                          Block domain
                        </button>
                      </>
                    ) : null}
                  </span>
                )}
              </div>
            );
          })}
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
  );
}
