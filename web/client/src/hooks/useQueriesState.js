import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { buildQueryParams } from "../utils/queryParams.js";
import { useQueryFilters } from "./useQueryFilters.js";

/**
 * Per-feature hook for Queries page state.
 * Owns query rows, pagination, sorting, filter options, and blocklist quick-actions.
 */
export function useQueriesState() {
  const queryFilters = useQueryFilters();
  const {
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
    queryFiltersExpanded,
    setQueryFiltersExpanded,
    debouncedFilterSearch,
    debouncedFilterQName,
    debouncedFilterClient,
  } = queryFilters;

  const [queryRows, setQueryRows] = useState([]);
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryTotal, setQueryTotal] = useState(0);
  const [queryPage, setQueryPage] = useState(1);
  const [queryPageSize, setQueryPageSize] = useState(25);
  const [querySortBy, setQuerySortBy] = useState("ts");
  const [querySortDir, setQuerySortDir] = useState("desc");
  const [filterOptions, setFilterOptions] = useState(null);
  const [filterOptionsError, setFilterOptionsError] = useState("");
  const [queryWindowMinutes] = useState(60); // Used for filter options

  const totalPages = Math.max(1, Math.ceil(queryTotal / queryPageSize));
  const canPrev = queryPage > 1;
  const canNext = queryPage < totalPages;

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const loadQueries = async () => {
      try {
        setQueryLoading(true);
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
        if (data.error) {
          setQueryError(data.error || "Failed to load queries");
          setQueryRows([]);
          setQueryTotal(0);
        } else {
          setQueryRows(Array.isArray(data.rows) ? data.rows : []);
          setQueryTotal(Number(data.total || 0));
          setQueryError("");
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setQueryError(err.message || "Failed to load queries");
      } finally {
        if (isMounted) setQueryLoading(false);
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
    const loadFilterOptions = async () => {
      try {
        const data = await api.get(
          `/api/queries/filter-options?window_minutes=${queryWindowMinutes}`,
          { signal: controller.signal }
        );
        if (!isMounted) return;
        setFilterOptionsError(data.error ? data.error : "");
        setFilterOptions(data.error ? {} : (data.options || {}));
      } catch (err) {
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

  return {
    ...queryFilters,
    queryRows,
    queryEnabled,
    queryError,
    queryLoading,
    queryTotal,
    queryPage,
    setQueryPage,
    queryPageSize,
    setQueryPageSize,
    querySortBy,
    querySortDir,
    toggleSort,
    setFilter,
    filterOptions,
    filterOptionsError,
    queryFiltersExpanded,
    setQueryFiltersExpanded,
    totalPages,
    canPrev,
    canNext,
    exportCsv,
    onApplyQueryPreset,
    onClearQueryFilters,
    setFilterOutcome,
  };
}
