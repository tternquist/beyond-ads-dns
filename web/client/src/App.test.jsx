import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { ToastProvider } from "./context/ToastContext.jsx";
import AuthGate from "./AuthGate.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/auth/status")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ authEnabled: false, authenticated: false }),
      });
    }
    if (url.includes("/api/info")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          hostname: "test-dns",
          startTimestamp: new Date().toISOString(),
          releaseTag: null,
          load1: null,
        }),
      });
    }
    if (url.includes("/api/sync/status")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ enabled: false }),
      });
    }
    if (url.includes("/api/system/config")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          server: {},
          cache: {},
          query_store: {},
          control: {},
          logging: {},
        }),
      });
    }
    if (url.includes("/api/redis/summary") || url.includes("/api/queries/summary") || url.includes("/api/queries/latency")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    if (url.includes("/api/queries/time-series")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ buckets: [], latencyBuckets: [] }),
      });
    }
    if (url.includes("/api/cache/stats")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderApp() {
  return render(
    <BrowserRouter>
      <ToastProvider>
        <AuthGate />
      </ToastProvider>
    </BrowserRouter>
  );
}

describe("App - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders app shell after auth check and loads overview", async () => {
    renderApp();

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /main/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /blocklists/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /system/i })).toBeInTheDocument();
  });

  it("navigates to Settings and renders Clear Redis cache button", async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /main/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("link", { name: /system/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /clear clickhouse data/i })).toBeInTheDocument();
  });

  it("navigates to Blocklists and renders blocklist section", async () => {
    const baseMock = createFetchMock();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/blocklists") && !url.includes("/api/blocklists/apply")) {
        if (url.includes("/api/blocklists/stats")) {
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
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            refreshInterval: "6h",
            sources: [],
            allowlist: [],
            denylist: [],
          }),
        });
      }
      if (url.includes("/api/cache/refresh/stats")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({}),
        });
      }
      return baseMock(input);
    });

    const user = userEvent.setup();
    renderApp();

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /main/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("link", { name: /blocklists/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /blocklist management/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply changes/i })).toBeInTheDocument();
  });
});
