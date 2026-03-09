import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import { AppProvider } from "../context/AppContext.jsx";
import LocalRecordsPage from "./LocalRecordsPage.jsx";

function createFetchMock(records = []) {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/dns/local-records")) {
      const method = typeof input === "object" && input?.method?.toUpperCase();
      if (method === "PUT") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ records: [] }),
        });
      }
      if (method === "POST") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ records }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderLocalRecordsPage(records = []) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider value={{ isReplica: false }}>
            <LocalRecordsPage />
          </AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("LocalRecordsPage - Route53-inspired layout", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock([]);
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Local DNS Records header and Create record button after load", async () => {
    renderLocalRecordsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /local dns records/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /create record/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/filter records by name/i)).toBeInTheDocument();
  });

  it("shows Record details panel when empty", async () => {
    renderLocalRecordsPage();

    await waitFor(() => {
      expect(screen.getByText(/select a record to view or edit/i)).toBeInTheDocument();
    });
  });

  it("shows records in table when data is loaded", async () => {
    fetchMock = createFetchMock([
      { name: "router.local", type: "A", value: "192.168.1.1" },
      { name: "nas.local", type: "A", value: "192.168.1.10" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    renderLocalRecordsPage();

    await waitFor(() => {
      expect(screen.getByText("router.local")).toBeInTheDocument();
      expect(screen.getByText("nas.local")).toBeInTheDocument();
    });
  });

  it("links to DNS Settings page", async () => {
    renderLocalRecordsPage();

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /dns settings/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/dns");
    });
  });
});
