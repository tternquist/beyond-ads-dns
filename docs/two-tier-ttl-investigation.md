# Two-Tier TTL Model

This document describes the two-tier TTL model implemented in beyond-ads-dns.

## Goal

Improve DNS resolver caching efficiency while preserving client freshness.

## Strategy

Maintain two TTL values:

- **Internal cache TTL** (long): How long the resolver keeps records in L0/L1 cache — e.g., 1h–24h — to maximize cache hits and reduce upstream queries.
- **Client-facing TTL** (short): What TTL the resolver returns in DNS responses when serving from cache — e.g., 60–120s — so clients re-query frequently and see changes quickly.

## Behavior

1. **On upstream response:**
   - `internalTTL = clampTTL(authoritativeTTL, min_ttl, max_ttl)` — e.g., min 1h, max 24h.
   - Store record in resolver cache using `internalTTL`.

2. **When responding to clients from cache:**
   - If `client_ttl_cap` is set (default 5m): return the cached record with `clientTTL = min(remainingTTL, client_ttl_cap)`.
   - If `client_ttl_cap` is not set: return the cached record with its original TTL (current behavior).

3. **Refresh-ahead:** Unchanged. If a cached entry is frequently queried and nearing expiration, it is refreshed asynchronously.

4. **Special cases:**
   - **Negative responses (NXDOMAIN):** Use `negative_ttl` (1–5 min) for internal cache; client TTL cap applies when serving from cache.
   - **Blocked domains:** Use `blocked_ttl` (e.g., 24h) — not served from cache, so client TTL cap does not apply.

## Configuration

```yaml
cache:
  min_ttl: "1h"        # Internal: extend short TTLs to at least this
  max_ttl: "24h"       # Internal: cap long TTLs
  client_ttl_cap: "5m"   # Client-facing: max TTL in responses when serving from cache. Omit = disabled. Default 5m.
  negative_ttl: "5m"
```

## Benefits

- Reduces upstream DNS traffic dramatically.
- Preserves client freshness (clients re-query at most every 5m; use 60s for faster propagation).
- Improves cache hit rate and resolver stability.
- Works with existing refresh sweeps and hot-entry tracking.

## Implementation

- **Config:** `cache.client_ttl_cap` (Duration, 0 = disabled)
- **Resolver:** When serving cached response, if `clientTTLCap > 0`, call `setMsgTTL(cached, min(remaining, clientTTLCap))`
- **Stale serving:** When serving expired entries, `expired_entry_ttl` is also capped by `client_ttl_cap` when set.

## Hot-Entry Authoritative TTL

For hot entries (frequently queried), the resolver can refresh according to authoritative TTL:

1. **Hot detection:** Rate-based: `hot_threshold_rate` (queries per minute). Entry is hot when `hits / (hit_window in minutes) ≥ hot_threshold_rate`. When `client_ttl_cap` is set, default adapts: with 5m cap, ~3 clients = hot (2/min), single client stays warm. Without client cap, default 20/min.
2. **Refresh threshold:** When `hot_ttl_fraction` is set (e.g. 0.3), hot entries refresh when `remaining ≤ fraction × stored_ttl` instead of a fixed `hot_ttl`.
3. **Storage on refresh:** When refreshing a hot entry, the new response is stored with source TTL (no `min_ttl` extension) to reduce stale data risk.

4. **Warm (low-hit) entries:** When hits ≤ `warm_threshold` (e.g. 2) and not hot, refresh when remaining ≤ `warm_ttl` (e.g. 5m) instead of `min_ttl` (30s). Enables self-correction when a single client retries stale data.

Config: `cache.refresh.hot_threshold_rate` (adaptive when 0 + client_ttl_cap set), `hot_ttl_fraction` (0 = disabled, use `hot_ttl`), `warm_threshold` (0 = disabled), `warm_ttl`.

## References

- [docs/performance.md](performance.md) — Cache architecture, refresh
- [docs/redis-key-schema.md](redis-key-schema.md) — L1 layout
- `internal/dnsresolver/resolver.go` — `clientTTLCap`, `setMsgTTL`, `maybeRefresh`, `refreshCache`
