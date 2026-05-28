import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQueryFilters } from "./useQueryFilters.js";

describe("useQueryFilters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with empty filters and collapsed panel", () => {
    const { result } = renderHook(() => useQueryFilters());
    expect(result.current.filterSearch).toBe("");
    expect(result.current.filterOutcome).toBe("");
    expect(result.current.queryFiltersExpanded).toBe(false);
  });

  it("updates individual filter state via setters", () => {
    const { result } = renderHook(() => useQueryFilters());
    act(() => result.current.setFilterOutcome("blocked"));
    act(() => result.current.setQueryFiltersExpanded(true));
    expect(result.current.filterOutcome).toBe("blocked");
    expect(result.current.queryFiltersExpanded).toBe(true);
  });

  it("debounces the search filter (300ms)", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useQueryFilters());

    act(() => result.current.setFilterSearch("ads"));
    // Immediate value updates, debounced value lags.
    expect(result.current.filterSearch).toBe("ads");
    expect(result.current.debouncedFilterSearch).toBe("");

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.debouncedFilterSearch).toBe("ads");
  });
});
