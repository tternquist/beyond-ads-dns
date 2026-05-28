import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

vi.mock("../utils/apiClient.js", () => ({
  api: { get: vi.fn() },
}));

import { api } from "../utils/apiClient.js";
import { useApiPolling } from "./useApiPolling.js";

describe("useApiPolling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches data on mount and clears loading", async () => {
    api.get.mockResolvedValue({ count: 3 });
    const { result } = renderHook(() => useApiPolling("/api/stats"));

    await waitFor(() => expect(result.current.data).toEqual({ count: 3 }));
    expect(result.current.error).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.updatedAt).toBeInstanceOf(Date);
  });

  it("does not fetch when disabled", async () => {
    api.get.mockResolvedValue({});
    renderHook(() => useApiPolling("/api/stats", { enabled: false }));
    // Give effects a chance to run.
    await Promise.resolve();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("does not fetch when url is empty", async () => {
    api.get.mockResolvedValue({});
    renderHook(() => useApiPolling("", {}));
    await Promise.resolve();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("captures error messages from failed requests", async () => {
    api.get.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useApiPolling("/api/stats"));
    await waitFor(() => expect(result.current.error).toBe("nope"));
    expect(result.current.loading).toBe(false);
  });

  it("ignores AbortError without setting error state", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    api.get.mockRejectedValue(abort);
    const { result } = renderHook(() => useApiPolling("/api/stats"));
    // Let the rejected promise settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBe("");
  });

  it("reload() re-fetches the latest data", async () => {
    api.get.mockResolvedValue({ v: 1 });
    const { result } = renderHook(() => useApiPolling("/api/stats"));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    api.get.mockResolvedValue({ v: 2 });
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
  });
});
