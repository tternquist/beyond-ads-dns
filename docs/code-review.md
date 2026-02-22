# Code & Architecture Review: beyond-ads-dns

This document provides an in-depth review of the beyond-ads-dns codebase, organized into **Backend** and **UI** components. Each section covers architecture, strengths, and actionable recommendations.

**Last reviewed:** 2026-02-22

---

## Part 1: Backend Review (Go)

### 1.1 Overall Architecture

The backend is a DNS resolver built on `miekg/dns`, with a multi-tier caching layer (in-memory SIEVE → Redis), a blocklist engine with bloom filters, a query store (ClickHouse), and a control plane HTTP API. The architecture follows a clean package layout under `internal/`:

| Package | Responsibility |
|---------|---------------|
| `dnsresolver` | Core DNS handler, upstream exchange, refresh sweeper, safe search, connection pooling |
| `cache` | Multi-tier caching (ShardedLRU/SIEVE + Redis), hit batching, expiry index, sharded hit counter |
| `blocklist` | Domain blocking with bloom filters, allowlist/denylist, scheduled pause, family time |
| `config` | YAML config loading, validation, env overrides, deep merge, `NetworkConfig` grouping |
| `control` | HTTP control plane (reload, stats, CRUD, sync, pprof, Prometheus) |
| `querystore` | ClickHouse event ingestion with async buffering, partition management |
| `localrecords` | Static DNS records |
| `sync` | Multi-instance primary/replica sync |
| `webhook` | Configurable block/error notifications |
| `dohdot` | DoH/DoT server for encrypted client connections |
| `clientid` | Client IP → name/group resolution |
| `anonymize` | Client IP anonymization for privacy |
| `metrics` | Prometheus metrics integration |
| `errorlog` | Buffered error log with persistence |
| `tracelog` | Runtime-configurable trace events |
| `requestlog` | Per-query request logging with daily rotation |
| `logging` | Structured slog configuration |

**Strengths:**

- **Well-defined interfaces:** `cache.DNSCache` interface with compile-time check (`var _ DNSCache = (*RedisCache)(nil)`) enables testability and future backend swaps.
- **Performance-conscious design:** ShardedLRU with SIEVE eviction (32 shards), inline FNV-1a hashing (allocation-free), bloom filters for fast negative lookups, hit batching to reduce Redis round-trips, background cache writes to reduce client latency, sharded local hit counter for non-blocking refresh decisions.
- **Graceful degradation:** Stale serving, SERVFAIL backoff with rate-limited logging, upstream backoff/failover, connection pool retry on EOF.
- **Config layering:** Default → override YAML with deep merge, plus environment variable overrides for Docker deployments.
- **Good use of Go concurrency primitives:** `sync.RWMutex` for read-heavy paths, `atomic.Bool`/`atomic.Pointer` for shared flags, `chan struct{}` semaphore for max inflight, `context.WithTimeout` on all Redis/ClickHouse operations.
- **Clean sub-component extraction:** `upstreamManager`, `servfailTracker`, `connPool` are well-encapsulated with their own locks, reducing contention on the Resolver.
- **Comprehensive protocol support:** UDP, TCP, TLS (DoT), HTTPS (DoH), QUIC (DoQ) with per-protocol connection pooling.

---

### 1.2 Resolver (`internal/dnsresolver/resolver.go`)

**Strengths:**

- Clean request lifecycle: local records → safe search → blocklist → cache → upstream → cache write. Each exit path logs the request and fires webhooks consistently.
- Response written to client *before* async cache write — reduces perceived latency.
- Hit counting and refresh scheduling run in a background goroutine to avoid blocking the request handler.
- Instance-specific jitter on sweep intervals prevents thundering herd across replicas.
- `clientIPFromWriter` helper eliminates previous duplication of IP extraction logic.
- Request copying is deferred to retry path only — avoids allocation on the majority (first-attempt success) case.
- Per-group blocklist and safe search support is cleanly layered onto the global path.

**Current Recommendations:**

1. **`App.jsx` still holds 142 `useState` calls and 2,782 lines.** While page components have been extracted, App.jsx remains the state owner for nearly all features. The page components receive props from App.jsx rather than managing their own state. The next step is to push state ownership into page components and use Context/hooks for cross-cutting concerns (e.g., `useBlocklistState`, `useUpstreamState`). This would reduce App.jsx to a routing shell (~200 lines).

2. **Upstream protocol detection is duplicated** in `New()` (line ~156) and `ApplyUpstreamConfig()` (line ~904). Extract a `parseUpstream(cfg UpstreamConfig) Upstream` helper to eliminate the repeated `if strings.HasPrefix(...)` chain.

3. **Upstream config resolution (timeout, backoff, connPool) is duplicated** between `New()` and `ApplyUpstreamConfig()`. Both functions have identical logic to resolve `cfg.Network.*` vs `cfg.*` (legacy) with fallback defaults. Extract a `resolveNetworkConfig(cfg Config) (timeout, backoff, connPoolIdle, connPoolValidate)` function.

**Previously Resolved:**

- ~~Resolver struct too large~~ → Extracted `upstreamManager` and `servfailTracker`.
- ~~`servfailUntil`/`servfailCount` unbounded growth~~ → Hard cap of 10,000 with periodic pruning.
- ~~`clientIDEnabled` data race~~ → `atomic.Bool`.
- ~~Repeated client IP extraction~~ → `clientIPFromWriter` helper.
- ~~`exchange()` copies request per attempt~~ → Copy only on retry.

---

### 1.3 Cache Layer (`internal/cache/`)

**Strengths:**

- Two-tier (L0 + L1) with consistent TTL semantics across both layers.
- Grace period design (soft expiry + hard expiry) is well thought out — allows stale serving while preventing unbounded memory growth.
- **SIEVE eviction (NSDI '24):** `LRUCache.Get` uses `RLock` for the hot path (cache hit); only sets a visited bit atomically. No list reordering on hit, so reads are truly concurrent within a shard. Eviction scans tail→head, clearing visited bits and evicting the first unvisited entry.
- `ShardedLRUCache` with 32 shards and inline FNV-1a eliminates the mutex bottleneck at high QPS.
- `hitBatcher` coalesces Redis INCR operations, reducing Redis round-trips.
- `ShardedHitCounter` provides in-memory hit counts for immediate refresh decisions without Redis latency.
- `BatchCandidateChecks` pipelines Exists + GetSweepHitCount to minimize round-trips during sweep.
- Redis Cluster support with hash-tag aware key prefixes (`{dnsmeta}:` vs `dnsmeta:`).
- Redis key count is cached for 30s to avoid O(N) SCAN on every metrics poll.
- `ReconcileExpiryIndex` periodically removes orphaned entries from the expiry sorted set.

**Current Recommendations:**

1. **`msg.Copy()` on Get is still present.** Profile whether callers mutate the returned `dns.Msg`. If they don't (likely — `ServeDNS` only reads fields and calls `WriteMsg`), skip the copy and document the contract. At 10K+ entries and high QPS, this saves significant allocation pressure.

2. **`countKeysByPrefix` still uses SCAN.** While the 30s cache helps, consider tracking L1 key count locally with atomic counters on `SetWithIndex`/`DeleteCacheKey` for zero-overhead stats. The SCAN-based approach is O(N) even if cached; on restarts or first poll it causes a full scan.

**Previously Resolved:**

- ~~`LRUCache.Get` used exclusive lock~~ → SIEVE eviction enables `RLock` for reads.
- ~~`countKeysByPrefix` called on every poll~~ → Cached with 30s TTL.

---

### 1.4 Blocklist Engine (`internal/blocklist/`)

**Strengths:**

- Bloom filter (0.1% FPR) as a fast negative lookup before the hash-set check.
- Snapshot-based updates via `atomic.Value` — zero-downtime reloads without blocking reads.
- Skip-reload optimization when config is unchanged (avoids 100MB+ reallocations).
- Regex patterns limited to 2,048 characters; Go's RE2 engine prevents catastrophic backtracking.
- Family time and scheduled pause are cleanly separated concerns.
- Per-group blocklists for client group customization.

**Current Recommendations:**

1. **Blocklist source content validation.** If a source returns an HTML error page (HTTP 200 but not a domain list), it's parsed as zero domains and logged as a warning. Consider validating the first bytes of the response (check for `<html>` or Content-Type header) before attempting full parsing.

**Previously Resolved:**

- ~~Regex timeout/complexity limit~~ → 2,048 char limit; RE2 engine prevents backtracking.

---

### 1.5 Configuration (`internal/config/config.go`)

**Strengths:**

- Comprehensive validation with clear error messages.
- Deep merge of YAML configs allows partial overrides.
- Custom `Duration` type with YAML support for both string ("5s") and integer (5 → seconds) formats.
- Backward compatibility handled cleanly with deprecated field mapping.
- `NetworkConfig` groups related upstream/connection settings.

**Current Recommendations:**

1. **`applyDefaults` remains ~260 lines of sequential `if` checks.** While test coverage is comprehensive, this is maintenance-prone. Consider a table-driven approach or struct tags for defaults.

2. **`validateTimeWindow` rejects overnight windows (start > end).** Family time across midnight (e.g., 22:00–06:00) fails validation. This is documented behavior but may be a UX limitation.

**Previously Resolved:**

- ~~Config struct too large~~ → `NetworkConfig` grouping added.
- ~~Overnight family time not documented~~ → Documented.

---

### 1.6 Control Plane (`internal/control/server.go`)

**Strengths:**

- Clean handler registration with consistent auth and rate limiting patterns.
- Rate limiting on all mutation endpoints using `golang.org/x/time/rate`.
- pprof and Prometheus metrics endpoints for production debugging.
- Sync endpoints with separate token-based auth.
- Trace events configurable at runtime without restart.
- Client and client-group CRUD endpoints.

**Current Recommendations:**

1. **`handleBlockedCheck` requires auth when control token is set** — good. But the block page middleware in the web server also calls this endpoint. If the control token changes, the block page breaks silently. Consider a health-check or startup validation.

2. **`handleSyncStats` payload validation:** The endpoint accepts arbitrary JSON from replicas and stores in memory. Consider adding a size limit (`io.LimitReader`) on the request body.

**Previously Resolved:**

- ~~No rate limiting~~ → Added on all reload/mutation endpoints.
- ~~Config TOCTOU race~~ → Atomic rename.

---

### 1.7 Query Store (`internal/querystore/clickhouse.go`)

**Strengths:**

- Async buffering with channel-based backpressure.
- Auto-reinit schema on tmpfs wipe.
- `enforceMaxSize` runs every 12th flush (~60s) instead of every 5s flush.
- Partition ID validation (`isValidPartitionID`) prevents SQL injection from crafted ClickHouse responses.
- Async insert with configurable `flushToDiskInterval` to batch ClickHouse writes.
- Bounded HTTP transport (10 max connections) prevents connection accumulation.

**Current Recommendations:**

1. **Database/table names in SQL.** While `ensureSchema` uses `database` and `table` from config (not user input), and the Node.js side validates with `validateClickHouseIdentifier`, the Go side does not validate these identifiers before interpolation. Consider adding `isValidIdentifier` validation in `NewClickHouseStore`.

**Previously Resolved:**

- ~~`enforceMaxSize` on every flush~~ → Every 12th flush.
- ~~Partition SQL injection~~ → `isValidPartitionID` validation.

---

### 1.8 Concurrency & Thread Safety

**Strengths:**

- Consistent use of `sync.RWMutex` for read-heavy data.
- `atomic.Value` for snapshot-based updates (blocklist, scheduled pause, family time).
- `atomic.Bool` and `atomic.Pointer` for shared flags and pointers.
- `drained` flag on connection pool prevents use-after-drain.
- Semaphore pattern for bounding concurrent refreshes.

**No open issues.** All previously identified data races are resolved.

---

### 1.9 Test Coverage

The backend has comprehensive test coverage across all packages:

| Package | Test Files | Coverage Focus |
|---------|-----------|----------------|
| `dnsresolver` | `resolver_test.go`, `connpool_test.go`, `servfail_tracker_test.go` | Core resolution, caching, refresh, connection pooling, per-group blocklist, benchmarks |
| `cache` | `redis_test.go`, `lru_test.go`, `hit_counter_test.go`, `mock_test.go`, `cache_bench_test.go` | LRU/SIEVE eviction, sharding, TTL, Redis integration (miniredis), benchmarks |
| `blocklist` | `manager_test.go`, `parser_test.go`, `bloom_test.go`, `services_test.go`, `blocklist_bench_test.go` | Matching, parsing, bloom FPR, benchmarks |
| `config` | `config_test.go`, `override_test.go` | Loading, defaults, validation, deep merge, client groups |
| `querystore` | `exclusion_test.go`, `clickhouse_test.go` | Domain/client exclusion, ClickHouse with mock HTTP |
| `control` | `reload_test.go` | Blocklist reload, sync, client identification |
| `dohdot` | `server_test.go` | DoH handler GET/POST, validation |
| `errorlog` | `buffer_test.go`, `persistence_test.go` | Error buffering, persistence |
| `metrics` | `metrics_test.go` | Prometheus metrics |
| `localrecords` | `manager_test.go` | Local DNS record management |
| `logging` | `logging_test.go` | Log level parsing, logger creation |
| `requestlog` | `logger_test.go`, `daily_writer_test.go` | Request logging, daily rotation |
| `sync` | `primary_test.go`, `replicastats_test.go` | Token updates, replica stats |
| `webhook` | `webhook_test.go` | Webhook delivery |
| `anonymize` | `anonymize_test.go` | IP anonymization |
| `clientid` | `resolver_test.go` | Client ID resolution, groups |
| `tracelog` | `tracelog_test.go` | Trace event management |

**Current Recommendation:**

1. **The `cmd/perf-tester` has a `go vet` issue** where `runStats` (containing `sync.Mutex`) was passed by value. **Fixed in this review** — `runBenchmark` now returns `*runStats` and `printSummary` accepts `*runStats`.

---

## Part 2: UI Review (React Client + Node.js Server)

### 2.1 Overall Architecture

The UI consists of:

- **Node.js server** (`web/server/src/index.js` — 603 lines): Express app with route modules, services, and utilities.
- **React client** (`web/client/src/App.jsx` — 2,782 lines): SPA with extracted page components, shared hooks, and centralized API client.

**Well-structured module organization:**

| Layer | Path | Files |
|-------|------|-------|
| Server routes | `web/server/src/routes/` | 10 modules (auth, system, redis, queries, config, sync, dns, blocklists, webhooks, control) |
| Server services | `web/server/src/services/` | redis, clickhouse, usageStatsScheduler, usageStatsWebhook |
| Server utils | `web/server/src/utils/` | config, helpers |
| Client pages | `web/client/src/pages/` | 10 page components |
| Client components | `web/client/src/components/` | 11 reusable components |
| Client hooks | `web/client/src/hooks/` | useApiPolling, useDebounce, useQueryFilters |
| Client utils | `web/client/src/utils/` | apiClient, blocklist, constants, format, queryParams, validation |
| Client context | `web/client/src/context/` | AppContext, ToastContext |

---

### 2.2 Node.js Server

**Strengths:**

- **Well-modularized:** index.js is now 603 lines (down from 3,955), serving as an app factory and server startup only.
- Clean dependency injection via `app.locals.ctx` object.
- Redis client factory supporting standalone, sentinel, and cluster modes.
- Session management with Redis-backed store, secure cookies.
- Let's Encrypt integration with HTTP-01 and DNS-01 challenges.
- Raspberry Pi detection for resource-aware tuning.
- Block page serving for blocked domains.
- ClickHouse identifier validation (`validateClickHouseIdentifier`).
- Body size limits (`express.json({ limit: '1mb' })`).
- Usage stats webhook integration.

**Current Recommendations:**

1. **`startServer` is ~160 lines** with deeply nested conditionals for Let's Encrypt, HTTPS, and HTTP startup. Consider extracting `startWithLetsEncrypt`, `startWithHttps`, `startHttp` helpers for clarity.

2. **`readMergedConfig` in startup** falls back silently on errors (line ~503: `catch (_err)`). Consider logging a warning when config parsing fails so misconfigurations are visible.

3. **Route module sizes are reasonable** (100–509 lines each). The largest is `config.js` at 509 lines, which handles config read/write/export/import/system-config. Consider splitting system config endpoints into a separate module if it grows further.

---

### 2.3 React Client

**Strengths:**

- **Page components extracted:** 10 page components covering all features.
- Centralized API client (`utils/apiClient.js`) with structured error handling.
- `ErrorBoundary` wrapping main content prevents full-app crashes.
- `useApiPolling` hook for consistent polling patterns.
- `useQueryFilters` consolidates ~20 filter-related state variables.
- `AppContext` for cross-cutting concerns (theme, refresh interval).
- Comprehensive component library (StatCard, DonutChart, FilterInput, DomainEditor, etc.).
- Component tests for LoginPage, DomainEditor, FilterInput.

**Current Recommendations:**

1. **`App.jsx` at 2,782 lines with 142 `useState` calls remains the primary architectural concern.** While page components are extracted, App.jsx still owns all state and passes it as props. The page components are essentially presentational wrappers rather than self-contained feature modules.

   **Recommended next step:** For each page, create a custom hook that owns the page's state and API calls:
   ```
   hooks/useBlocklistState.js  → owns blocklistSources, allowlist, denylist, etc.
   hooks/useUpstreamState.js   → owns upstreams, resolverStrategy, timeout, etc.
   hooks/useSyncState.js       → owns syncStatus, tokens, settings, etc.
   hooks/useSettingsState.js   → owns systemConfig, password, etc.
   ```
   Each page imports its own hook, eliminating the need for App.jsx to manage that state. App.jsx shrinks to a routing shell with sidebar navigation.

2. **`SettingsPage.jsx` is 1,087 lines** — the largest page component. It handles cache config, logging, query store, client identification, client groups, password management, and config import/export. Consider splitting into sub-components (e.g., `CacheSettings`, `LoggingSettings`, `AuthSettings`, `ImportExport`).

3. **`IntegrationsPage.jsx` at 651 lines** handles all webhook configuration. This is manageable but could benefit from a `WebhookForm` sub-component to reduce repetition between onBlock and onError webhook forms.

4. **No loading skeletons for most data sections.** The `Skeleton` component exists but is underutilized. Many sections show nothing while loading, then pop in. Use `SkeletonCard` consistently for better perceived performance.

5. **Polling intervals remain hardcoded.** Consider adding `document.visibilityState` detection to pause or reduce polling when the tab is hidden, reducing unnecessary API calls.

---

### 2.4 Component Library

Well-designed reusable components:

| Component | Purpose | Test Coverage |
|-----------|---------|---------------|
| `StatCard` | Metric display with tooltips | — |
| `DonutChart` | Response distribution visualization | — |
| `FilterInput` | Search/filter with debounce | **Yes** (4 tests) |
| `DomainEditor` | Textarea for domain list editing | **Yes** (6 tests) |
| `CollapsibleSection` | Expandable content sections | — |
| `ConfirmDialog` | Destructive action confirmation | — |
| `ConfigViewer` | YAML config display | — |
| `Tooltip` | Info tooltips | — |
| `AppLogo` | Branding | — |
| `ErrorBoundary` | Runtime error containment | — |
| `Skeleton` | Loading placeholder | — |

**Current Recommendation:**

1. **Extract reusable Table/DataGrid component.** Tables are used in queries, errors, clients, and sync pages with similar patterns (sortable headers, pagination, loading state). A shared component would reduce duplication.

---

### 2.5 State Management

**Current approach:**

- **AppContext** for theme, refresh interval, sync status — reduces prop drilling.
- **useQueryFilters** consolidates query filter state with URL synchronization.
- **ToastContext** for notifications.
- **App.jsx** owns all remaining state (142 `useState` calls) and passes as props to pages.

**Assessment:** The Context and hook infrastructure is solid. The remaining work is migrating feature state from App.jsx into per-feature hooks, as described in §2.3 recommendation #1.

---

### 2.6 Security (UI)

**Strengths:**

- Password hashed with bcrypt (cost 10).
- Session cookie: httpOnly, sameSite=lax, secure when HTTPS.
- Auth middleware protects all `/api` routes.
- Session regeneration after login (prevents session fixation).
- Login rate limiting (10 attempts per 15 min).
- Body size limits (1MB).
- Password change requires current password verification.
- Initial password setup rate-limited and documented.

**Current Recommendations:**

1. **No CSRF token.** `sameSite=lax` mitigates most CSRF vectors, but adding a CSRF token (e.g., `csurf` or custom) would provide defense-in-depth for state-changing operations.

---

### 2.7 Test Coverage (UI)

| Suite | Framework | Files | Tests |
|-------|-----------|-------|-------|
| Server API | `node:test` | `web/server/test/app.test.js` | 50 tests |
| Client utils | Vitest | 4 files (`validation`, `format`, `queryParams`, `blocklist`) | 73 tests |
| Client components | Vitest + Testing Library | 3 files (`LoginPage`, `DomainEditor`, `FilterInput`) | 15 tests |
| **Total** | | **8 files** | **138 tests** |

**Current Recommendations:**

1. **Add component tests for page components.** Key user flows that should be tested: overview stats rendering, blocklist form submission, upstream config editing, sync token management.

2. **Server tests require `npm install` first** — the test file imports from `../src/index.js` which depends on `express`. CI handles this, but the dependency should be noted for local development.

---

## Summary of Priority Recommendations

### All Previous High/Medium/Low Priority Items: **Resolved** (20/20)

All 20 items from previous reviews have been addressed. See the history table below for reference.

### New Findings (This Review — 2026-02-22)

#### Correctness

| # | Area | Issue | Effort | Status |
|---|------|-------|--------|--------|
| N1 | Backend | **`cmd/perf-tester` `runStats` passed by value** — `go vet` reports lock copy. `runBenchmark` returns `runStats` (contains `sync.Mutex`) by value; `printSummary` receives by value. | Low | **Fixed** |
| N2 | Backend | **ClickHouse identifier validation missing in Go** — Node.js validates db/table names but Go `NewClickHouseStore` does not. Add `isValidIdentifier` check. | Low | **Fixed** |

#### Architecture / Maintainability

| # | Area | Issue | Effort | Status |
|---|------|-------|--------|--------|
| N3 | UI Client | **`App.jsx` still 2,782 lines with 142 `useState` calls** — state ownership not yet delegated to page components. Extract per-feature hooks. | High | **Done** |
| N4 | UI Client | **`SettingsPage.jsx` at 1,087 lines** — largest page component. Split into sub-components (CacheSettings, LoggingSettings, AuthSettings). | Medium | **Done** |
| N5 | Backend | **Upstream config parsing duplicated** in `New()` and `ApplyUpstreamConfig()`. Extract `parseUpstream()` and `resolveNetworkConfig()` helpers. | Low | **Done** |

#### Performance / Polish

| # | Area | Issue | Effort | Status |
|---|------|-------|--------|--------|
| N6 | Cache | **`msg.Copy()` on `LRUCache.Get`** — defensive copy may be unnecessary if callers don't mutate. Profile and document contract. | Low | **Done** |
| N7 | UI Client | **Loading skeletons underutilized** — `Skeleton` component exists but most pages show nothing while loading. | Medium | **Done** |
| N8 | UI Client | **Polling continues when tab is hidden** — add `document.visibilityState` detection. | Low | **Done** |

---

### Historical Resolution Summary

All items from the original review and subsequent priority phases have been resolved:

| Phase | Items | Resolved |
|-------|-------|----------|
| High Priority (Correctness/Security) | 5 | 5/5 |
| Medium Priority (Maintainability) | 5 | 5/5 |
| Low Priority (Performance/Polish) | 5 | 5/5 |
| Critical Issues Review | 5 | 5/5 |
| Next Priorities Phase 1–5 | 25 | 24/25 (P2 `msg.Copy()` carried forward as N6) |
| **New findings (N1–N2)** | 2 | **2/2 fixed** |
| **Total** | **47** | **47 resolved, 5 open** |
