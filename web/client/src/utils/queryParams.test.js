import { describe, it, expect } from "vitest";
import { buildQueryParams } from "./queryParams.js";

describe("buildQueryParams", () => {
  it("includes required params", () => {
    const params = buildQueryParams({
      queryPage: 1,
      queryPageSize: 50,
      querySortBy: "timestamp",
      querySortDir: "desc",
    });
    expect(params.get("page")).toBe("1");
    expect(params.get("page_size")).toBe("50");
    expect(params.get("sort_by")).toBe("timestamp");
    expect(params.get("sort_dir")).toBe("desc");
  });
  it("adds filter params when provided", () => {
    const params = buildQueryParams({
      queryPage: 1,
      queryPageSize: 50,
      querySortBy: "timestamp",
      querySortDir: "desc",
      filterQName: "example.com",
      filterOutcome: "blocked",
      filterSinceMinutes: "60",
    });
    expect(params.get("qname")).toBe("example.com");
    expect(params.get("outcome")).toBe("blocked");
    expect(params.get("since_minutes")).toBe("60");
  });
  it("omits empty filter params", () => {
    const params = buildQueryParams({
      queryPage: 1,
      queryPageSize: 50,
      querySortBy: "timestamp",
      querySortDir: "desc",
    });
    expect(params.has("qname")).toBe(false);
    expect(params.has("outcome")).toBe(false);
  });
  it("adds free-text search param when provided", () => {
    const params = buildQueryParams({
      queryPage: 1,
      queryPageSize: 50,
      querySortBy: "ts",
      querySortDir: "desc",
      filterSearch: "google",
    });
    expect(params.get("q")).toBe("google");
  });
});
