/**
 * Refresh mode presets for cache configuration.
 * When a preset is selected, these values are applied. When values don't match any preset, UI shows "custom".
 */
export const REFRESH_PRESETS = {
  balanced: {
    refresh_mode: "balanced",
    refresh_past_auth_ttl: true,
    refresh_hot_ttl_fraction: 0.3,
    refresh_warm_threshold: 2,
    refresh_warm_ttl: "5m",
    refresh_warm_ttl_fraction: 0.25,
    refresh_min_ttl: "1h",
  },
  aggressive: {
    refresh_mode: "aggressive",
    refresh_past_auth_ttl: true,
    refresh_hot_ttl_fraction: 0.5,
    refresh_warm_threshold: 1,
    refresh_warm_ttl: "3m",
    refresh_warm_ttl_fraction: 0.35,
    refresh_min_ttl: "30m",
  },
  conservative: {
    refresh_mode: "conservative",
    refresh_past_auth_ttl: false,
    refresh_hot_ttl_fraction: 0.2,
    refresh_warm_threshold: 3,
    refresh_warm_ttl: "10m",
    refresh_warm_ttl_fraction: 0.15,
    refresh_min_ttl: "2h",
  },
};

/**
 * Compare two values for preset matching. Handles number/string coercion.
 */
function valuesMatch(a, b) {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) {
    return Math.abs(na - nb) < 0.001;
  }
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/**
 * Returns the effective refresh mode by comparing current config to presets.
 * Returns "custom" if no preset matches.
 */
export function getEffectiveRefreshMode(cache) {
  if (!cache) return "custom";
  const configMode = String(cache.refresh_mode || "").trim().toLowerCase();
  if (configMode && configMode !== "custom" && REFRESH_PRESETS[configMode]) {
    const preset = REFRESH_PRESETS[configMode];
    if (
      valuesMatch(cache.refresh_past_auth_ttl, preset.refresh_past_auth_ttl) &&
      valuesMatch(cache.refresh_hot_ttl_fraction, preset.refresh_hot_ttl_fraction) &&
      valuesMatch(cache.refresh_warm_threshold, preset.refresh_warm_threshold) &&
      valuesMatch(cache.refresh_warm_ttl, preset.refresh_warm_ttl) &&
      valuesMatch(cache.refresh_warm_ttl_fraction, preset.refresh_warm_ttl_fraction) &&
      valuesMatch(cache.refresh_min_ttl, preset.refresh_min_ttl)
    ) {
      return configMode;
    }
  }
  for (const [name, preset] of Object.entries(REFRESH_PRESETS)) {
    if (
      valuesMatch(cache.refresh_past_auth_ttl, preset.refresh_past_auth_ttl) &&
      valuesMatch(cache.refresh_hot_ttl_fraction, preset.refresh_hot_ttl_fraction) &&
      valuesMatch(cache.refresh_warm_threshold, preset.refresh_warm_threshold) &&
      valuesMatch(cache.refresh_warm_ttl, preset.refresh_warm_ttl) &&
      valuesMatch(cache.refresh_warm_ttl_fraction, preset.refresh_warm_ttl_fraction) &&
      valuesMatch(cache.refresh_min_ttl, preset.refresh_min_ttl)
    ) {
      return name;
    }
  }
  return "custom";
}
