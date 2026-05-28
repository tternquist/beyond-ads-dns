import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Mock the API client before importing the hook under test.
vi.mock("../utils/apiClient.js", () => ({
  api: { get: vi.fn() },
}));

import { api } from "../utils/apiClient.js";
import { useSyncStatus } from "./useSyncStatus.js";

describe("useSyncStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads sync status on mount", async () => {
    api.get.mockResolvedValue({ role: "primary" });
    const { result } = renderHook(() => useSyncStatus());

    await waitFor(() => expect(result.current.syncStatus).toEqual({ role: "primary" }));
    expect(result.current.syncError).toBe("");
  });

  it("surfaces an error and clears status on failure", async () => {
    api.get.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useSyncStatus());

    await waitFor(() => expect(result.current.syncError).toBe("boom"));
    expect(result.current.syncStatus).toBeNull();
  });

  it("refresh() re-fetches status on demand", async () => {
    api.get.mockResolvedValue({ role: "replica" });
    const { result } = renderHook(() => useSyncStatus());
    await waitFor(() => expect(result.current.syncStatus).toEqual({ role: "replica" }));

    api.get.mockResolvedValue({ role: "primary" });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.syncStatus).toEqual({ role: "primary" });
  });
});
