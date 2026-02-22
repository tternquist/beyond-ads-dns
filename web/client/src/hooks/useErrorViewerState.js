import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";

/**
 * Per-feature hook for Error Viewer page state.
 * Owns app errors, trace events, filters, pagination.
 */
export function useErrorViewerState() {
  const [appErrors, setAppErrors] = useState([]);
  const [appErrorsError, setAppErrorsError] = useState("");
  const [appErrorsLoading, setAppErrorsLoading] = useState(false);
  const [errorLogLevel, setErrorLogLevel] = useState("warning");
  const [errorFilterText, setErrorFilterText] = useState("");
  const [errorSeverityFilter, setErrorSeverityFilter] = useState("all");
  const [errorSortBy, setErrorSortBy] = useState("date");
  const [errorSortDir, setErrorSortDir] = useState("desc");
  const [errorPage, setErrorPage] = useState(1);
  const [errorPageSize, setErrorPageSize] = useState(25);
  const [traceEvents, setTraceEvents] = useState([]);
  const [traceEventsAll, setTraceEventsAll] = useState([]);
  const [traceEventsLoading, setTraceEventsLoading] = useState(false);
  const [traceEventsSaving, setTraceEventsSaving] = useState(false);
  const [traceEventsExpanded, setTraceEventsExpanded] = useState(false);

  useEffect(() => {
    setErrorPage(1);
  }, [errorFilterText, errorSeverityFilter, errorSortBy, errorSortDir]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
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
  }, []);

  return {
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
  };
}
