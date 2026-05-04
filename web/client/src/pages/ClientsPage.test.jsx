import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  });
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function createFetchMock(systemConfig = minimalSystemConfig) {
  return vi.fn((input, options = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = options.method || "GET";
    if (url.includes("/api/system/config")) {
      if (method === "PUT") {
        return jsonResponse({ message: "Saved." });
      }
      return jsonResponse(cloneConfig(systemConfig));
    }
    if (url.includes("/api/client-identification/apply")) {
      return jsonResponse({ ok: true });
    }
    if (url.includes("/api/blocklists") && !url.includes("/api/blocklists/apply")) {
      if (url.includes("/api/blocklists/stats")) {
        return jsonResponse({});
      }
      if (url.includes("/api/blocklists/pause/status")) {
        return jsonResponse({ paused: false });
      }
      return jsonResponse({
        refreshInterval: "6h",
        sources: [],
        allowlist: [],
        denylist: [],
      });
    }
    if (url.includes("/api/cache/refresh/stats")) {
      return jsonResponse({});
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderClientsPage(appContext = { isReplica: false }) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider value={appContext}>
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("saves a group disable_cache flag when cache is disabled for that group", async () => {
    const user = userEvent.setup();
    const config = {
      ...minimalSystemConfig,
      client_groups: [
        {
          id: "kids",
          name: "Kids",
          description: "Children devices",
        },
      ],
    };
    fetchMock = createFetchMock(config);
    vi.stubGlobal("fetch", fetchMock);

    renderClientsPage();

    await user.click(await screen.findByRole("button", { name: /kids/i }));
    const disableCache = screen.getByLabelText(/disable cache for this group/i);
    await user.click(disableCache);
    await waitFor(() => expect(disableCache).toBeChecked());

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/system/config",
        expect.objectContaining({ method: "PUT" })
      );
    });
    const putCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/system/config" && options?.method === "PUT"
    );
    const savedConfig = JSON.parse(putCall[1].body);
    expect(savedConfig.client_groups[0]).toMatchObject({
      id: "kids",
      disable_cache: true,
    });
  });

  it("removes disable_cache from the saved group when cache is re-enabled", async () => {
    const user = userEvent.setup();
    const config = {
      ...minimalSystemConfig,
      client_groups: [
        {
          id: "kids",
          name: "Kids",
          description: "Children devices",
          disable_cache: true,
        },
      ],
    };
    fetchMock = createFetchMock(config);
    vi.stubGlobal("fetch", fetchMock);

    renderClientsPage();

    await user.click(await screen.findByRole("button", { name: /kids/i }));
    const disableCache = screen.getByLabelText(/disable cache for this group/i);
    expect(disableCache).toBeChecked();
    await user.click(disableCache);
    await waitFor(() => expect(disableCache).not.toBeChecked());

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/system/config",
        expect.objectContaining({ method: "PUT" })
      );
    });
    const putCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/system/config" && options?.method === "PUT"
    );
    const savedConfig = JSON.parse(putCall[1].body);
    expect(savedConfig.client_groups[0]).toMatchObject({ id: "kids" });
    expect(savedConfig.client_groups[0]).not.toHaveProperty("disable_cache");
  });
});
