# Mock Cache Interface - Code Coverage Review

## Executive Summary

The `DNSCache` interface in `internal/cache/interface.go` was designed to enable testing with mock implementations, but **no mock cache is currently used in resolver tests**. All resolver tests pass `nil` for the cache client, which means **cache-related code paths are largely untested**. Introducing a mock cache implementation would significantly improve coverage of the resolver's cache logic.

## Current State

### DNSCache Interface

The interface is well-defined in `internal/cache/interface.go`:

```go
type DNSCache interface {
    Get, GetWithTTL, Set, SetWithIndex
    IncrementHit, GetHitCount, IncrementSweepHit, GetSweepHitCount
    FlushHitBatcher
    TryAcquireRefresh, ReleaseRefresh
    ExpiryCandidates, RemoveFromIndex, DeleteCacheKey
    Exists, ClearCache, GetCacheStats, Close, CleanLRUCache
}
```

### Resolver Test Setup

In `internal/dnsresolver/resolver_test.go`, `buildTestResolver` is called with `nil` for the cache:

```go
func buildTestResolver(t *testing.T, cfg config.Config, cacheClient cache.DNSCache, ...) *Resolver {
    return New(cfg, cacheClient, ...)  // cacheClient is always nil in current tests
}
```

All existing tests (TestResolverBlockedQuery, TestResolverLocalRecord, TestResolverDoHUpstream, etc.) pass `nil` via `buildTestResolver(t, cfg, nil, blMgr, nil)`.

### Coverage Impact

| Function | Coverage | Cache-Dependent |
|----------|----------|-----------------|
| ServeDNS | 33.6% | Yes - cache hit/miss paths skipped when cache is nil |
| maybeRefresh | 0% | Yes - requires cache |
| scheduleRefresh | 0% | Yes - requires cache |
| StartRefreshSweeper | 0% | Yes - requires cache |
| sweepRefresh | 0% | Yes - requires cache |
| CacheStats | 0% | Yes - delegates to cache |
| ClearCache | 0% | Yes - delegates to cache |
| RefreshStats | 0% | Yes - refresh stats from sweeper |
| cacheSet | 66.7% | Partial - nil check covered |
| refreshCache | 56.0% | Partial - exchange path covered |

**Overall dnsresolver coverage: 33.3%**

## Opportunities for Better Coverage

### 1. Create a Mock DNSCache Implementation

Add `internal/cache/mock.go` (or `internal/dnsresolver/cache_mock_test.go`) with an in-memory implementation that:

- **Stores** Get/Set data in a `map[string]*dns.Msg` with TTL tracking
- **Implements** all DNSCache methods with sensible defaults
- **Supports** configurable behavior for testing:
  - Return errors from Get/Set for error-path testing
  - Pre-populate cache for hit-path testing
  - Track ExpiryCandidates for sweep testing
  - Return configurable hit/sweep counts for refresh logic

### 2. Cache Hit Path (ServeDNS)

**Current:** When `r.cache != nil`, the resolver calls `GetWithTTL`, and on hit serves the cached response, increments hit counters, and may schedule refresh.

**Test opportunity:** Use mock cache with pre-populated entry → verify:
- Cached response is returned to client
- `IncrementHit` / `IncrementSweepHit` are called (mock can assert)
- `maybeRefresh` / `scheduleRefresh` logic when hits exceed threshold

### 3. Cache Miss Path (ServeDNS)

**Current:** On miss, resolver fetches from upstream, writes to client, then caches in background via `cacheSet`.

**Test opportunity:** Use mock cache (empty) → verify:
- Upstream response is returned
- `SetWithIndex` is called with correct key/msg/ttl
- Sweep hit count remains 0 after the initial miss (sweep hits start at 0; only cache hits increment it)

### 4. Cache Get Failure

**Current:** `if err != nil { r.logf("cache get failed: %v", err) }` - error path is never exercised.

**Test opportunity:** Mock that returns error from `GetWithTTL` → verify resolver falls through to upstream exchange.

### 5. Cache Set Failure

**Current:** Background goroutine logs "cache set failed" but test never triggers it.

**Test opportunity:** Mock that returns error from `SetWithIndex` → verify error is logged (may need to capture log output).

### 6. Refresh Logic (maybeRefresh, scheduleRefresh)

**Current:** 0% coverage. These are called from ServeDNS cache-hit path when:
- `maybeRefresh`: ttl within threshold, hits >= hotThreshold
- `scheduleRefresh`: stale entry within serve_stale window

**Test opportunity:** Mock cache with:
- `GetWithTTL` returning cached msg with short TTL
- `IncrementHit` returning high count (e.g., >= hotThreshold)
- Enable refresh config (hit_window, hot_threshold, min_ttl, etc.)
- Verify `refreshCache` is invoked (mock upstream, check it's called)

### 7. Refresh Sweeper (StartRefreshSweeper, sweepRefresh)

**Current:** 0% coverage. Sweeper runs periodically, calls `ExpiryCandidates`, `Exists`, `GetSweepHitCount`, `DeleteCacheKey`, `scheduleRefresh`.

**Test opportunity:** Mock cache with:
- `ExpiryCandidates` returning test keys
- `Exists` / `GetSweepHitCount` returning configurable values
- Start sweeper with short interval, verify sweep logic
- Test cold key deletion (sweepHits < sweep_min_hits)
- Test refresh scheduling for warm keys

### 8. CacheStats, ClearCache, RefreshStats

**Current:** 0% coverage. Used by control server handlers.

**Test opportunity:** Resolver with mock cache:
- `CacheStats()` → mock returns CacheStats, verify resolver passes through
- `ClearCache(ctx)` → verify mock's ClearCache is called
- `RefreshStats()` → requires refresh stats to be populated (run sweeper or record manually)

### 9. Control Server Cache Handlers

**Current:** `handleCacheStats`, `handleCacheClear`, `handleCacheRefreshStats` call resolver methods. Control server tests may not cover these with a real resolver.

**Test opportunity:** Integration test or handler test with resolver + mock cache to verify HTTP responses.

## Recommended Implementation Order

1. **Create MockCache** in `internal/cache/mock.go`:
   - In-memory map for Get/Set/GetWithTTL
   - In-memory structures for hit counts, sweep hits, expiry index
   - TryAcquireRefresh/ReleaseRefresh (in-memory lock map)
   - ExpiryCandidates from in-memory index
   - All methods implemented, no-op where appropriate

2. **Resolver tests with mock cache:**
   - `TestResolverCacheHit` - pre-populate mock, query, verify cached response
   - `TestResolverCacheMissThenHit` - query (miss), query again (hit from mock)
   - `TestResolverCacheGetError` - mock returns error, verify upstream fallback
   - `TestResolverCacheSetError` - mock SetWithIndex returns error
   - `TestResolverRefreshScheduled` - enable refresh, high hit count, verify refresh path
   - `TestResolverCacheStats` - verify CacheStats returns mock stats
   - `TestResolverClearCache` - verify ClearCache calls mock

3. **Sweeper tests** (optional, more complex):
   - `TestStartRefreshSweeper` - start with ctx, short interval, mock with ExpiryCandidates
   - `TestSweepRefreshColdKeyDeletion` - sweep_min_hits, cold key deleted
   - `TestSweepRefreshWarmKeyRefreshed` - warm key triggers scheduleRefresh

## Mock Cache Design Notes

- **Thread safety:** Resolver uses cache from multiple goroutines (ServeDNS, background refresh, sweeper). Mock must be concurrent-safe.
- **Expiry index:** Mock needs a structure equivalent to Redis ZSET for ExpiryCandidates (key → soft_expiry).
- **Hit batcher:** Redis uses async batcher; mock can implement synchronously or no-op FlushHitBatcher.
- **Test isolation:** Each test should create a fresh MockCache to avoid cross-test pollution.

## Alternative: Use miniredis

The project already uses `miniredis` in `internal/cache/redis_test.go`. An alternative is to use `NewRedisCache` with miniredis in resolver tests instead of a custom mock. Pros: exercises real Redis code path. Cons: heavier, slower, more setup; doesn't easily support error injection (e.g., "return error from Get").

For **maximum coverage with error-path testing**, a custom mock is preferable. For **integration-style coverage** of the happy path, miniredis is sufficient.

## Summary

| Area | Current | With Mock Cache |
|------|---------|-----------------|
| Cache hit path | Untested | Fully testable |
| Cache miss + set | Untested | Fully testable |
| Cache error paths | Untested | Testable via mock error injection |
| Refresh logic | 0% | Testable |
| Sweeper logic | 0% | Testable |
| CacheStats/ClearCache | 0% | Testable |
| Estimated resolver coverage | 33% | 50–60%+ |

The mock cache interface was designed for exactly this purpose. Implementing a `MockCache` and wiring it into resolver tests would unlock coverage of a significant portion of the resolver's cache-related logic.
