import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import IntegrationsPage from "./IntegrationsPage.jsx";

const minimalWebhooks = {
  on_block: { enabled: false, targets: [] },
  on_error: { enabled: false, targets: [] },
  targets: [{ id: "default", label: "Default" }],
};

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/webhooks")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => minimalWebhooks,
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderIntegrationsPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <IntegrationsPage />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("IntegrationsPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders Integrations section with Block webhook and Error webhook after data loads", async () => {
    renderIntegrationsPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /integrations/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: /block webhook/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /error webhook/i })).toBeInTheDocument();
    expect(screen.getByText(/manage webhooks for block and error events/i)).toBeInTheDocument();
  });

  it("renders Enable webhook checkbox for Block webhook", async () => {
    renderIntegrationsPage();

    await waitFor(() => {
      expect(screen.getByText(/block webhook/i)).toBeInTheDocument();
    });

    const enableCheckboxes = screen.getAllByRole("checkbox", { name: /enable webhook/i });
    expect(enableCheckboxes.length).toBeGreaterThanOrEqual(1);
  });

  it("calls webhooks API when Save is clicked", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/webhooks")) {
        if (input?.method === "PUT" || (typeof input === "object" && input?.method === "PUT")) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({}),
          });
        }
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalWebhooks,
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderIntegrationsPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save webhooks/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /save webhooks/i }));

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter((call) => {
        const url = typeof call[0] === "string" ? call[0] : call[0]?.url || "";
        const method = typeof call[1] === "object" && call[1]?.method;
        return url.includes("/api/webhooks") && method === "PUT";
      });
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
