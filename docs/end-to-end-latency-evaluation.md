# End-to-End Response Latency Evaluation

This document evaluates opportunities to improve end-to-end DNS response latency in beyond-ads-dns.

## Current Architecture (Request Path)

1. **Local records** → instant (in-memory)
2. **Safe search** → instant (map lookup)
3. **Blocklist** → Bloom filter + map (O(1) for non-blocked)
4. **L0 cache** → ~10–50μs (in-memory LRU)
5. **L1 cache** → ~0.5–2ms (Redis)
6. **Upstream** → 10–50ms (network-dependent)

## Implemented Improvements

### 1. Write Response Before Cache (Upstream Miss Path) ✅

**Change:** On cache miss, write the response to the client *before* caching in Redis, then cache in a background goroutine.

**Impact:** Removes 0.5–2ms Redis write latency from the client-visible path for cache misses.

**Trade-off:** The next request for the same key may hit Redis (or upstream) if the background cache hasn't completed. This is rare—the goroutine typically finishes within milliseconds—and the current request gains the latency reduction.

### 2. Sharded Local Hit Cache ✅

**Change:** `IncrementHit` uses an in-memory sharded hit counter for immediate return; counts are written to Redis asynchronously via the batcher.

**Impact:** Eliminates "context deadline exceeded" on slow Redis (e.g. Raspberry Pi). Refresh decisions no longer block on Redis; the hot path returns immediately.

### 3. Already Optimized (No Change Needed)

- **Cache hit path:** Hit counting (`IncrementHit`, `IncrementSweepHit`) runs in a goroutine; `logRequestData` (request log, query store) runs async.
- **Duration capture:** Total duration is captured *before* async operations so metrics reflect client-visible latency.
- **Webhooks:** `FireOnBlock` and `FireOnError` use `go n.post(body)`—already non-blocking.
- **Hit batcher:** Batches Redis increments to reduce round-trips; 50ms flush interval.
- **L0 cache:** Sharded LRU reduces mutex contention at high QPS.
- **Bloom filter:** Fast negative lookups for blocklist (99%+ of queries).

## Additional Recommendations (Lower Priority)

### 4. DoH Connection Pool (Config Tuning)

**Current:** `MaxIdleConnsPerHost: 2` for the DoH HTTP client.

**Suggestion:** For DoH-heavy deployments with burst traffic to a single upstream, consider increasing to 5–10 via config. Reduces connection setup latency on repeated queries. Low impact for typical deployments (most use plain DNS or DoT).

### 5. Query Store Buffer Size

**Current:** Buffer is `max(batchSize*100, 50000)`—adequate for 100K QPS.

**Status:** No change needed. `Record()` uses non-blocking send; drops when full. No latency impact on hot path.

### 6. Upstream Timeout

**Current:** 1s for UDP/TCP, 10s for DoH.

**Status:** Keep as-is. Reducing would cause more failures on slow upstreams; latency wins would be marginal for successful queries.

### 7. L0 Population on Redis Hit

**Current:** `c.lruCache.Set()` runs synchronously when populating L0 from a Redis hit.

**Status:** ~10μs; negligible. Deferring would cause the next request to miss L0 and hit Redis again (~0.5–2ms)—not worth it.

## Summary

| Path              | Before                         | After                          |
|-------------------|--------------------------------|--------------------------------|
| L0 hit            | ~0.02ms                        | ~0.02ms (unchanged)            |
| L1 hit            | ~0.5–2ms                       | ~0.5–2ms (unchanged)           |
| Cache miss        | upstream + 0.5–2ms cache write | upstream (cache write async)   |

The main improvements are: (1) **cache miss path**—Redis write no longer blocks the client response; (2) **cache hit path**—hit counting uses a local sharded cache and returns immediately, eliminating "context deadline exceeded" on slow Redis (e.g. Raspberry Pi).
