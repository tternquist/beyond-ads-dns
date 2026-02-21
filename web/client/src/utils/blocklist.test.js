import { describe, it, expect } from "vitest";
import {
  normalizeDomainForBlocklist,
  escapeDomainForRegex,
  isDomainBlockedByDenylist,
  isDomainInAllowlist,
  getDenylistEntriesBlocking,
  isServiceBlockedByDenylist,
} from "./blocklist.js";

describe("normalizeDomainForBlocklist", () => {
  it("normalizes domain to lowercase", () => {
    expect(normalizeDomainForBlocklist("Example.COM")).toBe("example.com");
  });
  it("trims whitespace", () => {
    expect(normalizeDomainForBlocklist("  example.com  ")).toBe("example.com");
  });
  it("removes trailing dot", () => {
    expect(normalizeDomainForBlocklist("example.com.")).toBe("example.com");
  });
  it("returns empty for invalid input", () => {
    expect(normalizeDomainForBlocklist("")).toBe("");
    expect(normalizeDomainForBlocklist(null)).toBe("");
    expect(normalizeDomainForBlocklist(123)).toBe("");
  });
});

describe("escapeDomainForRegex", () => {
  it("escapes special regex characters", () => {
    expect(escapeDomainForRegex("example.com")).toBe("example\\.com");
  });
});

describe("isDomainBlockedByDenylist", () => {
  it("returns true when domain matches exact entry", () => {
    expect(isDomainBlockedByDenylist("example.com", ["example.com"])).toBe(true);
  });
  it("returns true when subdomain matches parent entry", () => {
    expect(isDomainBlockedByDenylist("sub.example.com", ["example.com"])).toBe(true);
  });
  it("returns false when domain not in list", () => {
    expect(isDomainBlockedByDenylist("other.com", ["example.com"])).toBe(false);
  });
  it("returns false for empty list", () => {
    expect(isDomainBlockedByDenylist("example.com", [])).toBe(false);
  });
  it("supports regex patterns", () => {
    expect(isDomainBlockedByDenylist("ads.example.com", ["/ads\\./"])).toBe(true);
  });
});

describe("isDomainInAllowlist", () => {
  it("returns true when domain in allowlist", () => {
    expect(isDomainInAllowlist("example.com", ["example.com"])).toBe(true);
  });
  it("returns false when domain not in allowlist", () => {
    expect(isDomainInAllowlist("other.com", ["example.com"])).toBe(false);
  });
});

describe("getDenylistEntriesBlocking", () => {
  it("returns matching entries", () => {
    expect(getDenylistEntriesBlocking("example.com", ["example.com", "other.com"])).toEqual([
      "example.com",
    ]);
  });
  it("returns empty array when no match", () => {
    expect(getDenylistEntriesBlocking("other.com", ["example.com"])).toEqual([]);
  });
});

describe("isServiceBlockedByDenylist", () => {
  it("returns true when all service domains are blocked", () => {
    const service = { domains: ["a.com", "b.com"] };
    expect(isServiceBlockedByDenylist(service, ["a.com", "b.com"])).toBe(true);
  });
  it("returns false when not all domains blocked", () => {
    const service = { domains: ["a.com", "b.com"] };
    expect(isServiceBlockedByDenylist(service, ["a.com"])).toBe(false);
  });
});
