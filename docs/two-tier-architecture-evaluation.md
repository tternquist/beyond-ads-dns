# Two-Tier TTL Architecture: Code and Architecture Evaluation

**Date:** 2026-03-08  
**Scope:** Recent changes implementing the two-tier TTL model (client cap, hot/warm refresh, authoritative TTL awareness)

---

## Executive Summary

The two-tier TTL implementation is **architecturally sound**, **well-documented**, and **consistent** with existing patterns. The design cleanly separates internal cache TTL from client-facing TTL, integrates hot/warm refresh with authoritative TTL awareness, and exposes configuration through config, Control API, UI, and webhooks. A few minor recommendations are noted for future refinement.

---

## 1. Architecture Overview

### 1.1 Design Goals (from `docs/two-tier-ttl-investigation.md`)

- **Internal cache TTL (long):** Resolver retains records 1h–24h to maximize cache hits and reduce upstream traffic.
- **Client-facing TTL (short):** Responses from cache cap TTL at `client_ttl_cap` (default 5m) so clients re-query frequently and see changes quickly.

### 1.2 Key Components

| Component | Responsibility |
|-----------|----------------|
| `cache.client_ttl_cap` | Max TTL in client responses when serving from cache; 0 = disabled |
| `GetWithTTL` / `SetWithIndex` | Cache interface returns `storedTTL` and `authTTL` for refresh decisions |
| `maybeRefresh` | Hot/warm classification, fraction-based thresholds, refresh-past-auth-TTL |
| `refreshCache` | Hot entries use source TTL (no min extend); warm/normal use min_ttl |
| `RefreshConfigSnapshot` | Exposes effective config to Control API, UI, webhook |

---

## 2. Code Consistency Evaluation

### 2.1 Alignment with Code and Architecture Standards

**Strengths:**

- **Documentation:** `docs/two-tier-ttl-investigation.md` clearly describes the model, config, and implementation. Referenced from `docs/code-and-architecture-standards.md` (§8) and `docs/performance.md`.
- **Config layering:** `client_ttl_cap` and refresh settings follow the existing pattern: default YAML → override YAML → env overrides. `applyDefaults` handles adaptive `hot_threshold_rate` when `client_ttl_cap` is set.
- **Interface design:** `DNSCache` interface extended with `GetWithTTL` (returns `storedTTL`, `authTTL`) and `SetWithIndex` (accepts `authTTL`). Compile-time check `var _ DNSCache = (*RedisCache)(nil)` preserved.
- **Naming:** `clientTTLCap`, `storedTTL`, `authTTL`, `refreshPastAuthTTL` are consistent with existing conventions.
- **Error handling:** Cache errors logged; SERVFAIL backoff and refresh lock semantics unchanged.
- **Concurrency:** Hit counting and refresh scheduling remain in background goroutines; no new locks introduced.

### 2.2 Package Layout Consistency

| Package | Change | Assessment |
|---------|--------|------------|
| `internal/dnsresolver` | `clientTTLCap`, `maybeRefresh` hot/warm logic, `refreshConfig` | Fits existing resolver responsibilities |
| `internal/cache` | `GetWithTTL` / `SetWithIndex` signatures, `stored_ttl` / `auth_ttl` in Redis hash | Aligns with cache abstraction |
| `internal/config` | `ClientTTLCap`, `RefreshPastAuthTTL`, fraction/threshold fields | Matches config struct patterns |
| `internal/control` | `refresh_config` in `/cache/refresh/stats` | Consistent with stats payload design |
| `web/client` | CacheSettings hot/warm fields, OverviewPage refresh config table | Follows Settings/Overview patterns |
| `web/server` | `refresh_config` in usage stats webhook | Matches webhook payload structure |

---

## 3. Implementation Quality

### 3.1 Resolver Logic (`internal/dnsresolver/resolver.go`)

**Two-tier TTL application (lines 601–614):**

```go
if ttl > 0 && r.clientTTLCap > 0 {
    clientTTL := ttl
    if clientTTL > r.clientTTLCap {
        clientTTL = r.clientTTLCap
    }
    setMsgTTL(cached, clientTTL)
} else if ttl <= 0 && staleWithin && r.refresh.expiredEntryTTL > 0 {
    clientTTL := r.refresh.expiredEntryTTL
    if r.clientTTLCap > 0 && clientTTL > r.clientTTLCap {
        clientTTL = r.clientTTLCap
    }
    setMsgTTL(cached, clientTTL)
}
```

- **Correctness:** Client TTL is capped for both fresh and stale responses. Stale path correctly uses `expiredEntryTTL` and applies cap.
- **Performance:** Single conditional; no extra allocations.

**Refresh decision flow (`maybeRefresh`):**

1. **Refresh-past-auth-TTL:** When `refreshPastAuthTTL` and `storedTTL > authTTL`, refresh if `elapsed >= authTTL`. Correctly prioritizes freshness for extended entries.
2. **Hot/warm thresholds:** Uses `hot_ttl_fraction` / `warm_ttl_fraction` when > 0, else fixed `hot_ttl` / `warm_ttl`. Fraction-based logic scales with `storedTTL`.
3. **Hot entry storage:** `refreshCache` uses `clampTTL(ttl, 0, r.maxTTL, true)` for hot entries (no min extend), reducing stale risk.

### 3.2 Cache Layer

**Redis schema (`docs/redis-key-schema.md`):**

- `stored_ttl` and `auth_ttl` added to hash layout. Documented as optional for backward compatibility.
- Legacy string format still supported; migration via `SetWithIndex` on read.

**MockCache:**

- `SetEntry`, `SetEntryWithAuthTTL`, `SetEntryWithStoredAndAuthTTL` support tests for client cap, refresh-past-auth, and fraction thresholds.
- `GetWithTTL` returns `storedTTL` and `authTTL`; `SetWithIndex` stores them.

### 3.3 Config Defaults

- `client_ttl_cap: "5m"` in `config/default.yaml`; `applyDefaults` does not override if user sets 0.
- `hot_threshold_rate` adapts to `client_ttl_cap`: with 5m cap, ~2/min so ~3 clients = hot; single client stays warm.
- `refresh_past_auth_ttl: true` by default; `warm_ttl_fraction: 0.25`, `hot_ttl_fraction: 0.3` in defaults.

---

## 4. Test Coverage

| Test | Coverage |
|------|----------|
| `TestResolverClientTTLCap` | Two-tier TTL: cached response with 1h TTL, cap 60s → client receives 60s |
| `TestResolverStaleServingExpiredEntryTTL` | Stale serving uses `expired_entry_ttl` and applies client cap |
| `TestHotThresholdRateAdaptiveToClientTTLCap` | Config: `hot_threshold_rate` adapts to `client_ttl_cap` |
| `internal/control/reload_test.go` | `refresh_config` in `/cache/refresh/stats` includes two-tier/hot/warm fields |
| `web/server/test/usageStatsWebhook.test.js` | Webhook payload includes `refresh_config` |

**Gaps (low priority):**

- No dedicated test for refresh-past-auth-TTL path (would require `SetEntryWithStoredAndAuthTTL` + mock upstream).
- No integration test for fraction-based hot/warm thresholds end-to-end.

---

## 5. Documentation Consistency

| Document | Status |
|----------|--------|
| `docs/two-tier-ttl-investigation.md` | Up to date; describes model, config, hot/warm, references |
| `docs/performance.md` | Two-tier section, `refresh_config` in stats |
| `docs/redis-key-schema.md` | `stored_ttl`, `auth_ttl` in hash layout |
| `docs/refresh-config-simplification-notes.md` | Design principles; `refresh_past_auth_ttl` as single-switch pattern |
| `docs/refresh-ttl-fraction-migration.md` | Warm fraction migration; references `refresh_config` |
| `README.md` | `client_ttl_cap` in config overview |
| `config/default.yaml` | Inline comments for two-tier and hot/warm |

---

## 6. UI and API Exposure

**CacheSettings.jsx:**

- Client TTL cap field with label "Client TTL cap (two-tier TTL)", placeholder "5m (empty = disabled)", validation.

**OverviewPage.jsx:**

- Refresh config table: `cache_min_ttl`, `refresh_min_ttl`, `refresh_past_auth_ttl`, `client_ttl_cap`, `hot_threshold_rate`, `hot_ttl_fraction`, `warm_threshold`, `warm_ttl`, `warm_ttl_fraction`.

**Control API:**

- `/cache/refresh/stats` returns `refresh_config` with effective two-tier/hot/warm settings.

**Webhook:**

- Usage stats payload includes `refresh_config` for external monitoring.

---

## 7. Recommendations

### 7.1 Completed / No Action

- Architecture and implementation are consistent with existing patterns.
- Documentation is aligned with code.
- Config, API, and UI exposure follow development guidelines.

### 7.2 Implemented Improvements

1. **Test coverage:** `TestResolverRefreshPastAuthTTL` exists and validates the refresh-past-auth path.
2. **Refresh config presets:** `refresh_mode: "aggressive" | "balanced" | "conservative" | "custom"` implemented. UI shows Custom when non-preset values are specified.
3. **Code-review doc:** `docs/code-review.md` §1.3 clarified that "two-tier" refers to both L0/L1 cache and internal vs client-facing TTL.

### 7.3 Performance

- Client TTL cap logic adds negligible cost (one comparison per cache hit).
- `stored_ttl` and `auth_ttl` in Redis add two hash fields; storage impact is minimal.
- Hot/warm classification and fraction math are O(1) per request.

---

## 8. Conclusion

The two-tier TTL implementation is **well-integrated**, **documented**, and **consistent** with the codebase. It follows established patterns for config, caching, refresh, and UI/API exposure. The design achieves the stated goals: long internal TTL for cache efficiency and short client TTL for freshness, with hot/warm refresh and authoritative TTL awareness. No blocking issues were identified; optional improvements are limited to test coverage and documentation clarity.
