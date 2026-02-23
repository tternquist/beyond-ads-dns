import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import ErrorViewerPage from "./ErrorViewerPage.jsx";

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/errors")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          errors: [
            {
              message: "Test error message",
              timestamp: "2025-02-23T12:00:00Z",
              severity: "error",
            },
          ],
        }),
      });
    }
    if (url.includes("/api/trace-events")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ events: [], all_events: [] }),
      });
    }
    if (url.includes("/api/system/config")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ logging: { level: "info" } }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderErrorViewerPage() {
  return render(
    <ToastProvider>
      <ErrorViewerPage />
    </ToastProvider>
  );
}

describe("ErrorViewerPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Error Viewer heading and Refresh button", () => {
    renderErrorViewerPage();

    expect(screen.getByRole("heading", { name: /error viewer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("renders description about application errors", () => {
    renderErrorViewerPage();

    expect(
      screen.getByText(/recent application errors from the dns resolver/i)
    ).toBeInTheDocument();
  });

  it("renders error items when errors are returned", async () => {
    renderErrorViewerPage();

    await waitFor(() => {
      expect(screen.getByText(/test error message/i)).toBeInTheDocument();
    });
  });

  it("renders No errors recorded when errors array is empty", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/errors")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ errors: [] }),
        });
      }
      if (url.includes("/api/system/config")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderErrorViewerPage();

    await waitFor(() => {
      expect(screen.getByText(/no errors recorded/i)).toBeInTheDocument();
    });

    expect(
      screen.getByText(/the dns resolver has not recorded any errors/i)
    ).toBeInTheDocument();
  });

  it("renders Trace events collapsible section", () => {
    renderErrorViewerPage();

    expect(screen.getByText(/trace events/i)).toBeInTheDocument();
  });

  it("calls refresh when Refresh button is clicked", async () => {
    const user = userEvent.setup();
    renderErrorViewerPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      const errorCalls = fetchMock.mock.calls.filter(
        (call) => (typeof call[0] === "string" ? call[0] : call[0]?.url || "").includes("/api/errors")
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
