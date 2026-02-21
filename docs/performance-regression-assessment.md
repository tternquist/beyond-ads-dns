# Performance Regression Assessment

**Date:** February 21, 2026  
**Branch:** cursor/performance-regression-assessment-decf  
**Scope:** Review of recent code changes for potential end-to-end performance regressions

## Executive Summary

After reviewing recent commits and the critical DNS query path, **no significant end-to-end performance regressions were identified**. The SIEVE eviction change (LRU → SIEVE) is a **net performance improvement** for read-heavy workloads. Several areas were assessed; findings are documented below.

---

## 1. L0 Cache: SIEVE vs LRU Eviction (Commit 6dda192)

### Change
- Replaced LRU eviction with SIEVE (NSDI '24) in the L0 cache
- **Get path:** Uses `RLock` instead of `Lock`—cache hits only set an atomic `visited` bit, no list reordering
- **Eviction:** Hand scans tail→head; evicts first unvisited entry or clears visited and advances

### Performance Impact: **Improvement**

| Scenario | Before (LRU) | After (SIEVE) |
|----------|--------------|---------------|
| Cache hit (single-threaded) | Exclusive Lock on every Get | RLock (shared) on Get |
| Cache hit (parallel) | Serialized by Lock | Scales with cores |
| Eviction on Set | O(1) remove tail | O(n) worst case when all entries visited |

**Benchmark results:**
```
BenchmarkShardedLRUCacheGet-4            245.6 ns/op
BenchmarkShardedLRUCacheGetParallel-4     146.8 ns/op  (parallel scales better)
BenchmarkLRUCacheGet-4                    156.3 ns/op
```

**Assessment:** DNS workloads are read-heavy (cache hits dominate). SIEVE improves read concurrency; eviction is infrequent and only occurs on Set when over capacity. **No regression expected.**

---

## 2. Refresh Sweeper: `last_sweep_removed_count` Tracking (Commit 8988a8f)

### Change
- Added tracking of entries removed due to `sweep_min_hits` threshold in refresh stats
- `last_sweep_removed_count` and `removed_24h` exposed in API

### Performance Impact: **Neutral**

- Increments an integer counter during sweep; no additional Redis calls or allocations
- Stats are read on API poll (e.g., every 15s from Overview page)

**Assessment:** No regression.

---

## 3. Cache Stats: LRU Stats Iteration

### Observation
`LRUCache.Stats()` iterates over all entries under RLock to compute fresh/stale/expired counts:

```go
for e := c.ll.Front(); e != nil; e = e.Next() {
    entry := e.Value.(*lruEntry)
    // classify by expiry
}
```

### Performance Impact: **Low risk**

- Called from `GetCacheStats()` which is polled by UI (e.g., 10–30s intervals)
- With 32 shards, each shard has ~312 entries (10K total / 32)
- O(n) per shard, but n is small; total work ~10K iterations
- Redis key count is cached 30s to avoid O(N) SCAN on every poll

**Assessment:** Negligible for typical polling. Only concern: very large L0 (e.g., 100K entries) with aggressive stats polling. Mitigation: stats polling is already throttled.

---

## 4. DNS Query Hot Path (ServeDNS)

### Verified Optimizations (Still in Place)

1. **Cache hit path:** Hit counting (`IncrementHit`, `IncrementSweepHit`) runs in background goroutine—does not block response
2. **Duration capture:** Total duration captured *before* async operations
3. **Write-before-cache:** On cache miss, response written to client before Redis cache write (async)
4. **Sharded hit counter:** `IncrementHit` uses local sharded cache; Redis writes batched asynchronously
5. **Blocklist:** Bloom filter + map; O(1) for non-blocked (99%+ of queries)
6. **Group blocklists:** When `len(groupBlocklists) == 0`, skips client/group resolution entirely

### Request Flow (Unchanged)

1. Local records → instant  
2. Safe search → map lookup  
3. Blocklist → Bloom + map  
4. L0 cache → ~0.02ms (SIEVE improves concurrency)  
5. L1 Redis → ~0.5–2ms  
6. Upstream → 10–50ms  

**Assessment:** No regressions in hot path.

---

## 5. SIEVE Eviction Worst Case

### Scenario
When cache is full and all entries have `visited=1`, `evictOne()` may iterate through the entire list before evicting (clearing visited bits as it goes).

### Impact
- Eviction only occurs on `Set` when `ll.Len() > maxEntries`
- Typical workload: many Gets, few Sets (new domains)
- Worst case: O(n) per eviction when all entries recently accessed
- With 32 shards, n ≈ 312 per shard

**Assessment:** Acceptable. Eviction is rare compared to reads; SIEVE read improvement outweighs eviction cost.

---

## 6. UI/Frontend Polling

### Observation
Overview and stats pages poll multiple endpoints:
- Cache stats: `refreshIntervalMs` (configurable, often 10–30s)
- Refresh stats: 15s
- Instance stats: 15s
- Queries: 15s
- etc.

### Performance Impact
- Backend handles these as HTTP requests; no impact on DNS query path
- `GetCacheStats` uses cached Redis key count (30s TTL)
- L0 `Stats()` iterates shards; cost is proportional to cache size

**Assessment:** No DNS path regression. API load is moderate.

---

## 7. Recommendations

### Monitoring
1. **Cache hit rate:** Target >95%; monitor for degradation
2. **L0 eviction rate:** If evictions spike, consider larger `lru_size`
3. **Refresh sweep stats:** High `removed_24h` may indicate many cold keys; tune `sweep_min_hits` if needed

### Validation
Run the performance benchmark suite to establish baseline:

```bash
cd tools/perf && ./benchmark.sh
```

Compare cold/warm/hot cache latency and QPS across releases.

### Future Considerations
- **L0 Stats sampling:** For very large caches (100K+), consider sampling entries for Stats() to avoid O(n) iteration on each poll
- **SIEVE hand persistence:** Current implementation persists hand across evictions; verify no pathological behavior under specific access patterns

---

## Conclusion

**No end-to-end performance regressions were identified** in the reviewed changes. The SIEVE eviction change improves read concurrency and is appropriate for DNS workloads. Other changes (sweep stats, UI) have negligible or no impact on the DNS query path.

The existing optimizations—write-before-cache, sharded hit counter, async hit counting, bloom filter—remain in place and continue to minimize client-visible latency.
