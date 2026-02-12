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

### 6. scheduleRefresh Goroutine Closure (Heap-Diff Identified)

**Problem:** Refresh goroutines captured full `*dns.Msg` copies in their closures. Under stress, up to 50 concurrent goroutines retained 2–4KB+ each; slow Redis/upstream caused blocking and memory accumulation across repeated runs.

**Fix:** Pass `dns.Question` instead of `*dns.Msg`; build minimal msg in `refreshCache`. Add 5s timeouts to refresh-path Redis operations.

### 7. Redis Connection Pool Buffers (bufio.NewReaderSize ~39%)

**Problem:** `pool (*ConnPool) checkMinIdleConns` → `dialConn` → `bufio.NewReaderSize` was the largest allocation under stress. Default 32KB read+write buffers per connection × 50 pool + 10 min idle = ~3MB+ retained. Pre-allocated idle connections held buffers even when unused.

**Fix:** `MinIdleConns: 0`, `ReadBufferSize`/`WriteBufferSize: 8KB`, `PoolFIFO: true`, `ConnMaxIdleTime: 5m`.

### 8. ClickHouse HTTP Transport (Connection Accumulation)

**Problem:** Default `http.Transport` can accumulate connections under load; each connection has bufio readers.

**Fix:** Explicit `Transport` with `MaxIdleConns: 10`, `MaxIdleConnsPerHost: 2`, `MaxConnsPerHost: 10`, `IdleConnTimeout: 90s`.

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

---

## DNS Resolver Stress Test Profile Analysis

A heap profile taken before/after a stress test hitting the DNS resolver shows the following allocation hotspots. This section maps profile nodes to the codebase and assesses leak risk.

### Profile Hotspots → Code Mapping

| Profile Node | Size | Source | Leak Risk |
|--------------|------|--------|-----------|
| `dns (*Msg) Copy` | 2048.28kB (17.27%) | `internal/cache/lru.go`: `Get()` returns `entry.msg.Copy()` (line 68); `Set()` stores `msg.Copy()` (lines 92, 102) | **Low** – Copies are either served to clients (then GC'd) or stored in LRU (bounded by `maxEntries`) |
| `dns (*CNAME) copy` | 2048.09kB (17.27%) | Deep copy within `dns.Msg.Copy()` – CNAME chains are the largest RRs | **Low** – Same lifecycle as above |
| `dns UnpackDomainName` | 1536.05kB (12.95%) | `internal/cache/redis.go`: `getHash`/`getLegacy` call `msg.Unpack(data)` when deserializing from Redis | **Low** – Transient per cache miss |
| `cache (*LRUCache) Set` | 525.43kB (4.43%) | `internal/cache/lru.go`: `Set()` – stores `msg.Copy()` in L0 cache | **Low** – Bounded by `maxEntries` (default 10000); eviction + `CleanExpired` |
| `blocklist (*BloomFilter) hash` | -1024.08kB (negative) | `internal/blocklist/bloom.go`: `hash()` – allocates then releases | **None** – Negative = memory freed; healthy |
| `regexp (*bitState) reset` | 1056.33kB (8.91%) | Blocklist domain matching via regex | **Low** – Transient per domain check |

### Heap Diff: Repeated Stress Test (Memory Growth Confirmed)

A **heap diff** (baseline vs after repeated stress runs) showed memory growth that persisted across runs, confirming a leak pattern:

| Profile Node | Growth | Root Cause |
|--------------|--------|------------|
| `dnsresolver (*Resolver) scheduleRefresh func1` | **11278.21kB (68.50%)** | Goroutine closure captured full `*dns.Msg`; each refresh goroutine retained a large copy until completion |
| `dns (*Msg) Copy` | 3072.42kB (18.66%) | Copies triggered by `cache (*LRUCache) Set` and goroutine's `exchange(req)` |
| `dns UnpackDomainName` / `unpackRRslice` | ~4MB | Unpack path from `exchange` in refresh goroutines |
| `cache (*LRUCache) Set` | 525.43kB | LRU cache storing copies from refresh path |

**Root cause:** `scheduleRefresh` passed `req.Copy()` (full `*dns.Msg`) into the goroutine closure. Under load, many refresh goroutines (up to `max_inflight`=50) ran concurrently, each holding a full DNS message copy in its closure until `exchange` + `cacheSet` completed. If Redis or upstream was slow, goroutines blocked and retained memory. Accumulation across repeated runs confirmed retention.

### Fix 6: scheduleRefresh Goroutine Closure (Heap-Diff Identified)

**Problem:** The refresh goroutine captured a full `*dns.Msg` copy. Under stress, many goroutines held large messages; slow Redis/upstream caused them to block and retain memory across runs.

**Fix:**
- **Pass `dns.Question` instead of `*dns.Msg`** – The refresh only needs the question to re-query upstream. The closure now captures a small struct (~50 bytes) instead of a full message (2–4KB+).
- **Build minimal msg in `refreshCache`** – Create `msg` from `question` inside the goroutine; no large capture.
- **Add timeouts to refresh-path Redis ops** – `TryAcquireRefresh`, `ReleaseRefresh`, and `cacheSet` now use `context.WithTimeout(5s)` so goroutines cannot block indefinitely on slow Redis.

### Verdict (Post-Fix)

The initial single-snapshot profile suggested allocation pressure. The heap diff revealed true retention in `scheduleRefresh func1`. The fix reduces closure size and prevents indefinite blocking.

### Distinguishing Leak vs Allocation Pressure

A single heap snapshot shows *where* memory lives, not *growth*. To confirm a leak:

```bash
# Before stress test
curl -o heap_before.pprof "http://localhost:8081/debug/pprof/heap"

# Run stress test, then immediately after
curl -o heap_after.pprof "http://localhost:8081/debug/pprof/heap"

# Let GC run and traffic subside, then
curl -o heap_idle.pprof "http://localhost:8081/debug/pprof/heap"

# Compare: growth that persists after traffic stops = leak
go tool pprof -base=heap_before.pprof -http=:8080 heap_after.pprof
go tool pprof -base=heap_before.pprof -http=:8080 heap_idle.pprof
```

If `heap_idle` vs `heap_before` shows significant growth in `dns (*Msg) Copy`, `cache (*LRUCache) Set`, or `lruEntry`, that would indicate a leak. If growth is only in `heap_after` during load and drops after traffic stops, it's allocation pressure, not a leak.

### Recommendations to Reduce Allocation Pressure

If memory remains high under sustained load:

1. **Lower `lru_size`** – Reduce L0 cache entries if memory is constrained (e.g. 5000 instead of 10000).
2. **Tune `GOGC`** – Higher `GOGC` (e.g. 200) delays GC; lower (e.g. 50) triggers more frequent GC. Tradeoff: latency vs memory.
3. **Monitor `refreshStats.history`** – Bounded to 24h window; verify it’s pruned correctly under long runs.
4. **DNS message size** – Large CNAME chains and many A/AAAA records increase copy size; consider cache TTL and `max_entries` for memory vs hit rate.
