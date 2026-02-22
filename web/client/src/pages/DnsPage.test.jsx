import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import DnsPage from "./DnsPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/dns/local-records")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ records: [] }),
      });
    }
    if (url.includes("/api/dns/upstreams")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          upstreams: [{ address: "1.1.1.1:53" }],
          resolver_strategy: "failover",
          upstream_timeout: "10s",
          upstream_backoff: "30s",
        }),
      });
    }
    if (url.includes("/api/dns/response")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ blocked: "nxdomain", blocked_ttl: "1h" }),
      });
    }
    if (url.includes("/api/dns/safe-search")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ enabled: false, google: true, bing: true }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderDnsPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider value={{ isReplica: false }}>
          <DnsPage />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("DnsPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Upstream Resolvers, Local DNS Records, Blocked Response, and Safe Search sections after data loads", async () => {
    renderDnsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /upstream resolvers/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: /local dns records/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /blocked response/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /safe search/i })).toBeInTheDocument();
  });

  it("renders Save and Apply changes buttons", async () => {
    renderDnsPage();

    await waitFor(() => {
      const saveButtons = screen.getAllByRole("button", { name: /save/i });
      expect(saveButtons.length).toBeGreaterThanOrEqual(1);
    });

    const applyButtons = screen.getAllByRole("button", { name: /apply changes/i });
    expect(applyButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows confirm dialog when Apply changes is clicked", async () => {
    const user = userEvent.setup();
    renderDnsPage();

    await waitFor(() => {
      const applyButtons = screen.getAllByRole("button", { name: /apply changes/i });
      const enabledApply = applyButtons.find((b) => !b.hasAttribute("disabled"));
      expect(enabledApply).toBeTruthy();
    });

    const applyButtons = screen.getAllByRole("button", { name: /apply changes/i });
    const enabledApply = applyButtons.find((b) => !b.hasAttribute("disabled"));
    await user.click(enabledApply);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(/apply/i);
  });
});
