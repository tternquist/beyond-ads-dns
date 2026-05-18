import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import ClientsPage from "./ClientsPage.jsx";

const minimalSystemConfig = {
  client_identification: {
    enabled: false,
    clients: [],
  },
  client_groups: [
    {
      id: "default",
      name: "Default",
      description: "Default group",
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFetchMock(systemConfig = minimalSystemConfig) {
  const requests = [];
  const mock = vi.fn((input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    requests.push({ url, init });
    if (url.includes("/api/system/config")) {
      if (init.method === "PUT") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ message: "Saved." }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => clone(systemConfig),
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
  mock.requests = requests;
  return mock;
}

function renderClientsPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider value={{ isReplica: false }}>
          <ClientsPage />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("ClientsPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Clients & Groups heading and Save button after config loads", async () => {
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /clients & groups/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
  });

  it("renders Client identification enabled checkbox", async () => {
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getByLabelText(/client identification enabled/i)).toBeInTheDocument();
    });
  });

  it("renders Clients section with Add client button", async () => {
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^clients$/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /add client/i })).toBeInTheDocument();
  });

  it("renders Groups section with Add group button", async () => {
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^groups$/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /add group/i })).toBeInTheDocument();
  });

  it("renders Discover clients collapsible section", async () => {
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getByText(/discover clients/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /discover clients/i })).toBeInTheDocument();
  });

  it("shows Synced from primary when isReplica is true", async () => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider value={{ isReplica: true }}>
            <ClientsPage />
          </AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/groups synced from primary/i)).toBeInTheDocument();
    });
  });

  it("renders client table headers", async () => {
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getAllByText(/ip address/i).length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getAllByText(/^name$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^group$/i).length).toBeGreaterThanOrEqual(1);
  });

  it("saves and removes group disable_cache when toggling cache bypass", async () => {
    const user = userEvent.setup();
    renderClientsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /clients & groups/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /default group/i }));
    const disableCache = screen.getByLabelText(/disable cache for this group/i);

    expect(disableCache).not.toBeChecked();
    await user.click(disableCache);
    expect(disableCache).toBeChecked();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(systemConfigPutRequests(fetchMock)).toHaveLength(1);
    });
    const enabledPayload = JSON.parse(systemConfigPutRequests(fetchMock)[0].init.body);
    expect(enabledPayload.client_groups[0].disable_cache).toBe(true);

    await user.click(disableCache);
    expect(disableCache).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(systemConfigPutRequests(fetchMock)).toHaveLength(2);
    });
    const disabledPayload = JSON.parse(systemConfigPutRequests(fetchMock)[1].init.body);
    expect(disabledPayload.client_groups[0]).not.toHaveProperty("disable_cache");
  });
});

function systemConfigPutRequests(fetchMock) {
  return fetchMock.requests.filter(
    ({ url, init }) => url.includes("/api/system/config") && init.method === "PUT"
  );
}
