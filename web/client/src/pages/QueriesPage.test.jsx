import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import QueriesPage from "./QueriesPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/queries/recent")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          enabled: true,
          rows: [
            {
              ts: "2025-02-23T12:00:00Z",
              client_ip: "192.168.1.1",
              client_name: "Test Client",
              qname: "example.com",
              qtype: "A",
              outcome: "blocked",
              rcode: "NXDOMAIN",
              duration_ms: 5.2,
            },
          ],
          total: 1,
        }),
      });
    }
    if (url.includes("/api/queries/filter-options")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          qname: [],
          outcome: ["blocked", "forwarded"],
          rcode: ["NXDOMAIN"],
          client_ip: [],
          qtype: ["A"],
          protocol: ["udp"],
        }),
      });
    }
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
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderQueriesPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider value={{ isReplica: false }}>
          <QueriesPage />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("QueriesPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Recent Queries heading and filter presets after data loads", async () => {
    renderQueriesPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /recent queries/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /blocked only/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /errors only/i })).toBeInTheDocument();
  });

  it("renders Filters toggle and table headers", async () => {
    renderQueriesPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /filters/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^time/i })).toBeInTheDocument();
    expect(screen.getAllByText(/client/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/qname/i)).toBeInTheDocument();
    expect(screen.getByText(/type/i)).toBeInTheDocument();
    expect(screen.getByText(/outcome/i)).toBeInTheDocument();
    expect(screen.getByText(/rcode/i)).toBeInTheDocument();
    expect(screen.getByText(/duration/i)).toBeInTheDocument();
  });

  it("renders query rows when data is available", async () => {
    renderQueriesPage();

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    expect(screen.getByText(/192\.168\.1\.1|test client/i)).toBeInTheDocument();
    expect(screen.getAllByText(/blocked/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders pagination controls and Export CSV button", async () => {
    renderQueriesPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /export csv/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /prev/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
    expect(screen.getByText(/page \d+ of \d+/i)).toBeInTheDocument();
  });

  it("shows Query store is disabled when enabled is false", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/queries/recent")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ enabled: false, rows: [], total: 0 }),
        });
      }
      if (url.includes("/api/queries/filter-options")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({}),
        });
      }
      return createFetchMock()(input);
    });

    renderQueriesPage();

    await waitFor(() => {
      expect(screen.getByText(/query store is disabled/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/enable the query store in system settings/i)).toBeInTheDocument();
  });

  it("shows Clear filters when no rows match", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/queries/recent")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ enabled: true, rows: [], total: 0 }),
        });
      }
      if (url.includes("/api/queries/filter-options")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({}),
        });
      }
      return createFetchMock()(input);
    });

    renderQueriesPage();

    await waitFor(() => {
      expect(screen.getByText(/no recent queries/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });
});
