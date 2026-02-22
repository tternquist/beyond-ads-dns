import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import SettingsPage from "./SettingsPage.jsx";

const minimalSystemConfig = {
  server: {},
  cache: {},
  query_store: {},
  control: {},
  logging: {},
};

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/system/config")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => minimalSystemConfig,
      });
    }
    if (url.includes("/api/auth/status")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ authEnabled: false }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderSettingsPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <SettingsPage />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("SettingsPage - Clear Redis and ClickHouse", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Clear Redis cache and Clear ClickHouse data buttons after config loads", async () => {
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /clear clickhouse data/i })).toBeInTheDocument();
  });

  it("shows confirm dialog when Clear Redis cache is clicked", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });

    const clearRedisBtn = screen.getAllByRole("button", { name: /clear redis cache/i })[0];
    await user.click(clearRedisBtn);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Clear Redis cache");
    expect(dialog).toHaveTextContent(/clear all dns cache entries from redis/i);
  });

  it("calls clear Redis API when user confirms in dialog", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/system/config")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalSystemConfig,
        });
      }
      if (url.includes("/api/auth/status")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ authEnabled: false }),
        });
      }
      if (url.includes("/api/system/clear/redis")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /clear redis cache/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      const clearCalls = fetchMock.mock.calls.filter(
        (call) => (typeof call[0] === "string" ? call[0] : call[0]?.url || "").includes("/api/system/clear/redis")
      );
      expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows success toast when Redis clear succeeds", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/system/config")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalSystemConfig,
        });
      }
      if (url.includes("/api/auth/status")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ authEnabled: false }),
        });
      }
      if (url.includes("/api/system/clear/redis")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /clear redis cache/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/redis cache cleared/i);
    });
  });

  it("shows confirm dialog when Clear ClickHouse data is clicked", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear clickhouse data/i })).toBeInTheDocument();
    });

    const clearClickhouseBtn = screen.getAllByRole("button", { name: /clear clickhouse data/i })[0];
    await user.click(clearClickhouseBtn);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Clear ClickHouse data");
    expect(dialog).toHaveTextContent(/clear all query data from clickhouse/i);
  });

  it("calls clear ClickHouse API when user confirms in dialog", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/system/config")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalSystemConfig,
        });
      }
      if (url.includes("/api/auth/status")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ authEnabled: false }),
        });
      }
      if (url.includes("/api/system/clear/clickhouse")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear clickhouse data/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /clear clickhouse data/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      const clearCalls = fetchMock.mock.calls.filter(
        (call) => (typeof call[0] === "string" ? call[0] : call[0]?.url || "").includes("/api/system/clear/clickhouse")
      );
      expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does not call API when user cancels confirm dialog", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /clear redis cache/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    const clearCalls = fetchMock.mock.calls.filter(
      (call) => (typeof call[0] === "string" ? call[0] : call[0]?.url || "").includes("/api/system/clear/")
    );
    expect(clearCalls.length).toBe(0);
  });

  it("shows error when Redis clear API fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/system/config")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalSystemConfig,
        });
      }
      if (url.includes("/api/auth/status")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ authEnabled: false }),
        });
      }
      if (url.includes("/api/system/clear/redis")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "Control API unreachable" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clear redis cache/i })).toBeInTheDocument();
    });

    const clearRedisBtn = screen.getAllByRole("button", { name: /clear redis cache/i })[0];
    await user.click(clearRedisBtn);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(
      () => {
        const errorElements = screen.getAllByText(/control api unreachable|failed to clear redis/i);
        expect(errorElements.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 }
    );
  });
});
