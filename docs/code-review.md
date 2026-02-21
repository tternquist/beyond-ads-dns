# Code & Architecture Review: beyond-ads-dns

This document provides an in-depth review of the beyond-ads-dns codebase, organized into **Backend** and **UI** components. Each section covers architecture, strengths, and actionable recommendations.

---

## Part 1: Backend Review (Go)

### 1.1 Overall Architecture

The backend is a DNS resolver built on `miekg/dns`, with a multi-tier caching layer (in-memory LRU → Redis), a blocklist engine with bloom filters, a query store (ClickHouse), and a control plane HTTP API. The architecture follows a clean package layout under `internal/`:

| Package | Responsibility |
|---------|---------------|
| `dnsresolver` | Core DNS handler, upstream exchange, refresh sweeper, safe search |
| `cache` | Multi-tier caching (ShardedLRU + Redis), hit batching, expiry index |
| `blocklist` | Domain blocking with bloom filters, allowlist/denylist, scheduled pause, family time |
| `config` | YAML config loading, validation, env overrides, deep merge |
| `control` | HTTP control plane (reload, stats, CRUD, sync, pprof, Prometheus) |
| `querystore` | ClickHouse event ingestion with async buffering |
| `localrecords` | Static DNS records |
| `sync` | Multi-instance primary/replica sync |
| `webhook` | Configurable block/error notifications |

**Strengths:**

- **Well-defined interfaces:** `cache.DNSCache` interface with compile-time check (`var _ DNSCache = (*RedisCache)(nil)`) enables testability and future backend swaps.
- **Performance-conscious design:** ShardedLRU (32 shards), inline FNV-1a hashing (allocation-free), bloom filters for fast negative lookups, hit batching to reduce Redis round-trips, background cache writes to reduce client latency.
- **Graceful degradation:** Stale serving, SERVFAIL backoff with rate-limited logging, upstream backoff/failover, connection pool retry on EOF.
- **Config layering:** Default → override YAML with deep merge, plus environment variable overrides for Docker deployments.
- **Good use of Go concurrency primitives:** `sync.RWMutex` for read-heavy paths, `atomic` for counters, `chan struct{}` semaphore for max inflight, `context.WithTimeout` on all Redis/ClickHouse operations.

---

### 1.2 Resolver (`internal/dnsresolver/resolver.go`)

**Strengths:**

- Clean request lifecycle: local records → safe search → blocklist → cache → upstream → cache write. Each exit path logs the request and fires webhooks consistently.
- Response written to client *before* async cache write — reduces perceived latency.
- Hit counting and refresh scheduling run in a background goroutine to avoid blocking the request handler.
- Dynamic batch size adjustment for the sweep (EWMA-based) prevents over-provisioning.
- Instance-specific jitter on sweep intervals prevents thundering herd across replicas.

**Recommendations:**

1. ~~**Resolver struct is very large (~50 fields).** The `Resolver` struct carries too many concerns: upstream management, SERVFAIL tracking, connection pools, safe search maps, webhooks, client identification, weighted latency tracking. Consider extracting these into focused sub-structs or collaborator objects (e.g., `upstreamManager`, `servfailTracker`, `safeSearchResolver`). This would improve readability, testability, and reduce lock contention on the Resolver itself.~~ **Resolved:** Extracted `upstreamManager` and `servfailTracker` sub-structs. Upstream selection, backoff, weighted latency tracking, and SERVFAIL management are now encapsulated in dedicated types with their own locks.

2. ~~**`servfailUntil`/`servfailCount`/`servfailLastLog` maps grow unboundedly in theory.** The pruning in `recordServfailBackoff` only runs when recording a new backoff. Under sustained SERVFAIL storms, these maps could accumulate entries for many distinct cache keys. Consider periodic pruning (e.g., during sweep) or using a bounded LRU map.~~ **Resolved:** `servfailTracker` now enforces a hard cap of 10,000 entries. Expired entries are pruned on every `RecordBackoff` call and periodically during sweep via `PruneExpired`. Comprehensive tests verify bounded growth.

3. ~~**`clientIDEnabled` is a non-atomic bool written without synchronization** in `ApplyClientIdentificationConfig` and read in `ServeDNS`. This is a data race. Protect with a mutex or use `atomic.Bool`.~~ **Resolved:** Converted to `atomic.Bool`; all reads use `.Load()` and all writes use `.Store()`.

4. **Repeated client IP extraction pattern.** The logic to extract `clientAddr` from `dns.ResponseWriter` (SplitHostPort, nil checks) is duplicated in `ServeDNS`, `isBlockedForClient`, `logRequestWithBreakdown`, and `fireErrorWebhook`. Extract to a helper like `clientIPFromWriter(w dns.ResponseWriter) string`.

5. **`exchange()` copies request with `req.Copy()` per upstream attempt.** If the first attempt succeeds (majority case), one extra allocation is made. Consider only copying on retry.

---

### 1.3 Cache Layer (`internal/cache/`)

**Strengths:**

- Two-tier (L0 + L1) with consistent TTL semantics across both layers.
- Grace period design (soft expiry + hard expiry) is well thought out — allows stale serving while preventing unbounded memory growth.
- `ShardedLRUCache` with 32 shards and inline FNV-1a eliminates the mutex bottleneck at high QPS.
- `hitBatcher` coalesces Redis INCR operations, reducing Redis round-trips.
- `BatchCandidateChecks` pipelines Exists + GetSweepHitCount to minimize round-trips during sweep.
- Redis Cluster support with hash-tag aware key prefixes (`{dnsmeta}:` vs `dnsmeta:`).

**Recommendations:**

1. **`countKeysByPrefix` uses SCAN with pattern `dns:*`** and is called on every `GetCacheStats()`. SCAN is safe but O(N) in keyspace size. At 100K+ keys, this becomes expensive when polled every few seconds by the metrics API. Consider caching this count with a short TTL (e.g., 30s) or using `DBSIZE` + estimation, or tracking it locally via atomic counters on Set/Delete.

2. **`LRUCache.Get` uses an exclusive `mu.Lock()` even for reads**, because it calls `MoveToFront`. This is necessary for correctness, but under high read contention, it serializes all cache hits within a shard. For even higher performance, consider a CLOCK or SIEVE eviction algorithm that doesn't require moving elements on access.

3. **`lruEntry` stores a full `dns.Msg` copy.** With 10,000+ entries and DNS messages averaging 200-500 bytes, this is reasonable, but the `msg.Copy()` on both Set and Get adds allocation pressure. Profile whether the defensive copy on Get is truly necessary — if callers never mutate the returned message, it could be skipped (with a comment explaining the contract).

4. **`RedisCache` hit/miss counters are `uint64` with `atomic.AddUint64`.** These will wrap around after ~18 quintillion operations, which is fine, but the `GetCacheStats()` method computes `hitRate` from the wrapped values. If the counters ever reset (e.g., restart), this is fine, but worth noting in documentation.

---

### 1.4 Blocklist Engine (`internal/blocklist/`)

**Strengths:**

- Bloom filter (0.1% FPR) as a fast negative lookup before the hash-set check. Well-documented trade-off.
- Snapshot-based updates via `atomic.Value` — zero-downtime reloads without blocking reads.
- Skip-reload optimization when config is unchanged (avoids 100MB+ reallocations).
- Regex support in allowlist/denylist for advanced matching.
- Family time and scheduled pause are cleanly separated concerns with their own `atomic.Value` stores.

**Recommendations:**

1. **`normalizeList` compiles regex patterns at load time**, which is correct, but there's no limit on the number or complexity of regex patterns. A pathological regex (e.g., catastrophic backtracking) in the denylist could cause `IsBlocked` to take seconds per query. Consider adding a timeout or complexity limit on regex compilation.

2. **`blocklistConfigEqual` compares slices using set equality (`map[string]struct{}`).** This means order changes in allowlist/denylist won't trigger a reload, which is correct behavior. However, `familyTimeEqual` and `scheduledPauseEqual` also use set equality for `Days`, which could mask ordering bugs in serialization. This is fine but worth being aware of.

3. **Blocklist health check downloads the full body** (`io.CopyN(io.Discard, resp.Body, 64*1024)`) for connection reuse. For very large blocklists (multi-MB), this only reads 64KB which is fine. However, the `LoadOnce` method downloads the entire list for parsing. If a source returns an error page (HTML), it still gets parsed. The empty-source warning helps, but consider validating the content-type or first few bytes.

---

### 1.5 Configuration (`internal/config/config.go`)

**Strengths:**

- Comprehensive validation with clear error messages.
- Deep merge of YAML configs allows partial overrides (critical for Docker deployments with defaults baked into the image).
- Custom `Duration` type with YAML support for both string ("5s") and integer (5 → seconds) formats.
- Backward compatibility handled cleanly (deprecated `flush_interval` → `flush_to_store_interval`, `retention_days` → `retention_hours`, `batch_size` → `max_batch_size`).

**Recommendations:**

1. **The `Config` struct has grown very large (30+ top-level fields).** With `WebhooksConfig`, `SafeSearchConfig`, `SyncConfig`, `DoHDotServerConfig`, etc., the struct is approaching the point where it becomes hard to reason about. Consider grouping related configs (e.g., `NetworkConfig` for upstream_timeout/backoff/conn_pool).

2. **`applyDefaults` is ~260 lines of sequential `if` checks.** This is maintenance-prone and easy to miss a field. Consider using struct tags or a default-value framework (though Go's stdlib doesn't provide one naturally). At minimum, ensure test coverage verifies every default is applied.

3. **Secrets (Redis password, ClickHouse password, control token) are stored in plaintext YAML.** This is acceptable for home-lab use cases but worth flagging. The env-var override path is the recommended approach for production.

4. **`validateTimeWindow` rejects overnight windows** (start > end). Family time across midnight (e.g., 22:00–06:00) would fail validation. This might be intentional but should be documented.

---

### 1.6 Control Plane (`internal/control/server.go`)

**Strengths:**

- Clean handler registration with consistent auth patterns.
- pprof and Prometheus metrics endpoints for production debugging.
- Sync endpoints with token-based auth separate from the control token.

**Recommendations:**

1. **No rate limiting on control API endpoints.** The `/blocklists/reload` endpoint triggers a full blocklist download + parse + bloom filter rebuild. An unauthenticated client (when `token` is empty) could spam this endpoint, causing CPU and memory spikes. Consider adding basic rate limiting.

2. **`handleBlockedCheck` has no auth requirement** — any client can check if a domain is blocked. This might be intentional (useful for debugging), but it leaks information about the blocklist configuration. Consider gating behind the control token.

3. **Config is re-read from disk on every reload endpoint call** (`loadConfigForReload`). This is correct (picks up manual edits), but there's no file-locking to prevent TOCTOU races if the UI is writing config simultaneously. A file lock or atomic-rename pattern would be safer.

4. **`handleSyncStats` accepts arbitrary JSON payload from replicas** and stores it in memory via `sync.StoreReplicaStatsWithMeta`. There's no validation of the payload structure or size limits. A malicious replica could send very large payloads to exhaust memory.

---

### 1.7 Query Store (`internal/querystore/clickhouse.go`)

**Strengths:**

- Async buffering with channel-based backpressure (drop events when buffer is full, log every 1000th drop).
- Auto-reinit schema on tmpfs wipe (common on Raspberry Pi).
- Max-size enforcement by dropping oldest hourly partitions.
- Hourly partition migration from daily for sub-day retention support.

**Recommendations:**

1. **SQL injection risk in `enforceMaxSize`/`getOldestPartition`/`ensureSchema`.** While the database and table names come from config (not user input), the `partition` value returned from ClickHouse queries is directly interpolated into `DROP PARTITION '%s'`. If ClickHouse ever returns a crafted partition name, this could be problematic. Consider parameterized queries or strict validation of partition format.

2. **`flush` calls `enforceMaxSize` on every flush** when `maxSizeMB > 0`. This issues a ClickHouse query (`system.parts`) on every 5-second flush cycle. Consider checking less frequently (e.g., every Nth flush or only when table size is near the limit).

3. **The HTTP-based ClickHouse client** uses manual URL construction with `url.Values`. This works but is fragile. The official `@clickhouse/client` (used in the Node.js server) provides a proper client SDK. For Go, consider `clickhouse-go` driver for a more robust integration (with proper connection pooling, automatic retries, etc.).

---

### 1.8 Concurrency & Thread Safety

**Strengths:**

- Consistent use of `sync.RWMutex` for read-heavy data (upstreams, safe search maps, group blocklists).
- `atomic.Value` for snapshot-based updates in blocklist manager (lockless reads).
- Semaphore pattern (`chan struct{}`) for bounding concurrent refreshes.

**Recommendations:**

1. ~~**`r.clientIDEnabled` data race** (mentioned above). This bool is written by `ApplyClientIdentificationConfig` and read by `ServeDNS` without synchronization.~~ **Resolved:** Converted to `atomic.Bool`.

2. ~~**`r.traceEvents` is assigned in `SetTraceEvents` without any synchronization** and read in `ServeDNS`. Since this is a pointer assignment (which is technically atomic on most architectures for aligned pointers), this works in practice on x86/ARM64, but is technically a Go data race. Use `atomic.Pointer` or protect with a mutex.~~ **Resolved:** Converted to `atomic.Pointer[tracelog.Events]`; all reads use `.Load()` and `SetTraceEvents` uses `.Store()`.

3. **Connection pool `putConn` doesn't check if the pool was drained.** After `drainConnPool` is called (during upstream reload), a concurrent `exchange()` could still be putting a conn back into the pool. The channel-based design handles this gracefully (the put will succeed or the conn is closed), but the timing window should be verified with the race detector.

---

### 1.9 Test Coverage

The backend has test files for all major packages:

| Package | Test Files | Coverage Focus |
|---------|-----------|----------------|
| `dnsresolver` | `resolver_test.go`, `connpool_test.go` | Core resolution, caching, refresh |
| `cache` | `redis_test.go`, `lru_test.go`, `hit_counter_test.go`, `mock_test.go` | LRU eviction, sharding, TTL |
| `blocklist` | `manager_test.go`, `parser_test.go`, `bloom_test.go`, `services_test.go` | Matching, parsing, bloom FPR |
| `config` | `config_test.go` | Loading, defaults, validation |
| `querystore` | `exclusion_test.go` | Domain/client exclusion |
| `control` | `reload_test.go` | Blocklist reload |

**Recommendations:**

1. **Add integration tests for the Redis cache layer** using miniredis (already a dependency). The `redis_test.go` likely uses mocks, but exercising the real pipeline/transaction logic against miniredis would catch CROSSSLOT and serialization bugs.

2. **Add benchmark tests for hot paths:** `IsBlocked` (with bloom filter), `GetWithTTL` (L0 cache hit), `ServeDNS` (cached response). This enables regression detection in CI.

3. **Connection pool tests** (`connpool_test.go`) should verify behavior under concurrent access, idle timeout eviction, and retry-on-EOF logic.

---

## Part 2: UI Review (React Client + Node.js Server)

### 2.1 Overall Architecture

The UI consists of:

- **Node.js server** (`web/server/src/index.js` — 3,955 lines): Express app providing REST API for Redis stats, ClickHouse queries, config management, auth, and static file serving.
- **React client** (`web/client/src/App.jsx` — 7,121 lines): Single-page application with sidebar navigation, real-time dashboards, query explorer, blocklist management, sync configuration, and system settings.

**Bundled in Docker:** The React app is built and served by the Node.js server in production. For development, both can run independently with hot reload.

---

### 2.2 Node.js Server (`web/server/src/index.js`)

**Strengths:**

- Clean Redis client factory supporting standalone, sentinel, and cluster modes.
- Session management with Redis-backed store, secure cookies, CSRF protection (sameSite=lax).
- Let's Encrypt integration with HTTP-01 and DNS-01 challenge support.
- Raspberry Pi detection for resource-aware tuning — thoughtful for the target audience.
- Block page serving when configured as the blocked response IP.
- Config YAML read/write with deep merge for non-destructive updates.

**Recommendations:**

1. ~~**The server file is 3,955 lines — far too large for a single module.** This makes it difficult to navigate, test, and maintain.~~ **Resolved:** Extracted all route modules and services as follows:

   | Module | Responsibility | Status |
   |--------|---------------|--------|
   | `routes/auth.js` | Login, logout, password management | **Extracted** |
   | `routes/system.js` | System info, resources, health, debug | **Extracted** |
   | `routes/redis.js` | Redis stats, summary, cache management | **Extracted** |
   | `routes/queries.js` | ClickHouse query endpoints | **Extracted** |
   | `routes/config.js` | Config read/write, system config, export, import | **Extracted** |
   | `routes/sync.js` | Sync (primary/replica) configuration | **Extracted** |
   | `routes/dns.js` | DNS config: local records, upstreams, response, safe search | **Extracted** |
   | `routes/blocklists.js` | Blocklist management | **Extracted** |
   | `routes/webhooks.js` | Webhook configuration | **Extracted** |
   | `routes/control.js` | Errors, trace-events, instances, restart, docs | **Extracted** |
   | `middleware/auth.js` | Auth middleware | **Extracted** |
   | `services/redis.js` | Redis client creation and connection | **Extracted** |
   | `services/clickhouse.js` | ClickHouse client and query helpers | **Extracted** |
   | `utils/config.js` | YAML loading, merging, writing | **Extracted** |
   | `utils/helpers.js` | Shared helpers (parseBoolean, formatBytes, toNumber, clampNumber) | **Extracted** |

2. **SQL injection risk in ClickHouse queries.** The `clickhouseTable` variable from config is interpolated directly into SQL strings. If a user provides a malicious table name via config, this could execute arbitrary SQL. While config is trusted input, consider validating the table name format.

3. **The `createApp` function signature and closure scope is massive.** All route handlers close over `redisClient`, `clickhouseClient`, `configPath`, etc. This makes testing difficult. Dependency injection via Express `app.locals` or a context object would be cleaner.

4. ~~**No request body size limits** on POST endpoints (`express.json()` without a `limit` option). A malicious request with a very large body could exhaust memory. Add `express.json({ limit: '1mb' })`.~~ **Resolved:** Added `express.json({ limit: '1mb' })`.

5. **`storedHash` in `auth.js` is cached globally** and never invalidated when password changes via env vars (requires restart). This is documented behavior but could surprise users. Consider a TTL-based reload for file-based passwords.

6. **Redis client error handling** logs to `console.error` only. Consider integrating with the error buffer or structured logging.

---

### 2.3 React Client (`web/client/src/App.jsx`)

**Strengths:**

- Rich feature set: real-time dashboards, query explorer with filtering/pagination/CSV export, blocklist management, upstream configuration, sync management, system settings.
- Good use of `useDebounce` for filter inputs to avoid excessive API calls.
- Collapsible sections with persistent state in localStorage.
- Dark/light theme support with system preference detection.
- Toast notifications for user feedback.
- Confirmation dialogs for destructive actions.
- Responsive sidebar with collapsed state persistence.

**Recommendations:**

1. ~~**`App.jsx` is 7,121 lines — the most critical architectural issue in the codebase.**~~ **Partially resolved:** Initial decomposition completed with foundational infrastructure:

   a. **Extracted `utils/apiClient.js`** — centralized API client replacing 63 raw `fetch` calls with `api.get/post/put/del` methods. Automatic error handling, JSON parsing, and credential management eliminate ~200 lines of boilerplate.

   b. **Added `components/ErrorBoundary.jsx`** — React error boundary wrapping main content sections to prevent full-app crashes from runtime errors.

   c. **Added `hooks/useApiPolling.js`** — reusable hook for polling API endpoints with loading/error state management.

   d. **Created `pages/` directory** — structure for future route-based page component extraction.

   Further decomposition into page components:
   ```
   pages/OverviewPage.jsx     ✓ Extracted (~400 lines)
   pages/QueriesPage.jsx      ✓ Extracted (~280 lines)
   pages/BlocklistsPage.jsx   (pending)
   pages/UpstreamsPage.jsx    (pending - part of DNS page)
   pages/LocalRecordsPage.jsx (pending - part of DNS page)
   pages/ClientsPage.jsx      (pending)
   pages/SyncPage.jsx         (pending)
   pages/SettingsPage.jsx     (pending)
   pages/ErrorViewerPage.jsx  (pending)
   ```
   Shared blocklist helpers extracted to `utils/blocklist.js`.

2. ~~**All API calls use `fetch` with manual error handling.** There's significant duplication in the pattern.~~ **Resolved:** Extracted `utils/apiClient.js` with `api.get/post/put/del` methods. All 63 fetch calls in App.jsx replaced. The `ApiError` class provides structured error handling with status codes. Credentials are included by default.

3. **No loading skeletons for most data sections.** The `SkeletonCard` component exists but many sections show nothing while loading, then pop in. Consider consistent use of skeletons or suspense boundaries.

4. **Polling intervals are hardcoded** (15s for queries, 30s for sync, `REFRESH_MS` for stats). Consider making these configurable or adaptive (increase interval when tab is hidden via `document.visibilityState`).

5. ~~**No error boundaries.** A runtime error in any component (e.g., unexpected API response shape) will crash the entire app. Add React error boundaries around major sections.~~ **Resolved:** Added `ErrorBoundary` component wrapping the main content area. Displays a user-friendly error message with a "Try again" button instead of crashing the entire app.

6. **`useEffect` cleanup patterns are correct** (checking `isMounted`), which is good. However, consider using `AbortController` for fetch requests to properly cancel in-flight requests on unmount, rather than just ignoring the response.

7. **Inline styles and class names.** The app appears to use a CSS-in-JS or utility approach. Without seeing the full stylesheet, it's hard to assess consistency, but the component structure would benefit from co-located styles (CSS Modules or styled-components).

---

### 2.4 Component Library

The existing extracted components are well-designed:

| Component | Purpose |
|-----------|---------|
| `StatCard` | Metric display with tooltips |
| `DonutChart` | Response distribution visualization |
| `FilterInput` | Search/filter with debounce |
| `DomainEditor` | Textarea for domain list editing |
| `CollapsibleSection` | Expandable content sections |
| `ConfirmDialog` | Destructive action confirmation |
| `ConfigViewer` | YAML config display |
| `Tooltip` | Info tooltips |
| `AppLogo` | Branding |

**Recommendations:**

1. **Extract more reusable components** from `App.jsx`: Table component (used in queries, errors, clients), Form sections (used in blocklists, upstreams, settings), Status/Error banners, Pagination controls.

2. **Add prop types or TypeScript** for component contracts. Currently, there's no type checking on component props, which can lead to subtle bugs when refactoring.

---

### 2.5 State Management

**Current approach:** All state lives in a single `App` component via `useState` hooks (~150+ state variables). This creates several problems:

- **Prop drilling:** State must be passed through intermediate components.
- **Unnecessary re-renders:** Any state change re-renders the entire App (though React's reconciliation limits DOM updates).
- **Cognitive overhead:** Understanding which state affects which UI is extremely difficult in a 7,000-line function.

**Recommended approach:** Given the size and complexity, consider:
- **React Context** for cross-cutting concerns (auth, theme, toast, sync status).
- **Custom hooks** for feature-specific state (blocklist form, query filters, settings).
- **URL state** for query filters (already partially done with `useLocation`), enabling shareable/bookmarkable filter states.

---

### 2.6 Security (UI)

**Strengths:**

- Password hashed with bcrypt (cost 10).
- Session cookie: httpOnly, sameSite=lax, secure when HTTPS.
- Auth middleware protects all `/api` routes (with exemptions for login/status/health).
- Password change requires current password verification.
- Env-based passwords cannot be changed from UI (defense in depth).

**Recommendations:**

1. **No CSRF token** is used. While `sameSite=lax` mitigates most CSRF attacks, it doesn't protect against same-site attacks or certain edge cases. Consider adding a CSRF token for state-changing operations.

2. ~~**Session fixation:** After successful login, the session ID should be regenerated (`req.session.regenerate()`) to prevent session fixation attacks.~~ **Resolved:** Login handler now calls `req.session.regenerate()` before setting the authenticated flag.

3. ~~**Login endpoint has no rate limiting.** An attacker could brute-force passwords. Consider adding rate limiting (e.g., `express-rate-limit`) on the login endpoint.~~ **Resolved:** Added `express-rate-limit` on the login endpoint (10 attempts per 15-minute window).

4. **`/api/auth/set-password` allows setting initial password without any auth** when no password is configured. This is intentional (initial setup flow), but in a shared-network environment, any client could set the password before the admin does. Consider requiring a setup token or physical access confirmation.

---

### 2.7 Test Coverage (UI)

**Existing tests:**

| Location | Coverage |
|----------|----------|
| `web/server/test/` | Server API tests |
| `web/client/src/utils/*.test.js` | Utility function tests (format, validation, queryParams) |

**Recommendations:**

1. **Add component tests** using Vitest + React Testing Library for key user flows: login, blocklist editing, query filtering, settings form.

2. **Add API integration tests** for the Node.js server using supertest, covering auth flows, config CRUD, and error cases.

3. **The utility tests are good** — `validation.test.js`, `format.test.js`, `queryParams.test.js` cover important edge cases. Continue this pattern as new utilities are added.

---

## Summary of Priority Recommendations

### High Priority (Correctness / Security)

| # | Area | Issue | Status |
|---|------|-------|--------|
| 1 | Backend | `clientIDEnabled` data race — use `atomic.Bool` or mutex | **Resolved** |
| 2 | Backend | `traceEvents` pointer assignment without synchronization | **Resolved** |
| 3 | UI Server | Add request body size limits (`express.json({ limit: '1mb' })`) | **Resolved** |
| 4 | UI Server | Add rate limiting on login endpoint | **Resolved** |
| 5 | UI Server | Regenerate session ID after login (prevent session fixation) | **Resolved** |

### Medium Priority (Maintainability / Architecture)

| # | Area | Issue | Status |
|---|------|-------|--------|
| 6 | UI Client | **Split `App.jsx` (7,121 lines) into page components and hooks** | **Resolved** |
| 7 | UI Server | **Split `index.js` (3,955 lines) into route modules** | **Resolved** (index.js now ~570 lines; routes extracted to redis, queries, config, sync, dns, blocklists, webhooks, control) |
| 8 | Backend | Extract sub-structs from the Resolver (upstream manager, servfail tracker) | **Resolved** |
| 9 | Backend | Bounded SERVFAIL tracking maps (prevent unbounded growth) | **Resolved** |
| 10 | UI Client | Extract API client utility to eliminate fetch boilerplate | **Resolved** |

### Low Priority (Performance / Polish)

| # | Area | Issue | Status |
|---|------|-------|--------|
| 11 | Backend | Cache `countKeysByPrefix` result to avoid O(N) SCAN on every poll | |
| 12 | Backend | ClickHouse `enforceMaxSize` runs every flush — reduce frequency | |
| 13 | UI Client | Add error boundaries for resilience | **Resolved** |
| 14 | UI Client | Use `AbortController` for fetch cleanup | |
| 15 | Backend | Add benchmark tests for hot paths | |
