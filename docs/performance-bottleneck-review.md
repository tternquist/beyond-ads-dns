# Performance Bottleneck Review (Hot Cache Profile)

This document analyzes the call graph/flame graph from a hot cache scenario and provides actionable recommendations to resolve identified bottlenecks.

## Profile Summary

| Bottleneck | Time | % Total | Priority |
|------------|------|---------|----------|
| `syscall Syscall6` (UDP I/O) | 44.11s | 28.05% | Medium |
| `reflectValue` (JSON encoding) | 41.10s | 26.14% | **High** |
| `mallocgc` / memory allocation | 19.47s+ | 12.38%+ | **High** |
| `runtime futex` (lock contention) | 7.10s | 4.52% | Medium |
| `cache (*RedisCache) Get` | 7.00s | 4.47% | **High** (hot cache context) |
| `dns UnpackDomainName` | 5.83s | 3.71% | Low |
| `dns (*msg) CopyTo` | 2.93s | 1.86% | Medium |

---

## 1. Reflection-Based JSON Encoding (41s, 26% — Highest Impact)

**Root cause:** The query store (ClickHouse) and request log use `encoding/json` with `map[string]interface{}`, which triggers heavy reflection on every encode.

**Location:** `internal/querystore/clickhouse.go` (flush), `internal/requestlog/logger.go` (jsonWriter)

**Recommendations:**

1. **Replace `map[string]interface{}` with a struct** in ClickHouse flush:
   ```go
   type clickHouseRow struct {
       Ts              string  `json:"ts"`
       ClientIP        string  `json:"client_ip"`
       ClientName      string  `json:"client_name"`
       Protocol        string  `json:"protocol"`
       QName           string  `json:"qname"`
       QType           string  `json:"qtype"`
       QClass          string  `json:"qclass"`
       Outcome         string  `json:"outcome"`
       RCode           string  `json:"rcode"`
       DurationMS      float64 `json:"duration_ms"`
       CacheLookupMS   float64 `json:"cache_lookup_ms"`
       NetworkWriteMS  float64 `json:"network_write_ms"`
       UpstreamAddress string  `json:"upstream_address"`
   }
   ```
   Struct encoding avoids reflection type switches and is significantly faster.

2. **Consider `github.com/json-iterator/go`** (drop-in replacement) for 2–3× faster JSON encoding when struct changes are insufficient.

3. **Reduce query store sampling** when enabled: `query_store.sample_rate: 0.1` cuts JSON encoding load by 90% at high QPS.

4. **Request log format:** Use `text` format instead of `json` when possible; text formatting avoids reflection entirely.

---

## 2. Redis Cache Get (7s, 4.5% — Hot Cache Context)

**Observation:** On a hot cache, 7s in `RedisCache.Get` suggests non-trivial L0 (LRU) miss rate or Redis latency on L0 misses.

**Recommendations:**

1. **Increase L0 cache size** to improve hit rate:
   ```yaml
   cache:
     redis:
       lru_size: 50000  # or 100000 for high-QPS deployments
   ```
   Per `docs/performance.md`, hot cache targets 95–99% L0 hit rate.

2. **Verify L0 hit rate:** Check `curl http://localhost:8081/cache/stats` — if `lru.fill_ratio` is high but hit rate is low, consider larger `lru_size`.

3. **Redis locality:** Co-locate Redis with the resolver (same host/rack) to reduce network latency on L1 misses.

4. **`hit_count_sample_rate`:** If `IncrementHit`/`IncrementSweepHit` show up in profiles (~4–5% CPU), set `hit_count_sample_rate: 0.1` to reduce Redis load (see `docs/performance.md`).

---

## 3. Memory Allocation (19s+ combined)

**Root causes:**
- **L0 cache:** `msg.Copy()` on every Get (required for mutation before write)
- **DNS Pack/Unpack:** Allocations in miekg/dns for wire encoding
- **JSON encoding:** Temporary buffers and map allocations

**Recommendations:**

1. **`sync.Pool` for `dns.Msg`:** **Implemented.** L0/L1 cache Get now uses `CopyTo` into a pooled msg; caller calls `ReleaseMsg` when done. Reduces `*dns.Msg` allocation and mallocgc pressure (dns.Copy was ~27% of CPU in profiles). See [`docs/dns-msg-pool-analysis.md`](dns-msg-pool-analysis.md).

2. **Buffer pool for DNS Pack:** Reuse `[]byte` buffers for `msg.Pack()` where safe (e.g., in cache Set path). The miekg/dns API may require interface changes.

3. **ClickHouse batch buffer reuse:** Use `sync.Pool` for `bytes.Buffer` in the flush path to avoid per-flush allocations.

4. **Reduce allocations in `logRequestData`:** Pre-allocate or pool `requestlog.Entry` and avoid per-request map creation when building query store events.

---

## 4. Lock Contention (futex, 7.1s)

**Root cause:** Mutex/semaphore waits across goroutines.

**Recommendations:**

1. **L0 cache:** Already sharded (32 shards). If contention persists, consider 64 shards for very high QPS.

2. **Blocklist/safe search:** These use `sync.RWMutex`. Ensure reads dominate; consider `atomic.Value` for snapshot-based config (copy-on-write) to reduce lock hold time.

3. **Request log / query store:** `logRequestData` runs in a goroutine; ensure the writer mutex is not held long. Consider lock-free or sharded writers for very high throughput.

---

## 5. UDP System Calls (syscall Syscall6, 44s)

**Observation:** Low-level network I/O; largely kernel and protocol-bound.

**Recommendations:**

1. **SO_REUSEPORT:** Already enabled by default. Ensure `reuse_port_listeners` is tuned (e.g., 4–8) for CPU count.

2. **More listeners:** Increase `server.reuse_port_listeners` if CPU-bound to spread UDP receive load.

3. **Kernel tuning:** Consider `net.core.rmem_max`, `net.core.wmem_max` for high UDP throughput.

---

## 6. DNS CopyTo / UnpackDomainName (miekg/dns)

**Observation:** These are in the miekg/dns library; direct changes require upstream or forking.

**Recommendations:**

1. **Minimize copies:** The resolver already avoids `req.Copy()` on first upstream attempt. Audit other paths for unnecessary copies.

2. **Upstream:** If miekg/dns has allocation-heavy paths, consider contributing optimizations or evaluating alternatives.

---

## Implementation Priority

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 1 | ClickHouse: struct instead of map for JSON | Low | High |
| 2 | Increase L0 cache size (config) | Trivial | Medium–High |
| 3 | Query store sample_rate (config) | Trivial | Medium |
| 4 | sync.Pool for bytes.Buffer in ClickHouse flush | Low | Medium |
| 5 | sync.Pool for dns.Msg (careful design) | Medium | Medium |
| 6 | json-iterator for JSON encoding | Low | Medium |
| 7 | L0 shard count increase | Low | Low–Medium |

---

## Verification

After changes:

1. **Re-profile:** `go tool pprof` with CPU profile under load.
2. **Benchmark:** `go run ./cmd/perf-tester -resolver 127.0.0.1:53 -queries 50000 -concurrency 100 -warmup 5000`
3. **Monitor:** Cache stats, latency percentiles, and Redis latency.

---

## References

- `docs/performance.md` — Caching architecture, tuning, benchmarking
- `docs/code-and-architecture-standards.md` — Conventions
- `.cursor/rules/development-guidelines.mdc` — Performance considerations
