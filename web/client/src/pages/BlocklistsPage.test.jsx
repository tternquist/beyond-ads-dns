import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import BlocklistsPage from "./BlocklistsPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/blocklists") && !url.includes("/api/blocklists/apply")) {
      if (url.includes("/api/blocklists/stats")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ blocked: 1000, deny: 50, allow: 10 }),
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
          scheduled_pause: { enabled: false, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
          family_time: { enabled: false, start: "17:00", end: "20:00", days: [0, 1, 2, 3, 4, 5, 6], services: [] },
          health_check: { enabled: false, fail_on_any: true },
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

function renderBlocklistsPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider value={{ isReplica: false }}>
          <BlocklistsPage />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("BlocklistsPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Blocklist Management heading and Save/Apply buttons after data loads", async () => {
    renderBlocklistsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /blocklist management/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply changes/i })).toBeInTheDocument();
  });

  it("renders stat cards for Blocked domains, List entries, Manual blocks, Allowlist", async () => {
    renderBlocklistsPage();

    await waitFor(() => {
      expect(screen.getByText(/blocked domains/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/list entries/i)).toBeInTheDocument();
    expect(screen.getAllByText(/manual blocks/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/allowlist/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders Refresh interval, Blocklist sources, Allowlist, Manual blocklist sections", async () => {
    renderBlocklistsPage();

    await waitFor(() => {
      expect(screen.getByText(/refresh interval/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/blocklist sources/i)).toBeInTheDocument();
    expect(screen.getByText(/allowlist \(exceptions\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/manual blocklist/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders Add blocklist and Add suggested blocklist controls", async () => {
    renderBlocklistsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add blocklist/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getAllByText(/add suggested blocklist/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders Scheduled pause and Family time sections", async () => {
    renderBlocklistsPage();

    await waitFor(() => {
      expect(screen.getAllByText(/scheduled pause/i).length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getAllByText(/family time/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/enable scheduled pause/i)).toBeInTheDocument();
    expect(screen.getByText(/enable family time/i)).toBeInTheDocument();
  });

  it("renders Blocklist health check section with Check health now button", async () => {
    renderBlocklistsPage();

    await waitFor(() => {
      expect(screen.getByText(/blocklist health check/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /check health now/i })).toBeInTheDocument();
  });

  it("shows Synced from primary badge when isReplica is true", async () => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider value={{ isReplica: true }}>
            <BlocklistsPage />
          </AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/synced from primary/i)).toBeInTheDocument();
    });
  });
});
