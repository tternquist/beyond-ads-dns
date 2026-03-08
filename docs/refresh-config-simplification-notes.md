# Refresh Config Simplification Notes

This document captures ideas for simplifying the refresh configuration, which has grown to many dials over time.

## Current State

Refresh config includes:
- **Hot:** hot_threshold, hot_threshold_rate, hot_ttl, hot_ttl_fraction
- **Warm:** warm_threshold, warm_ttl, warm_ttl_fraction
- **Normal:** min_ttl
- **Sweep:** sweep_interval, sweep_window, max_batch_size, sweep_min_hits, sweep_hit_window
- **Stale:** serve_stale, stale_ttl, expired_entry_ttl
- **Auth TTL:** refresh_past_auth_ttl (new)

## Simplification Ideas

### 1. Preset modes (implemented)

`refresh_mode: "aggressive" | "balanced" | "conservative" | "custom"` sets multiple params:
- **aggressive:** Higher hit rate, more refreshes, faster freshness (hot_ttl_fraction 0.5, warm_threshold 1, etc.)
- **balanced:** Default behavior (hot_ttl_fraction 0.3, warm_threshold 2, etc.)
- **conservative:** Fewer refreshes, lower upstream load (refresh_past_auth_ttl false, hot_ttl_fraction 0.2, etc.)
- **custom:** Use explicit values; UI switches to Custom when any preset-controlled field is edited

Reduces cognitive load for operators who don't want to tune individual dials.

### 2. Unify fraction-based thresholds

Hot and warm already use fraction OR fixed TTL. Consider deprecating hot_ttl and warm_ttl in favor of fractions only (with sensible defaults). Reduces "which do I use?" confusion.

### 3. Single "prioritize hot/warm" switch

The new `refresh_past_auth_ttl` is a single switch that enables authoritative-TTL-aware refresh for hot/warm entries. No new threshold dials—reuses existing hot/warm classification. This pattern (one switch, reuse existing logic) keeps config manageable.

### 4. Group related settings in UI

The UI could collapse advanced refresh settings behind "Show advanced" or group them into:
- **Freshness:** hot/warm fractions, refresh_past_auth_ttl
- **Sweep:** interval, window, batch size
- **Stale serving:** serve_stale, stale_ttl

## Recommendation

For now, keep the current structure but:

### Design principle: Prefer single switches over new threshold dials

When adding new refresh behavior, **prefer a single boolean switch** (like `refresh_past_auth_ttl`) that reuses existing classification (hot/warm) rather than introducing new threshold dials. This pattern keeps config manageable and reduces operator cognitive load. Example: `refresh_past_auth_ttl` enables authoritative-TTL-aware refresh for hot/warm entries without adding new knobs.

### Document the "fraction vs fixed" choice

See [Performance: Fraction vs Fixed TTL](performance.md#fraction-vs-fixed-ttl) for when to use fraction-based vs fixed-duration thresholds.

### Preset modes: Implemented

`refresh_mode` presets are implemented. See §1 above. Config: `cache.refresh.refresh_mode`. UI: Cache Settings → Refresh mode dropdown. When non-preset values are specified, the UI shows "Custom".
