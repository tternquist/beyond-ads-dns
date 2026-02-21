# Code Review: Next Priorities

This document plans the next development priorities based on the [code-review.md](./code-review.md) analysis. All high and medium priority items from the summary have been **resolved**. The focus now shifts to remaining low-priority items and other actionable recommendations.

---

## Phase 1: Low Priority (From Summary Table)

These items are explicitly listed in the code review summary and should be addressed next.

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| 11 | Backend | **Cache `countKeysByPrefix` result** — SCAN is O(N) on keyspace; called on every `GetCacheStats()`. Add 30s TTL cache or use `DBSIZE` + estimation. | Medium | Performance at 100K+ keys | **Done** |
| 12 | Backend | **Reduce `enforceMaxSize` frequency** — Runs on every 5s flush. Check every Nth flush or only when near limit. | Low | Reduces ClickHouse query load | **Done** |
| 14 | UI Client | **Use `AbortController` for fetch cleanup** — Cancel in-flight requests on unmount instead of ignoring response. Integrate into `apiClient.js`. | Medium | Prevents memory leaks, stale updates | **Done** |

---

## Phase 2: Security & Correctness

Items that improve security or prevent potential bugs.

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| S1 | Control API | **Rate limit control endpoints** — `/blocklists/reload` triggers full download+parse; unauthenticated spam could cause CPU/memory spikes. | Low | DoS mitigation | **Done** |
| S2 | Control API | **Gate `handleBlockedCheck` behind auth** — Currently leaks blocklist info to any client. | Low | Information disclosure | **Done** |
| S3 | Control API | **Validate sync stats payload** — `handleSyncStats` accepts arbitrary JSON; malicious replica could exhaust memory. Add size/structural validation. | Medium | Memory exhaustion | **Done** |
| S4 | UI Server | **Protect `/api/auth/set-password`** — When no password configured, any client can set it. Consider setup token or physical access confirmation. | Medium | Initial setup security | Pending |
| S5 | Query Store | **Parameterize/validate partition in SQL** — `DROP PARTITION '%s'` interpolates ClickHouse response; validate format or use parameterized queries. | Medium | Defense in depth | **Done** |

---

## Phase 3: Maintainability & Architecture

Improves code structure and long-term maintainability.

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| M1 | Resolver | **Extract `clientIPFromWriter` helper** — Duplicated in ServeDNS, isBlockedForClient, logRequestWithBreakdown, fireErrorWebhook. | Low | DRY, readability | **Done** |
| M2 | Resolver | **Copy request only on retry** — `exchange()` uses `req.Copy()` on first attempt; skip if success (majority case). | Low | Allocation reduction | **Done** |
| M3 | Config | **Group related configs** — `NetworkConfig` for upstream_timeout/backoff/conn_pool. Config struct has 30+ fields. | Medium | Readability |
| M4 | Node Server | **Dependency injection for `createApp`** — Route handlers close over many vars; use `app.locals` or context object for testability. | High | Testability |
| M5 | Config | **Document overnight family time** — `validateTimeWindow` rejects start > end; document that 22:00–06:00 fails (or fix if unintended). | Low | UX clarity |

---

## Phase 4: Performance & Polish

Optimizations and UX improvements.

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| P1 | Cache | **Consider CLOCK/SIEVE eviction** — LRU `MoveToFront` requires exclusive lock on every read; alternative algorithms allow lock-free reads. | High | High QPS optimization | **Done** |
| P2 | Cache | **Profile `msg.Copy()` on Get** — If callers never mutate, skip defensive copy with documented contract. | Low | Allocation reduction | Pending |
| P3 | UI Client | **Loading skeletons** — Many sections show nothing while loading; use `SkeletonCard` consistently. | Medium | UX polish | Pending |
| P4 | UI Client | **Configurable/adaptive polling** — Hardcoded intervals; consider `document.visibilityState` to reduce when tab hidden. | Medium | Resource efficiency | **Done** |
| P5 | Blocklist | **Regex timeout/complexity limit** — Pathological regex could cause catastrophic backtracking in `IsBlocked`. | Medium | DoS prevention | **Done** |

---

## Phase 5: Test Coverage

Strengthen test coverage per code review recommendations.

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| T1 | Backend | **Redis integration tests** — Use miniredis for real pipeline/transaction logic; catch CROSSSLOT bugs. | Medium | Regression prevention | Existing |
| T2 | Backend | **Benchmark hot paths** — `IsBlocked`, `GetWithTTL`, `ServeDNS` cached response. Enable CI regression detection. | Medium | Performance regression | **Done** |
| T3 | Backend | **Connection pool concurrent tests** — Verify retry-on-EOF, idle timeout, concurrent access. | Low | Correctness | Pending |
| T4 | UI | **Component tests** — Vitest + React Testing Library for login, blocklist editing, query filtering. | High | Regression prevention | Pending |
| T5 | UI | **API integration tests** — Supertest for auth flows, config CRUD, error cases. | Medium | Regression prevention | Pending |

---

## Recommended Execution Order

1. **Phase 1 (Low Priority)** — Quick wins from the summary table; establishes momentum.
2. **Phase 2 (Security)** — S1, S2, S3 are low/medium effort with meaningful impact.
3. **Phase 3 (Maintainability)** — M1, M2, M5 are low-effort; M3, M4 are larger refactors.
4. **Phase 4 (Performance)** — P2, P5 are low/medium; P1 is a larger change.
5. **Phase 5 (Tests)** — T2, T3 first (backend); T4, T5 as capacity allows.

---

## Quick Reference: Files to Modify

| Priority | Primary Files |
|----------|---------------|
| #11 | `internal/cache/redis.go`, `web/server/src/services/redis.js` (both have countKeysByPrefix) |
| #12 | `internal/querystore/clickhouse.go` |
| #14 | `web/client/src/utils/apiClient.js`, page components with useEffect+fetch |
| S1–S3 | `internal/control/server.go` |
| S5 | `internal/querystore/clickhouse.go` |
| M1, M2 | `internal/dnsresolver/resolver.go` |

---

*Last updated: Based on code-review.md state as of branch `cursor/code-review-next-priorities-254e`*
