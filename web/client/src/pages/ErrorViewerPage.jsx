import { api } from "../utils/apiClient.js";
import { parseSlogMessage } from "../utils/format.js";
import { formatNumber } from "../utils/format.js";
import { TRACE_EVENT_DESCRIPTIONS } from "../utils/constants.js";
import { SkeletonCard, EmptyState } from "../components/Skeleton.jsx";

export default function ErrorViewerPage({
  appErrors,
  setAppErrors,
  appErrorsError,
  setAppErrorsError,
  appErrorsLoading,
  setAppErrorsLoading,
  errorLogLevel,
  errorFilterText,
  setErrorFilterText,
  errorSeverityFilter,
  setErrorSeverityFilter,
  errorSortBy,
  setErrorSortBy,
  errorSortDir,
  setErrorSortDir,
  errorPage,
  setErrorPage,
  errorPageSize,
  setErrorPageSize,
  traceEvents,
  setTraceEvents,
  traceEventsAll,
  traceEventsLoading,
  traceEventsSaving,
  setTraceEventsSaving,
  traceEventsExpanded,
  setTraceEventsExpanded,
  addToast,
}) {
  const onRefresh = () => {
    setAppErrorsLoading(true);
    setAppErrorsError("");
    api
      .get("/api/errors")
      .then((data) => {
        setAppErrors(Array.isArray(data.errors) ? data.errors : []);
        setAppErrorsError("");
      })
      .catch((err) => {
        setAppErrors([]);
        setAppErrorsError(err.message || "Failed to load errors");
      })
      .finally(() => setAppErrorsLoading(false));
  };

  return (
    <section className="section">
      <div className="section-header">
        <h2>Error Viewer</h2>
        <div className="actions">
          <button
            type="button"
            className="button"
            onClick={onRefresh}
            disabled={appErrorsLoading}
          >
            {appErrorsLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      <p className="muted">
        Recent application errors from the DNS resolver. Data is pulled from the
        control API /errors endpoint.
      </p>
      <div className="error-viewer-controls" style={{ marginBottom: "0.5rem" }}>
        <div className="error-viewer-filters">
          <span className="field-label" style={{ fontSize: 12 }}>
            Log level: {errorLogLevel}
          </span>
          <span className="muted" style={{ marginLeft: "0.5rem", fontSize: 12 }}>
            Change in System settings.
          </span>
        </div>
        <div className="error-viewer-filters" style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setTraceEventsExpanded((e) => !e)}
            aria-expanded={traceEventsExpanded}
            className="collapsible-header"
            style={{
              padding: 0,
              margin: 0,
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "inherit",
              color: "inherit",
            }}
          >
            <span className="field-label" style={{ fontSize: 12 }}>
              Trace events
            </span>
            {traceEventsAll.length > 0 &&
              traceEvents.length > 0 &&
              !traceEventsExpanded && (
                <span className="muted" style={{ fontSize: 11 }}>
                  ({traceEvents.length} enabled)
                </span>
              )}
            <span
              className={`collapsible-chevron ${!traceEventsExpanded ? "collapsed" : ""}`}
              aria-hidden
              style={{ marginLeft: "auto" }}
            >
              ▼
            </span>
          </button>
          {traceEventsExpanded && (
            <div style={{ marginTop: "0.5rem" }}>
              {traceEventsLoading ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 1.5rem" }}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="skeleton-line" style={{ width: 120, height: 20 }} />
                  ))}
                </div>
              ) : traceEventsAll.length > 0 ? (
                <span
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.75rem 1.5rem",
                    alignItems: "flex-start",
                  }}
                >
                  {traceEventsAll.map((ev) => {
                    const meta =
                      TRACE_EVENT_DESCRIPTIONS[ev] || {
                        label: ev,
                        description: "",
                      };
                    return (
                      <div
                        key={ev}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <label
                          className="checkbox"
                          style={{ margin: 0, fontSize: 12 }}
                        >
                          <input
                            type="checkbox"
                            checked={traceEvents.includes(ev)}
                            disabled={traceEventsSaving}
                            onChange={async () => {
                              const next = traceEvents.includes(ev)
                                ? traceEvents.filter((e) => e !== ev)
                                : [...traceEvents, ev];
                              setTraceEventsSaving(true);
                              try {
                                await api.put("/api/trace-events", {
                                  events: next,
                                });
                                setTraceEvents(next);
                                addToast(
                                  "Trace events updated. Changes apply immediately.",
                                  "info"
                                );
                              } catch (err) {
                                addToast(
                                  err.message ||
                                    "Failed to update trace events",
                                  "error"
                                );
                              } finally {
                                setTraceEventsSaving(false);
                              }
                            }}
                          />
                          {" "}
                          {meta.label}
                        </label>
                        {meta.description && (
                          <span
                            className="muted"
                            style={{ fontSize: 11, marginLeft: 20 }}
                          >
                            {meta.description}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <span
                    className="muted"
                    style={{ fontSize: 11, alignSelf: "center" }}
                  >
                    Apply without restart
                  </span>
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {appErrorsError && <div className="error">{appErrorsError}</div>}
      {appErrorsLoading && appErrors.length === 0 ? (
        <SkeletonCard />
      ) : appErrors.length === 0 ? (
        <EmptyState
          title="No errors recorded"
          description="The DNS resolver has not recorded any errors."
        />
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
                const rawMsg =
                  typeof err === "string"
                    ? err
                    : err?.message ?? JSON.stringify(err);
                const ts =
                  typeof err === "object" && err?.timestamp ? err.timestamp : null;
                const tsLocal = ts ? new Date(ts).toLocaleString() : null;
                const severity =
                  typeof err === "object" && err?.severity
                    ? String(err.severity).toLowerCase()
                    : "error";
                const docRef =
                  typeof err === "object" && err?.doc_ref ? err.doc_ref : null;
                const parsed = parseSlogMessage(rawMsg);
                const msg = parsed?.msg ?? rawMsg;
                const attrs = parsed?.attrs ?? {};
                const isStructured = parsed?.isStructured ?? false;
                const display =
                  typeof err === "string"
                    ? err
                    : err?.message && err?.timestamp
                      ? `[${tsLocal}] ${err.message}`
                      : JSON.stringify(err, null, 2);
                return {
                  idx,
                  msg,
                  rawMsg,
                  ts,
                  severity,
                  display,
                  docRef,
                  attrs,
                  isStructured,
                  tsLocal,
                };
              });
              let filtered = normalized;
              if (filterLower) {
                filtered = filtered.filter((e) =>
                  e.msg.toLowerCase().includes(filterLower)
                );
              }
              if (errorSeverityFilter !== "all") {
                filtered = filtered.filter(
                  (e) => e.severity === errorSeverityFilter
                );
              }
              const sorted = [...filtered].sort((a, b) => {
                if (errorSortBy === "date") {
                  const ta = a.ts ? new Date(a.ts).getTime() : 0;
                  const tb = b.ts ? new Date(b.ts).getTime() : 0;
                  if (ta !== tb)
                    return errorSortDir === "desc" ? tb - ta : ta - tb;
                  return a.idx - b.idx;
                }
                const cmp = a.msg.localeCompare(b.msg, undefined, {
                  sensitivity: "base",
                });
                return errorSortDir === "desc" ? -cmp : cmp;
              });
              if (sorted.length === 0) {
                return (
                  <p className="muted">No errors match the filter.</p>
                );
              }
              const errorTotal = sorted.length;
              const errorTotalPages = Math.max(
                1,
                Math.ceil(errorTotal / errorPageSize)
              );
              const safePage = Math.min(errorPage, errorTotalPages);
              const errorCanPrev = safePage > 1;
              const errorCanNext = safePage < errorTotalPages;
              const paginated = sorted.slice(
                (safePage - 1) * errorPageSize,
                safePage * errorPageSize
              );
              return (
                <>
                  {paginated.map((e) => (
                    <div key={e.idx} className="error-viewer-item">
                      <div className="error-viewer-item-header">
                        {e.severity && (
                          <span
                            className={`error-viewer-severity error-viewer-severity-${e.severity}`}
                          >
                            {e.severity}
                          </span>
                        )}
                        {e.tsLocal && (
                          <span
                            className="error-viewer-timestamp"
                            title={e.ts}
                          >
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
                              const isInfo =
                                e.severity === "info" || e.severity === "debug";
                              const prompt = isInfo
                                ? `I'm looking at this informational log from my DNS resolver (beyond-ads-dns: https://github.com/tternquist/beyond-ads-dns):\n\n${e.display}\n\nCan you explain what this log message means, what it indicates about the system's behavior, and any relevant context from the beyond-ads-dns cache refresh architecture?`
                                : `I'm seeing this error in my DNS resolver (beyond-ads-dns: https://github.com/tternquist/beyond-ads-dns):\n\n${e.display}\n\nCan you explain what it means and suggest possible causes and fixes?`;
                              const url = `https://chat.openai.com/?q=${encodeURIComponent(prompt)}`;
                              window.open(url, "_blank", "noopener noreferrer");
                              addToast(
                                "Opening ChatGPT with prompt pre-filled.",
                                "info"
                              );
                            }}
                          >
                            Ask ChatGPT
                          </button>
                        </div>
                      </div>
                      {e.isStructured ? (
                        <div className="error-viewer-body">
                          <div className="error-viewer-message">
                            {e.msg || "(no message)"}
                          </div>
                          {Object.keys(e.attrs).length > 0 && (
                            <div className="error-viewer-attrs">
                              {Object.entries(e.attrs).map(([k, v]) => (
                                <span
                                  key={k}
                                  className="error-viewer-attr"
                                >
                                  <span className="error-viewer-attr-key">
                                    {k}
                                  </span>
                                  ={String(v)}
                                </span>
                              ))}
                            </div>
                          )}
                          <details className="error-viewer-raw-toggle">
                            <summary>View raw log</summary>
                            <pre className="error-viewer-raw">
                              {e.rawMsg}
                            </pre>
                          </details>
                        </div>
                      ) : (
                        <pre className="error-viewer-raw">{e.display}</pre>
                      )}
                    </div>
                  ))}
                  <div className="table-footer">
                    <span>
                      Page {safePage} of {errorTotalPages} •{" "}
                      {formatNumber(errorTotal)} total
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
                        onClick={() =>
                          setErrorPage((prev) => Math.max(1, prev - 1))
                        }
                        disabled={!errorCanPrev}
                      >
                        Prev
                      </button>
                      <button
                        className="button"
                        onClick={() =>
                          setErrorPage((prev) =>
                            Math.min(errorTotalPages, prev + 1)
                          )
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
  );
}
