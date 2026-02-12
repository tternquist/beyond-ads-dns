# Memory Leak Investigation

This document describes potential memory leak sources that were identified and the fixes applied, plus how to profile memory for further investigation.

## Profile-Based Findings (pprof inuse_space diff)

A pprof diff profile showed the **blocklist package** as the primary contributor to memory growth:

- **~133MB** net allocation from `ApplyConfig` (triggered by `/blocklists/reload` HTTP handler)
- **~28MB** retained in `bufio.Scanner.Text` from domain parsing
- **~1.66MB** from bloom filter creation

Conclusion: Repeated calls to `/blocklists/reload` (e.g. without config changes) caused full blocklist reloads, each allocating ~100MB+.

## Fixes Applied

### 1. L0 (In-Memory LRU) Cache - Expired Entry Cleanup

**Problem:** `CleanExpired()` was never called on the LRU cache. Expired entries accumulated until evicted by new entries, wasting memory on stale DNS responses that were never served.

**Fix:** The sweep refresh (runs every 15s) now calls `CleanLRUCache()` to remove expired entries from the L0 cache.

### 2. ClickHouse HTTP Response Body Drain

**Problem:** On successful insert responses, the response body was never read. The HTTP client cannot reuse connections until the body is fully consumed, causing connection accumulation and memory growth over time.

**Fix:** Added `io.Copy(io.Discard, resp.Body)` for successful responses to drain the body and allow connection reuse.

### 3. Redis Cache Keys Never Expiring

**Problem:** Cache keys used `Persist()` to remove TTL, so they never expired. Keys that weren't refreshed (cold keys) stayed in Redis indefinitely, causing unbounded memory growth on the Redis server.

**Fix:**
- Use `Expire()` instead of `Persist()` with TTL = soft_expiry + grace period
- When the sweep skips a key (sweepMinHits not met), call `DeleteCacheKey()` to remove it from Redis and the index
- Added `DeleteCacheKey()` method that removes from expiry index, deletes the key, and evicts from L0

### 4. Blocklist ApplyConfig - Skip When Unchanged (pprof-identified)

**Problem:** Every POST to `/blocklists/reload` triggered a full blocklist reload (~100MB+ alloc), even when the config hadn't changed. The pprof diff showed ApplyConfig as the dominant allocation path.

**Fix:** Compare incoming config with last applied config; skip `LoadOnce` when identical.

### 5. Blocklist Parser - Reduce Allocations

**Problem:** Parser used unbounded scanner buffer (1MB max) and an empty map that reallocated as it grew.

**Fix:** Pre-size map to 500K entries; reduce max line size to 1KB (domains are max 253 chars); shrink initial scanner buffer.

## Profiling Memory

A `/debug/pprof/` endpoint is exposed on the control server (same port as `/metrics`) for memory and goroutine profiling.

### Heap Profile (memory allocation snapshot)

```bash
# Download current heap profile
curl -o heap.pprof "http://localhost:8081/debug/pprof/heap"

# Analyze with go tool (shows allocation hot spots)
go tool pprof -http=:8080 heap.pprof
```

### Heap Diff (allocation growth over time)

```bash
# Take baseline
curl -o heap1.pprof "http://localhost:8081/debug/pprof/heap"

# Wait 5-10 minutes, take second snapshot
curl -o heap2.pprof "http://localhost:8081/debug/pprof/heap"

# Compare (shows what grew)
go tool pprof -base=heap1.pprof -http=:8080 heap2.pprof
```

### Goroutine Profile (detect goroutine leaks)

```bash
curl -o goroutines.pprof "http://localhost:8081/debug/pprof/goroutine"
go tool pprof -http=:8080 goroutines.pprof
```

### Alloc Profile (cumulative allocation over time)

```bash
# 30-second CPU profile (includes allocation sampling)
curl -o alloc.pprof "http://localhost:8081/debug/pprof/allocs?seconds=30"
go tool pprof -http=:8080 alloc.pprof
```

**Note:** Ensure the control server is not exposed to the public internet, as pprof can expose sensitive runtime information.
