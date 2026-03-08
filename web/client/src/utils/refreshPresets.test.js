import { describe, it, expect } from "vitest";
import { REFRESH_PRESETS, getEffectiveRefreshMode } from "./refreshPresets.js";

describe("refreshPresets", () => {
  describe("getEffectiveRefreshMode", () => {
    it("returns custom when cache is null", () => {
      expect(getEffectiveRefreshMode(null)).toBe("custom");
    });

    it("returns balanced when values match balanced preset", () => {
      const cache = {
        refresh_past_auth_ttl: true,
        refresh_hot_ttl_fraction: 0.3,
        refresh_warm_threshold: 2,
        refresh_warm_ttl: "5m",
        refresh_warm_ttl_fraction: 0.25,
        refresh_min_ttl: "1h",
      };
      expect(getEffectiveRefreshMode(cache)).toBe("balanced");
    });

    it("returns aggressive when values match aggressive preset", () => {
      const cache = {
        refresh_past_auth_ttl: true,
        refresh_hot_ttl_fraction: 0.5,
        refresh_warm_threshold: 1,
        refresh_warm_ttl: "3m",
        refresh_warm_ttl_fraction: 0.35,
        refresh_min_ttl: "30m",
      };
      expect(getEffectiveRefreshMode(cache)).toBe("aggressive");
    });

    it("returns conservative when values match conservative preset", () => {
      const cache = {
        refresh_past_auth_ttl: false,
        refresh_hot_ttl_fraction: 0.2,
        refresh_warm_threshold: 3,
        refresh_warm_ttl: "10m",
        refresh_warm_ttl_fraction: 0.15,
        refresh_min_ttl: "2h",
      };
      expect(getEffectiveRefreshMode(cache)).toBe("conservative");
    });

    it("returns custom when values do not match any preset", () => {
      const cache = {
        refresh_past_auth_ttl: true,
        refresh_hot_ttl_fraction: 0.4,
        refresh_warm_threshold: 2,
        refresh_warm_ttl: "5m",
        refresh_warm_ttl_fraction: 0.25,
        refresh_min_ttl: "1h",
      };
      expect(getEffectiveRefreshMode(cache)).toBe("custom");
    });

    it("handles number/string coercion for fractions", () => {
      const cache = {
        refresh_past_auth_ttl: true,
        refresh_hot_ttl_fraction: "0.3",
        refresh_warm_threshold: 2,
        refresh_warm_ttl: "5m",
        refresh_warm_ttl_fraction: "0.25",
        refresh_min_ttl: "1h",
      };
      expect(getEffectiveRefreshMode(cache)).toBe("balanced");
    });
  });

  describe("REFRESH_PRESETS", () => {
    it("has all expected presets", () => {
      expect(Object.keys(REFRESH_PRESETS)).toContain("balanced");
      expect(Object.keys(REFRESH_PRESETS)).toContain("aggressive");
      expect(Object.keys(REFRESH_PRESETS)).toContain("conservative");
    });

    it("each preset has required fields", () => {
      const required = [
        "refresh_mode",
        "refresh_past_auth_ttl",
        "refresh_hot_ttl_fraction",
        "refresh_warm_threshold",
        "refresh_warm_ttl",
        "refresh_warm_ttl_fraction",
        "refresh_min_ttl",
      ];
      for (const preset of Object.values(REFRESH_PRESETS)) {
        for (const field of required) {
          expect(preset).toHaveProperty(field);
        }
      }
    });
  });
});
