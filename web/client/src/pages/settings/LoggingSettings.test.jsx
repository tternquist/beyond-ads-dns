import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoggingSettings from "./LoggingSettings.jsx";

function defaultSystemConfig(overrides = {}) {
  return {
    logging: { level: "warning", format: "text" },
    control: {},
    request_log: { enabled: false },
    ...overrides,
  };
}

// Returns the [log-level select, log-format select] comboboxes.
// The component renders these as the first two <select> elements (when request_log is disabled).
function getLogSelects() {
  return screen.getAllByRole("combobox");
}

describe("LoggingSettings", () => {
  it("renders at least two select elements (log level and log format)", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(getLogSelects().length).toBeGreaterThanOrEqual(2);
  });

  it("shows current log level value as selected option", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig({ logging: { level: "debug", format: "text" } })}
        updateSystemConfig={vi.fn()}
      />
    );
    // Log level select is the first combobox
    expect(getLogSelects()[0].value).toBe("debug");
  });

  it("shows current log format value as selected option", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig({ logging: { level: "warning", format: "json" } })}
        updateSystemConfig={vi.fn()}
      />
    );
    // Log format select is the second combobox
    expect(getLogSelects()[1].value).toBe("json");
  });

  it("calls updateSystemConfig when log level changes", async () => {
    const updateSystemConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={updateSystemConfig}
      />
    );
    await user.selectOptions(getLogSelects()[0], "info");
    expect(updateSystemConfig).toHaveBeenCalledWith("logging", "level", "info");
  });

  it("calls updateSystemConfig when log format changes", async () => {
    const updateSystemConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={updateSystemConfig}
      />
    );
    await user.selectOptions(getLogSelects()[1], "json");
    expect(updateSystemConfig).toHaveBeenCalledWith("logging", "format", "json");
  });

  it("log level select has the expected options", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    const select = getLogSelects()[0];
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(expect.arrayContaining(["error", "warning", "info", "debug"]));
  });

  it("log format select has text and json options", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    const select = getLogSelects()[1];
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(expect.arrayContaining(["text", "json"]));
  });

  it("shows enable request logging checkbox", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByRole("checkbox", { name: /enable request logging/i })).toBeInTheDocument();
  });

  it("hides request log directory fields when request_log is disabled", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig({ request_log: { enabled: false } })}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.queryByPlaceholderText("logs")).not.toBeInTheDocument();
  });

  it("shows request log directory fields when request_log is enabled", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig({ request_log: { enabled: true, directory: "logs" } })}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText("logs")).toBeInTheDocument();
  });

  it("shows filename prefix field when request_log is enabled", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig({ request_log: { enabled: true } })}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText("dns-requests")).toBeInTheDocument();
  });

  it("shows format select when request_log is enabled", () => {
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig({ request_log: { enabled: true, format: "json" } })}
        updateSystemConfig={vi.fn()}
      />
    );
    // Should now have log-level, log-format, and request-log-format selects
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(3);
  });

  it("calls updateSystemConfig when request logging checkbox is toggled", async () => {
    const updateSystemConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <LoggingSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={updateSystemConfig}
      />
    );
    await user.click(screen.getByRole("checkbox", { name: /enable request logging/i }));
    expect(updateSystemConfig).toHaveBeenCalledWith("request_log", "enabled", true);
  });

  it("falls back to control.errors_log_level when logging.level is not set", () => {
    render(
      <LoggingSettings
        systemConfig={{ logging: {}, control: { errors_log_level: "error" }, request_log: {} }}
        updateSystemConfig={vi.fn()}
      />
    );
    // The log level select falls back to control.errors_log_level
    expect(getLogSelects()[0].value).toBe("error");
  });
});
