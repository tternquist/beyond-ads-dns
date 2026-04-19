import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CacheSettings from "./CacheSettings.jsx";

function defaultSystemConfig(overrides = {}) {
  return {
    cache: {
      redis_lru_size: "10000",
      redis_max_keys: "20000", // use distinct value to avoid ambiguous matches
      min_ttl: "300s",
      max_ttl: "2h",           // distinct from stale_ttl default "1h"
      negative_ttl: "3m", // use distinct value (avoid collision with refresh_warm_ttl default "5m")
      serve_stale: true,
      stale_ttl: "1h",
      expired_entry_ttl: "30s",
    },
    query_store: { enabled: false },
    ...overrides,
  };
}

describe("CacheSettings", () => {
  it("renders Redis LRU size field with configured value", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    // redis_lru_size=10000 rendered as display value
    expect(screen.getByDisplayValue("10000")).toBeInTheDocument();
  });

  it("renders min TTL field with configured value", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("300s")).toBeInTheDocument();
  });

  it("renders max TTL field with configured value", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("2h")).toBeInTheDocument();
  });

  it("renders negative TTL field with configured value", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    // negative_ttl is set to "3m" in defaultSystemConfig (distinct from warm_ttl default)
    expect(screen.getByDisplayValue("3m")).toBeInTheDocument();
  });

  it("calls updateSystemConfig when min TTL changes", async () => {
    const updateSystemConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={updateSystemConfig}
      />
    );
    const input = screen.getByDisplayValue("300s");
    await user.clear(input);
    await user.type(input, "60s");
    expect(updateSystemConfig).toHaveBeenCalledWith("cache", "min_ttl", expect.any(String));
  });

  it("renders degraded mode checkbox", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(
      screen.getByRole("checkbox", { name: /degraded mode when redis unavailable/i })
    ).toBeInTheDocument();
  });

  it("renders serve stale checkbox checked by default", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(
      screen.getByRole("checkbox", { name: /serve stale for performance and resilience/i })
    ).toBeChecked();
  });

  it("renders serve stale checkbox unchecked when serve_stale is false", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig({
          cache: { ...defaultSystemConfig().cache, serve_stale: false },
        })}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(
      screen.getByRole("checkbox", { name: /serve stale for performance and resilience/i })
    ).not.toBeChecked();
  });

  it("calls updateSystemConfig when serve stale is toggled", async () => {
    const updateSystemConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={updateSystemConfig}
      />
    );
    await user.click(
      screen.getByRole("checkbox", { name: /serve stale for performance and resilience/i })
    );
    expect(updateSystemConfig).toHaveBeenCalledWith("cache", "serve_stale", false);
  });

  it("shows validation error for redis_lru_size field when present", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        systemConfigValidation={{ fieldErrors: { cache_redis_lru_size: "Must be a positive integer" } }}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByText("Must be a positive integer")).toBeInTheDocument();
  });

  it("renders a refresh mode select", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    // The refresh mode select is the only <select> in the component
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });

  it("calls updateSystemConfig with preset values when refresh mode changes to aggressive", async () => {
    const updateSystemConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={updateSystemConfig}
      />
    );
    const refreshSelect = screen.getAllByRole("combobox")[0];
    await user.selectOptions(refreshSelect, "aggressive");
    expect(updateSystemConfig).toHaveBeenCalledWith(
      "cache",
      null,
      expect.objectContaining({ refresh_mode: "aggressive" })
    );
  });

  it("does not show query store fields when query_store is disabled", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig({ query_store: { enabled: false } })}
        updateSystemConfig={vi.fn()}
      />
    );
    // flush_to_store_interval field only appears when query_store is enabled
    expect(screen.queryByPlaceholderText("5s")).not.toBeInTheDocument();
  });

  it("shows query store fields when query_store is enabled", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig({ query_store: { enabled: true, flush_to_store_interval: "5s" } })}
        updateSystemConfig={vi.fn()}
      />
    );
    // "5s" appears as placeholder for flush_to_store_interval and flush_to_disk_interval
    const inputs = screen.getAllByPlaceholderText("5s");
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("renders refresh_past_auth_ttl checkbox checked when not explicitly false", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(
      screen.getByRole("checkbox", { name: /refresh hot\/warm when past authoritative ttl/i })
    ).toBeChecked();
  });

  it("renders stale TTL field with configured value", () => {
    render(
      <CacheSettings
        systemConfig={defaultSystemConfig()}
        updateSystemConfig={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("1h")).toBeInTheDocument();
  });
});
