import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatUtcToLocalTime,
  formatUtcToLocalDateTime,
  formatPercent,
  formatPctFromDistribution,
  formatErrorPctFromDistribution,
} from "./format.js";

describe("formatNumber", () => {
  it("formats numbers with locale", () => {
    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(0)).toBe("0");
  });
  it("returns dash for null/undefined", () => {
    expect(formatNumber(null)).toBe("-");
    expect(formatNumber(undefined)).toBe("-");
  });
});

describe("formatUtcToLocalTime", () => {
  it("returns empty for null", () => {
    expect(formatUtcToLocalTime(null)).toBe("");
  });
  it("formats ISO string without Z as UTC", () => {
    const result = formatUtcToLocalTime("2024-01-15T12:00:00");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

describe("formatUtcToLocalDateTime", () => {
  it("returns empty for null", () => {
    expect(formatUtcToLocalDateTime(null)).toBe("");
  });
  it("formats date-time string", () => {
    const result = formatUtcToLocalDateTime("2024-01-15T12:00:00");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

describe("formatPercent", () => {
  it("formats decimal as percentage", () => {
    expect(formatPercent(0.5)).toBe("50.00%");
    expect(formatPercent(0.1234)).toBe("12.34%");
  });
  it("returns dash for null/undefined", () => {
    expect(formatPercent(null)).toBe("-");
    expect(formatPercent(undefined)).toBe("-");
  });
});

describe("formatPctFromDistribution", () => {
  it("returns em dash for empty distribution", () => {
    expect(formatPctFromDistribution(null, "blocked")).toBe("—");
    expect(formatPctFromDistribution({ total: 0 }, "blocked")).toBe("—");
  });
  it("calculates percentage for outcome", () => {
    const dist = { blocked: 25, cached: 75, total: 100 };
    expect(formatPctFromDistribution(dist, "blocked")).toBe("25.00%");
    expect(formatPctFromDistribution(dist, "cached")).toBe("75.00%");
  });
});

describe("formatErrorPctFromDistribution", () => {
  it("returns em dash for empty distribution", () => {
    expect(formatErrorPctFromDistribution(null)).toBe("—");
  });
  it("sums error outcomes", () => {
    const dist = {
      upstream_error: 5,
      servfail: 3,
      servfail_backoff: 2,
      invalid: 10,
      total: 100,
    };
    const result = formatErrorPctFromDistribution(dist);
    expect(result).toBe("20.00%");
  });
});
