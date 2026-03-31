import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import SyncPage from "./SyncPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/sync/status")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ enabled: false }),
      });
    }
    if (url.includes("/api/sync/tokens/")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderSyncPage(syncStatus = null) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider
          value={{
            syncStatus,
            syncError: null,
            refreshSyncStatus: vi.fn(),
          }}
        >
          <SyncPage />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("SyncPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Instance Sync heading", () => {
    renderSyncPage({ enabled: false });

    expect(screen.getByRole("heading", { name: /instance sync/i })).toBeInTheDocument();
  });

  it("renders Enable Sync section when sync is disabled", () => {
    renderSyncPage({ enabled: false });

    expect(screen.getByRole("heading", { name: /enable sync/i })).toBeInTheDocument();
    expect(
      screen.getByText(/keep multiple instances in sync/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/role/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders Primary and Replica role options", () => {
    renderSyncPage({ enabled: false });

    const select = screen.getByRole("combobox");
    expect(select).toHaveTextContent(/primary/i);
    expect(select).toHaveTextContent(/replica/i);
  });

  it("shows Enable as primary button when Primary role is selected", () => {
    renderSyncPage({ enabled: false });

    expect(screen.getByRole("button", { name: /enable as primary/i })).toBeInTheDocument();
  });

  it("shows replica config fields when Replica role is selected", async () => {
    const user = userEvent.setup();
    renderSyncPage({ enabled: false });

    await user.selectOptions(
      screen.getByRole("combobox"),
      screen.getByRole("option", { name: /replica/i })
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/primary-host/i)).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText(/token from primary/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/60s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enable as replica/i })).toBeInTheDocument();
  });

  it("renders Sync status when sync is enabled as primary", () => {
    renderSyncPage({
      enabled: true,
      role: "primary",
      tokens: [],
    });

    expect(screen.getByRole("heading", { name: /sync status/i })).toBeInTheDocument();
    expect(screen.getByText(/you are the primary/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /replica tokens/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create token/i })).toBeInTheDocument();
  });

  it("renders Sync status when sync is enabled as replica", () => {
    renderSyncPage({
      enabled: true,
      role: "replica",
    });

    expect(screen.getByRole("heading", { name: /sync status/i })).toBeInTheDocument();
    expect(screen.getByText(/you are a replica/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /replica settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save sync settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable sync/i })).toBeInTheDocument();
  });

  it("shows Primary badge when sync is enabled as primary", () => {
    renderSyncPage({
      enabled: true,
      role: "primary",
      tokens: [],
    });

    expect(screen.getByRole("heading", { name: /instance sync/i })).toBeInTheDocument();
    expect(screen.getByText(/you are the primary/i)).toBeInTheDocument();
  });

  it("shows Replica badge when sync is enabled as replica", () => {
    renderSyncPage({
      enabled: true,
      role: "replica",
    });

    expect(screen.getByRole("heading", { name: /instance sync/i })).toBeInTheDocument();
    expect(screen.getByText(/you are a replica/i)).toBeInTheDocument();
  });

  it("shows skeleton when syncStatus is null", () => {
    renderSyncPage(null);

    expect(screen.getByRole("heading", { name: /instance sync/i })).toBeInTheDocument();
    expect(document.querySelector(".skeleton-card")).toBeInTheDocument();
  });

  it("revokes a token using its numeric index", async () => {
    const user = userEvent.setup();
    const refreshSyncStatus = vi.fn();
    render(
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider
            value={{
              syncStatus: {
                enabled: true,
                role: "primary",
                tokens: [{ id: "abc12345...", index: 3, name: "Kitchen" }],
              },
              syncError: null,
              refreshSyncStatus,
            }}
          >
            <SyncPage />
          </AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    );

    await user.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      const revokeCall = fetchMock.mock.calls.find(([requestUrl]) =>
        String(requestUrl).includes("/api/sync/tokens/")
      );
      expect(revokeCall).toBeDefined();
      expect(revokeCall[0]).toBe("/api/sync/tokens/3");
      expect(revokeCall[1]).toMatchObject({ method: "DELETE" });
      expect(refreshSyncStatus).toHaveBeenCalled();
    });
  });
});
