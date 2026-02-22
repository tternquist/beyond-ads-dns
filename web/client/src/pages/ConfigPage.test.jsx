import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../context/ToastContext.jsx";
import { ConfirmProvider } from "../context/ConfirmContext.jsx";
import ConfigPage from "./ConfigPage.jsx";

const minimalConfig = {
  blocklists: { sources: [], allowlist: [], denylist: [] },
  cache: {},
  server: {},
};

function createFetchMock() {
  return vi.fn((input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/config") && !url.includes("/api/config/export") && !url.includes("/api/config/import")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => minimalConfig,
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function renderConfigPage() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <ConfigPage />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("ConfigPage - end-to-end rendering", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    delete window.location;
    window.location = { href: "", assign: vi.fn(), replace: vi.fn() };
  });

  it("renders Active Configuration section with Import, Export, and Restart buttons after config loads", async () => {
    renderConfigPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /active configuration/i })).toBeInTheDocument();
    });

    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restart service/i })).toBeInTheDocument();
  });

  it("shows confirm dialog when Restart service is clicked", async () => {
    const user = userEvent.setup();
    renderConfigPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restart service/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /restart service/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    expect(screen.getByRole("dialog")).toHaveTextContent("Restart service");
    expect(screen.getByRole("dialog")).toHaveTextContent(/restart the dns service/i);
  });

  it("calls restart API when user confirms in dialog", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/config")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalConfig,
        });
      }
      if (url.includes("/api/restart")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderConfigPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restart service/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /restart service/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^restart$/i }));

    await waitFor(() => {
      const restartCalls = fetchMock.mock.calls.filter(
        (call) => (typeof call[0] === "string" ? call[0] : call[0]?.url || "").includes("/api/restart")
      );
      expect(restartCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("sets location.href when Export is clicked", async () => {
    const user = userEvent.setup();
    renderConfigPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => {
      expect(window.location.href).toContain("/api/config/export");
      expect(window.location.href).toContain("exclude_instance_details");
    });
  });

  it("imports config when valid YAML file is selected", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/config") && !url.includes("/api/config/import")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalConfig,
        });
      }
      if (url.includes("/api/config/import")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderConfigPage();

    await waitFor(() => {
      expect(screen.getByText("Import")).toBeInTheDocument();
    });

    const yamlContent = "blocklists:\n  sources: []\n  allowlist: []\n  denylist: []\n";
    const file = new File([yamlContent], "config.yaml", { type: "application/x-yaml" });
    const input = screen.getByLabelText("Import");
    await user.upload(input, file);

    await waitFor(() => {
      const elements = screen.getAllByText(/config imported successfully/i);
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows error when import API fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/config") && !url.includes("/api/config/import")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => minimalConfig,
        });
      }
      if (url.includes("/api/config/import")) {
        return Promise.resolve({
          ok: false,
          status: 400,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "Invalid config format" }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    renderConfigPage();

    await waitFor(() => {
      expect(screen.getByText("Import")).toBeInTheDocument();
    });

    const yamlContent = "blocklists:\n  sources: []\n";
    const file = new File([yamlContent], "config.yaml", { type: "application/x-yaml" });
    const input = screen.getByLabelText("Import");
    await user.upload(input, file);

    await waitFor(
      () => {
        const errorElements = screen.getAllByText(/invalid config format|failed to import/i);
        expect(errorElements.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 }
    );
  });
});
