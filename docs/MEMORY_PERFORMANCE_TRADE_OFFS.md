# Memory vs Performance Trade-off Evaluation

This document evaluates the memory optimizations applied (per `MEMORY_LEAK_INVESTIGATION.md`) and identifies which may have outsized performance impact, with recommendations for balancing memory vs performance.

## Summary: Optimizations with Potential Performance Impact

| Optimization | Memory Impact | Performance Risk | Recommendation |
|---------------|---------------|------------------|----------------|
| **Redis pool: MinIdleConns=0** | High | **Medium-High** | Consider small idle pool (e.g., 2-5) |
| **Redis pool: 8KB buffers** | High | **Low-Medium** | Consider 16KB as compromise |
| **Redis pool: PoolFIFO=true** | Medium | Low | Keep |
| **Blocklist parser: maxDomainLineLen=1KB** | Low | **Low** (data loss risk) | Verify blocklist compatibility |
| **ClickHouse: restrictive Transport** | Medium | Low | Keep; monitor under high load |

---

## Detailed Analysis

### 1. Redis Connection Pool (Fix #7) — **HIGHEST PRIORITY FOR REVIEW**

**What was changed:**
- `MinIdleConns: 0` (was 10 default) — no pre-allocated connections
- `ReadBufferSize` / `WriteBufferSize: 8192` (8KB vs 32KB default)
- `PoolFIFO: true` — FIFO eviction for idle conns
- `ConnMaxIdleTime: 5m`

**Memory saved:** ~3MB+ (32KB×2×60 conns → 8KB×2×on-demand; no idle retention)

#### Performance Impact: MinIdleConns=0

**Risk: Medium-High**

- **Cold start / burst traffic:** Every new connection requires TCP handshake + Redis AUTH. With 50 pool size and 2s `DialTimeout`, the first burst of concurrent requests may wait for connection creation.
- **Variable load:** When traffic drops, conns age out (`ConnMaxIdleTime: 5m`). When traffic spikes again, new connections must be created.
- **Observed in:** L1 (Redis) cache hits — the hot path for cache misses. Redis latency directly affects P50/P95 when L0 misses.

**Recommendation:** Consider `MinIdleConns: 2` or `MinIdleConns: 5` to keep a small warm pool. Memory cost: 2× (8KB+8KB) × 2 = 32KB–80KB, negligible vs the latency benefit for burst traffic.

#### Performance Impact: 8KB Buffers

**Risk: Low-Medium**

- **DNS cache values:** Packed DNS messages are typically 100–500 bytes. Single key/value ops fit easily in 8KB.
- **Pipelined/transactional ops:** `getHash`, `SetWithIndex`, and sweep use pipelines. Multi-key responses can be larger.
- **Redis protocol overhead:** RESP framing adds bytes. Under high throughput, smaller buffers may increase read/write syscalls.

**Recommendation:** Consider `ReadBufferSize: 16384` and `WriteBufferSize: 16384` (16KB) as a compromise. Saves ~1.5MB vs 32KB at full pool, while reducing syscall pressure under load.

---

### 2. Blocklist Parser (Fix #5)

**What was changed:**
- `maxDomainLineLen: 1024` (was 1MB)
- `initialMapCap: 500_000`
- `scanner.Buffer(..., 4096)` initial size

**Memory saved:** Reduces peak allocation during parse; avoids unbounded line growth.

#### Performance Impact: maxDomainLineLen=1024

**Risk: Low (performance), potential data correctness**

- **Domain length:** RFC 253 limits domain names to 253 chars. 1KB is well above that.
- **Blocklist formats:** Some hosts/adblock files have long lines (e.g. `127.0.0.1 domain.tld # long comment...`). Lines > 1KB would be truncated; `normalizeDomain` may produce empty/invalid output for malformed lines.
- **Impact:** Likely rare. Most blocklists use short lines. If truncation occurs, affected domains may be skipped rather than causing a crash.

**Recommendation:** Document the 1KB limit. Consider adding a metric or log for truncated lines if this becomes a concern. No urgent change needed for typical blocklists.

---

### 3. ClickHouse HTTP Transport (Fix #8)

**What was changed:**
- `MaxIdleConns: 10`, `MaxIdleConnsPerHost: 2`, `MaxConnsPerHost: 10`
- `IdleConnTimeout: 90s`

**Memory saved:** Prevents unbounded connection accumulation and associated bufio buffers.

**Performance risk: Low**

- Query store uses batched flushes (e.g. every 5s) and is not on the DNS query hot path.
- 10 conns / 2 per host is adequate for typical insert rates.
- If Insert QPS is very high, connection queueing could add latency; this would show as higher `duration_ms` for query store operations, not DNS latency.

**Recommendation:** Keep as-is. Monitor query store buffer drop rate and flush latency under high load.

---

### 4. Other Optimizations (No Significant Performance Concern)

| Fix | Change | Performance Impact |
|-----|--------|---------------------|
| L0 CleanExpired | Periodic cleanup | Negligible; reduces memory only |
| ClickHouse body drain | `io.Copy(io.Discard, resp.Body)` | Prevents leaks; no perf cost |
| Redis key expiry | Use Expire instead of Persist | Correctness; no perf cost |
| Blocklist ApplyConfig skip | Skip when unchanged | Reduces work; improves perf |
| scheduleRefresh closure | Pass `dns.Question` not `*dns.Msg` | Reduces allocations; improves perf |
| 5s timeouts on refresh Redis ops | Context timeouts | Prevents blocking; may fail refreshes under load |

---

## Suggested Configuration Adjustments

### Option A: Conservative (balance memory + performance)

```go
// internal/cache/redis.go - RedisOptions
MinIdleConns:    2,   // Small warm pool for burst traffic
ReadBufferSize:  16384,  // 16KB compromise
WriteBufferSize: 16384,
```

**Effect:** ~64KB additional memory for 2 idle conns; ~1.5MB less than 32KB buffers at full pool. Better burst and L1 latency.

### Option B: Make Redis Pool Configurable

Add config knobs so operators can tune per environment:

```yaml
cache:
  redis:
    address: "redis:6379"
    min_idle_conns: 2      # 0 = memory-optimized, 2-10 = latency-optimized
    read_buffer_size: 16384
    write_buffer_size: 16384
```

---

## Benchmarking Recommendations

To validate any changes:

1. **Cold L1 test:** Flush Redis, restart resolver, run perf-tester with warmup=0. Compare P50/P95 for L1 hits.
2. **Burst test:** Idle 10 minutes, then run high concurrency. Compare first-second latency vs steady-state.
3. **Memory profile:** After changes, confirm no regression in heap growth over 30-minute stress test.

```bash
# Example: compare before/after Redis pool tweaks
go run ./cmd/perf-tester -resolver 127.0.0.1:53 -queries 50000 -concurrency 100 -warmup 5000
```

---

## Documentation Sync

`docs/performance.md` still states "Min idle connections: 10" for Redis. The code uses `MinIdleConns: 0`. The performance doc should be updated to reflect the current memory-optimized settings and the trade-offs described above.
