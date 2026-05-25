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

function createFetchMock(systemConfig = minimalSystemConfig) {
  return vi.fn((input, options = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = options.method || "GET";
    if (url.includes("/api/system/config")) {
      if (method === "PUT") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ message: "Saved." }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => JSON.parse(JSON.stringify(systemConfig)),
      });
    }
    if (url.includes("/api/client-identification/apply")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true }),
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

  it("loads group disable_cache as checked and omits it from save payload when unchecked", async () => {
    const user = userEvent.setup();
    fetchMock = createFetchMock({
      ...minimalSystemConfig,
      client_groups: [
        {
          id: "default",
          name: "Default",
          description: "Default group",
          disable_cache: true,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClientsPage();

    const checkbox = await screen.findByLabelText(/disable cache for this group/i);
    expect(checkbox).toBeChecked();

    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, options]) => String(url).includes("/api/system/config") && options?.method === "PUT"
        )
      ).toBe(true);
    });
    const putCall = fetchMock.mock.calls.find(
      ([url, options]) => String(url).includes("/api/system/config") && options?.method === "PUT"
    );
    const payload = JSON.parse(putCall[1].body);
    expect(payload.client_groups[0]).not.toHaveProperty("disable_cache");
  });

  it("adds disable_cache to the save payload when group checkbox is checked", async () => {
    const user = userEvent.setup();
    renderClientsPage();

    const checkbox = await screen.findByLabelText(/disable cache for this group/i);
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, options]) => String(url).includes("/api/system/config") && options?.method === "PUT"
        )
      ).toBe(true);
    });
    const putCall = fetchMock.mock.calls.find(
      ([url, options]) => String(url).includes("/api/system/config") && options?.method === "PUT"
    );
    const payload = JSON.parse(putCall[1].body);
    expect(payload.client_groups[0].disable_cache).toBe(true);
  });
});
