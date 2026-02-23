import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../context/ToastContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import ReplicaStatsPage from "./ReplicaStatsPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/instances/stats")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          primary: {
            release: "v1.0",
            url: "http://primary:8081",
            response_distribution: { upstream: 80, blocked: 15, upstream_error: 5 },
            latency_p50_ms: 5.2,
            l0_key_count: 1000,
            l1_key_count: 500,
            avg_sweep_size: 10,
          },
          replicas: [],
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderReplicaStatsPage(syncStatus = null, route = "/replica-stats") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <AppProvider value={{ syncStatus }}>
          <ReplicaStatsPage />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("ReplicaStatsPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Multi-Instance heading", () => {
    renderReplicaStatsPage();

    expect(screen.getByRole("heading", { name: /multi-instance/i })).toBeInTheDocument();
  });

  it("shows message when sync is not enabled as primary", () => {
    renderReplicaStatsPage({ enabled: false });

    expect(
      screen.getByText(/multi-instance view is only available on the primary instance when sync is enabled/i)
    ).toBeInTheDocument();
  });

  it("shows message when sync is enabled as replica", () => {
    renderReplicaStatsPage({ enabled: true, role: "replica" });

    expect(
      screen.getByText(/multi-instance view is only available on the primary instance when sync is enabled/i)
    ).toBeInTheDocument();
  });

  it("renders instance stats table when sync is enabled as primary", async () => {
    renderReplicaStatsPage({ enabled: true, role: "primary" });

    await waitFor(() => {
      expect(screen.getByText(/primary/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("columnheader", { name: /instance/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /release/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /url/i })).toBeInTheDocument();
    expect(screen.getByText(/v1\.0/)).toBeInTheDocument();
  });

  it("renders replica rows when replicas exist", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/instances/stats")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            primary: {
              release: "v1.0",
              url: "http://primary:8081",
              response_distribution: {},
              latency_p50_ms: null,
              l0_key_count: null,
              l1_key_count: null,
              avg_sweep_size: null,
            },
            replicas: [
              {
                name: "Living Room",
                release: "v1.0",
                url: "http://replica:8081",
                updated_at: "2025-02-23T12:00:00Z",
                response_distribution: {},
                latency_p50_ms: null,
                l0_key_count: null,
                l1_key_count: null,
                avg_sweep_size: null,
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderReplicaStatsPage({ enabled: true, role: "primary" });

    await waitFor(() => {
      expect(screen.getByText("Living Room")).toBeInTheDocument();
    });
  });

  it("shows error when instance stats fetch fails", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/instances/stats")) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderReplicaStatsPage({ enabled: true, role: "primary" });

    await waitFor(() => {
      expect(screen.getByText(/network error|failed to load instance stats/i)).toBeInTheDocument();
    });
  });
});
