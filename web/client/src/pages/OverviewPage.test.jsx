import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import OverviewPage from "./OverviewPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/redis/summary")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    if (url.includes("/api/queries/summary")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ enabled: false, statuses: [] }),
      });
    }
    if (url.includes("/api/queries/time-series")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ buckets: [], latencyBuckets: [] }),
      });
    }
    if (url.includes("/api/queries/latency")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ enabled: false, count: 0 }),
      });
    }
    if (url.includes("/api/queries/upstream-stats")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    if (url.includes("/api/cache/stats")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    if (url.includes("/api/blocklists/pause/status")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ paused: false }),
      });
    }
    if (url.includes("/api/blocklists/stats")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    if (url.includes("/api/cache/refresh/stats")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderOverviewPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider value={{ refreshIntervalMs: 5000, isReplica: false }}>
          <OverviewPage />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("OverviewPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Blocking Control and Query Statistics sections after data loads", async () => {
    renderOverviewPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /blocking control/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: /query statistics/i })).toBeInTheDocument();
  });

  it("renders Active badge when blocking is not paused", async () => {
    renderOverviewPage();

    await waitFor(() => {
      const activeElements = screen.getAllByText(/active/i);
      expect(activeElements.length).toBeGreaterThanOrEqual(1);
      expect(activeElements.some((el) => el.textContent === "Active")).toBe(true);
    });
  });

  it("renders pause buttons (1 min, 5 min, 30 min, 1 hour) when blocking is active", async () => {
    renderOverviewPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 min/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /5 min/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /30 min/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 hour/i })).toBeInTheDocument();
  });

  it("calls pause API when 1 min pause is clicked", async () => {
    const user = userEvent.setup();
    const baseMock = createFetchMock();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/blocklists/pause") && !url.includes("/api/blocklists/pause/status")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ paused: true, until: new Date(Date.now() + 60000).toISOString() }),
        });
      }
      return baseMock(input);
    });

    renderOverviewPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 min/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /1 min/i }));

    await waitFor(() => {
      const pauseCalls = fetchMock.mock.calls.filter(
        (call) => (typeof call[0] === "string" ? call[0] : call[0]?.url || "").includes("/api/blocklists/pause")
      );
      expect(pauseCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
