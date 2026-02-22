import { useState } from "react";
import { useDebounce } from "./useDebounce.js";
/**
 * Custom hook for query filter state. Consolidates filter state and setters
 * to reduce cognitive overhead and prop drilling.
 */
export function useQueryFilters() {
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

  return {
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
  };
}
