import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupVisibilityAwarePolling } from "./visibilityAwarePolling.js";

describe("setupVisibilityAwarePolling", () => {
  let load;

  beforeEach(() => {
    load = vi.fn();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls load immediately on setup", () => {
    setupVisibilityAwarePolling(load, 60000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("returns a cleanup function that removes the visibility listener", () => {
    const cleanup = setupVisibilityAwarePolling(load, 60000);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    cleanup();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("pauses polling when tab becomes hidden", () => {
    vi.useFakeTimers();
    const cleanup = setupVisibilityAwarePolling(load, 1000);
    expect(load).toHaveBeenCalledTimes(1);

    // Simulate tab hidden
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // Advance past interval - load should not be called again (polling paused)
    vi.advanceTimersByTime(5000);
    expect(load).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("resumes polling when tab becomes visible", () => {
    vi.useFakeTimers();
    const cleanup = setupVisibilityAwarePolling(load, 1000);
    expect(load).toHaveBeenCalledTimes(1);

    // Simulate tab hidden
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // Advance - still paused
    vi.advanceTimersByTime(5000);
    expect(load).toHaveBeenCalledTimes(1);

    // Simulate tab visible - should call load immediately
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(load).toHaveBeenCalledTimes(2);

    // Advance - should poll again
    vi.advanceTimersByTime(1000);
    expect(load).toHaveBeenCalledTimes(3);

    cleanup();
  });
});
