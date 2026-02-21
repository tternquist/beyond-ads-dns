import { describe, it, expect } from "vitest";
import {
  isValidDuration,
  isValidHttpUrl,
  isValidDnsName,
  isValidIPv4,
  isValidIPv6,
  validateUpstreamAddress,
  validateBlocklistForm,
  validateScheduledPauseForm,
  validateFamilyTimeForm,
  validateUpstreamsForm,
  validateLocalRecordsForm,
  validateReplicaSyncSettings,
  validateResponseForm,
  validateSystemConfig,
  getRowErrorText,
} from "./validation.js";

describe("isValidDuration", () => {
  it("accepts valid durations", () => {
    expect(isValidDuration("30s")).toBe(true);
    expect(isValidDuration("5m")).toBe(true);
    expect(isValidDuration("1h")).toBe(true);
    expect(isValidDuration("1.5h")).toBe(true);
    expect(isValidDuration("6h")).toBe(true);
  });
  it("rejects invalid durations", () => {
    expect(isValidDuration("")).toBe(false);
    expect(isValidDuration("0s")).toBe(false);
    expect(isValidDuration("abc")).toBe(false);
    expect(isValidDuration("30")).toBe(false);
    expect(isValidDuration("  ")).toBe(false);
  });
});

describe("isValidHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isValidHttpUrl("https://example.com")).toBe(true);
    expect(isValidHttpUrl("http://example.com/path")).toBe(true);
  });
  it("rejects non-http URLs", () => {
    expect(isValidHttpUrl("ftp://example.com")).toBe(false);
    expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
  });
  it("rejects invalid URLs", () => {
    expect(isValidHttpUrl("")).toBe(false);
    expect(isValidHttpUrl("not-a-url")).toBe(false);
  });
});

describe("isValidDnsName", () => {
  it("accepts valid DNS names", () => {
    expect(isValidDnsName("example.com")).toBe(true);
    expect(isValidDnsName("a")).toBe(true);
    expect(isValidDnsName("sub.example.com")).toBe(true);
    expect(isValidDnsName("example.com.")).toBe(true);
  });
  it("rejects invalid DNS names", () => {
    expect(isValidDnsName("")).toBe(false);
    expect(isValidDnsName("-invalid.com")).toBe(false);
    expect(isValidDnsName("a".repeat(254))).toBe(false);
  });
});

describe("isValidIPv4", () => {
  it("accepts valid IPv4 addresses", () => {
    expect(isValidIPv4("192.168.1.1")).toBe(true);
    expect(isValidIPv4("0.0.0.0")).toBe(true);
    expect(isValidIPv4("255.255.255.255")).toBe(true);
  });
  it("rejects invalid IPv4 addresses", () => {
    expect(isValidIPv4("256.1.1.1")).toBe(false);
    expect(isValidIPv4("192.168.1")).toBe(false);
    expect(isValidIPv4("192.168.1.1.1")).toBe(false);
    expect(isValidIPv4("::1")).toBe(false);
  });
});

describe("isValidIPv6", () => {
  it("accepts valid IPv6 addresses", () => {
    expect(isValidIPv6("::1")).toBe(true);
    expect(isValidIPv6("2001:db8::1")).toBe(true);
    expect(isValidIPv6("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects invalid IPv6 addresses", () => {
    expect(isValidIPv6("")).toBe(false);
    expect(isValidIPv6("192.168.1.1")).toBe(false);
    expect(isValidIPv6("gggg::1")).toBe(false);
  });
});

describe("validateUpstreamAddress", () => {
  it("accepts valid plain host:port", () => {
    expect(validateUpstreamAddress("1.1.1.1:53")).toBe("");
    expect(validateUpstreamAddress("8.8.8.8:53")).toBe("");
  });
  it("accepts valid DoT addresses", () => {
    expect(validateUpstreamAddress("tls://1.1.1.1:853")).toBe("");
  });
  it("accepts valid DoH URLs", () => {
    expect(validateUpstreamAddress("https://cloudflare-dns.com/dns-query")).toBe("");
  });
  it("rejects empty address", () => {
    expect(validateUpstreamAddress("")).not.toBe("");
    expect(validateUpstreamAddress("   ")).not.toBe("");
  });
  it("rejects invalid port", () => {
    expect(validateUpstreamAddress("1.1.1.1:99999")).not.toBe("");
  });
});

describe("validateBlocklistForm", () => {
  it("requires valid refresh interval", () => {
    const r = validateBlocklistForm({ refreshInterval: "0s", sources: [{ name: "x", url: "https://example.com" }] });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.refreshInterval).not.toBe("");
  });
  it("requires at least one source", () => {
    const r = validateBlocklistForm({ refreshInterval: "6h", sources: [] });
    expect(r.hasErrors).toBe(true);
  });
  it("accepts valid form", () => {
    const r = validateBlocklistForm({
      refreshInterval: "6h",
      sources: [{ name: "test", url: "https://example.com/list.txt" }],
    });
    expect(r.hasErrors).toBe(false);
  });
});

describe("validateScheduledPauseForm", () => {
  it("returns no errors when disabled", () => {
    const r = validateScheduledPauseForm({ enabled: false });
    expect(r.hasErrors).toBe(false);
  });
  it("validates time format", () => {
    const r = validateScheduledPauseForm({ enabled: true, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] });
    expect(r.hasErrors).toBe(false);
  });
  it("rejects end before start", () => {
    const r = validateScheduledPauseForm({ enabled: true, start: "17:00", end: "09:00", days: [] });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.end).toContain("after start");
  });
});

describe("validateFamilyTimeForm", () => {
  it("returns no errors when disabled", () => {
    const r = validateFamilyTimeForm({ enabled: false });
    expect(r.hasErrors).toBe(false);
  });
  it("validates time format and requires services", () => {
    const r = validateFamilyTimeForm({ enabled: true, start: "17:00", end: "20:00", days: [], services: ["tiktok"] });
    expect(r.hasErrors).toBe(false);
  });
  it("rejects empty services when enabled", () => {
    const r = validateFamilyTimeForm({ enabled: true, start: "17:00", end: "20:00", days: [], services: [] });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.services).toContain("at least one service");
  });
});

describe("validateUpstreamsForm", () => {
  it("requires at least one upstream", () => {
    const r = validateUpstreamsForm([]);
    expect(r.hasErrors).toBe(true);
  });
  it("accepts valid upstream", () => {
    const r = validateUpstreamsForm([{ name: "google", address: "8.8.8.8:53" }]);
    expect(r.hasErrors).toBe(false);
  });
});

describe("validateLocalRecordsForm", () => {
  it("accepts valid A record", () => {
    const r = validateLocalRecordsForm([{ name: "local.example.com", type: "A", value: "192.168.1.1" }]);
    expect(r.hasErrors).toBe(false);
  });
  it("rejects invalid A record IP", () => {
    const r = validateLocalRecordsForm([{ name: "local.example.com", type: "A", value: "not-an-ip" }]);
    expect(r.hasErrors).toBe(true);
  });
});

describe("validateReplicaSyncSettings", () => {
  it("requires primary URL", () => {
    const r = validateReplicaSyncSettings({ primaryUrl: "", syncInterval: "30s" });
    expect(r.hasErrors).toBe(true);
  });
  it("accepts valid settings", () => {
    const r = validateReplicaSyncSettings({
      primaryUrl: "http://primary:8081",
      syncInterval: "30s",
    });
    expect(r.hasErrors).toBe(false);
  });
});

describe("validateResponseForm", () => {
  it("accepts nxdomain", () => {
    const r = validateResponseForm({ blocked: "nxdomain", blockedTtl: "1h" });
    expect(r.hasErrors).toBe(false);
  });
  it("accepts valid IP for blocked", () => {
    const r = validateResponseForm({ blocked: "0.0.0.0", blockedTtl: "1h" });
    expect(r.hasErrors).toBe(false);
  });
  it("rejects invalid blocked value", () => {
    const r = validateResponseForm({ blocked: "not-an-ip", blockedTtl: "1h" });
    expect(r.hasErrors).toBe(true);
  });
});

describe("getRowErrorText", () => {
  it("joins row error values", () => {
    const text = getRowErrorText({ name: "Name error", url: "URL error" });
    expect(text).toContain("Name error");
    expect(text).toContain("URL error");
  });
});

describe("validateSystemConfig", () => {
  it("accepts valid config", () => {
    const r = validateSystemConfig({
      query_store: { enabled: true, retention_hours: "168", max_size_mb: "0" },
      server: { reuse_port_listeners: "4" },
      cache: { redis_lru_size: "10000", min_ttl: "300s", max_ttl: "1h" },
      control: { enabled: true, listen: "0.0.0.0:8081", errors_retention_days: "7" },
    });
    expect(r.hasErrors).toBe(false);
  });
  it("rejects invalid retention_hours", () => {
    const r = validateSystemConfig({
      query_store: { enabled: true, retention_hours: "abc", max_size_mb: "0" },
    });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.query_store_retention_hours).toBeTruthy();
  });
  it("rejects invalid duration", () => {
    const r = validateSystemConfig({
      cache: { min_ttl: "invalid" },
    });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.cache_min_ttl).toBeTruthy();
  });
  it("rejects invalid listen address", () => {
    const r = validateSystemConfig({
      control: { enabled: true, listen: "not-valid" },
    });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.control_listen).toBeTruthy();
  });
  it("rejects invalid sample_rate", () => {
    const r = validateSystemConfig({
      query_store: { enabled: true, sample_rate: "2.0" },
    });
    expect(r.hasErrors).toBe(true);
    expect(r.fieldErrors.query_store_sample_rate).toBeTruthy();
  });
});
