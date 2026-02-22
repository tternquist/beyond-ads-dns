# Code Review: Next Priorities

This document plans the next development priorities based on the [code-review.md](./code-review.md) analysis.

**Last updated:** 2026-02-22

---

## Status Summary

All 25 items from the original priority phases have been completed (24 done + 1 carried forward to new findings). The focus now shifts to new findings from the 2026-02-22 fresh review.

---

## Current Priorities (From 2026-02-22 Review)

### Correctness

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| N1 | Backend | **`cmd/perf-tester` `runStats` passed by value** — `go vet` flag: lock copy. | Low | Correctness | **Done** |
| N2 | Backend | **ClickHouse identifier validation missing in Go** — Node.js validates but Go does not. | Low | Defense in depth | **Done** |

### Architecture / Maintainability

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| N3 | UI Client | **`App.jsx` at 2,782 lines with 142 `useState` calls** — delegate state to per-feature hooks. | High | Maintainability | **Done** |
| N4 | UI Client | **`SettingsPage.jsx` at 1,087 lines** — split into sub-components. | Medium | Readability | Pending |
| N5 | Backend | **Upstream config parsing duplicated** in `New()` and `ApplyUpstreamConfig()`. | Low | DRY | Pending |

### Performance / Polish

| # | Area | Issue | Effort | Impact | Status |
|---|------|-------|--------|--------|--------|
| N6 | Cache | **`msg.Copy()` on `LRUCache.Get`** — profile whether callers mutate; skip if safe. | Low | Allocation reduction | Pending |
| N7 | UI Client | **Loading skeletons underutilized** — `Skeleton` component exists but not used in most pages. | Medium | UX polish | Pending |
| N8 | UI Client | **Polling continues when tab hidden** — add `document.visibilityState`. | Low | Resource efficiency | Pending |

---

## Recommended Execution Order

1. **N2** (Low effort, defense in depth)
2. **N5** (Low effort, reduces code duplication)
3. **N6** (Low effort, performance win if copy is unnecessary)
4. **N8** (Low effort, resource efficiency)
5. **N4** (Medium effort, improves SettingsPage readability)
6. **N7** (Medium effort, UX improvement)
7. **N3** (High effort, most impactful architecture improvement remaining)

---

## Completed Phases (Historical)

### Phase 1: Low Priority (Original Summary)

| # | Issue | Status |
|---|-------|--------|
| 11 | Cache `countKeysByPrefix` result | **Done** |
| 12 | Reduce `enforceMaxSize` frequency | **Done** |
| 14 | `AbortController` for fetch cleanup | **Done** |

### Phase 2: Security & Correctness

| # | Issue | Status |
|---|-------|--------|
| S1 | Rate limit control endpoints | **Done** |
| S2 | Gate `handleBlockedCheck` behind auth | **Done** |
| S3 | Validate sync stats payload | **Done** |
| S4 | Protect `/api/auth/set-password` | **Done** |
| S5 | Validate partition in SQL | **Done** |

### Phase 3: Maintainability & Architecture

| # | Issue | Status |
|---|-------|--------|
| M1 | Extract `clientIPFromWriter` helper | **Done** |
| M2 | Copy request only on retry | **Done** |
| M3 | Group related configs (`NetworkConfig`) | **Done** |
| M4 | Dependency injection for `createApp` | **Done** |
| M5 | Document overnight family time | **Done** |

### Phase 4: Performance & Polish

| # | Issue | Status |
|---|-------|--------|
| P1 | SIEVE eviction algorithm | **Done** |
| P2 | Profile `msg.Copy()` on Get | Carried forward as N6 |
| P3 | Loading skeletons | Carried forward as N7 |
| P4 | Configurable/adaptive polling | **Done** |
| P5 | Regex timeout/complexity limit | **Done** |

### Phase 5: Test Coverage

| # | Issue | Status |
|---|-------|--------|
| T1 | Redis integration tests (miniredis) | **Done** |
| T2 | Benchmark hot paths | **Done** |
| T3 | Connection pool concurrent tests | **Done** |
| T4 | Component tests (Vitest + RTL) | **Done** |
| T5 | API integration tests | **Done** |

---

## Quick Reference: Files to Modify

| Priority | Primary Files |
|----------|---------------|
| N2 | `internal/querystore/clickhouse.go` |
| N3 | `web/client/src/App.jsx`, new hooks in `web/client/src/hooks/` |
| N4 | `web/client/src/pages/SettingsPage.jsx` |
| N5 | `internal/dnsresolver/resolver.go` |
| N6 | `internal/cache/lru.go` |
| N7 | Page components in `web/client/src/pages/` |
| N8 | `web/client/src/hooks/useApiPolling.js` or `App.jsx` |
