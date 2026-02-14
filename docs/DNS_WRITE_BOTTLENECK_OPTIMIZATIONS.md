# DNS/UDP Write Bottleneck Optimizations

When profiling shows the primary bottleneck in `syscall Syscall6` (UDP sendmsg) and the DNS write path (`WriteMsg` → `WriteToSessionUDP` → `writeMsg`), the following optimizations can help within your codebase.

## Summary of the Bottleneck

The flame graph shows ~30% of execution time in the UDP write syscall path. Each DNS response requires a separate `sendmsg` syscall. At high QPS, the kernel and network stack become saturated. These optimizations reduce work *around* the write and spread load to improve throughput.

---

## 1. Async Request Logging (Implemented)

**Impact: High** — Request logging and query store recording run synchronously after `WriteMsg`, blocking the handler. Moving them to a background goroutine frees the handler immediately, reducing goroutine blocking and improving concurrency.

**Change:** `logRequestWithBreakdown` now runs in a goroutine so the handler returns right after sending the response.

---

## 2. Reduce Blocklist Regex Usage

**Impact: Medium** — The flame graph shows `regexp (*Regexp) tryBacktrack` consuming ~0.7% of time. Allow/deny lists that use regex patterns (e.g. `/pattern/`) trigger backtracking, which is expensive.

**Recommendation:** Prefer exact domain matches over regex when possible. Use regex only when suffix matching is insufficient.

```yaml
# Prefer this (exact/suffix match, fast):
blocklists:
  allowlist: ["example.com", "trusted.org"]
  denylist: []

# Avoid regex when not needed:
blocklists:
  allowlist: ["/^.*\\.trusted\\.org$/"]  # Slow - use suffix match instead
```

---

## 3. Tune `hit_count_sample_rate`

**Impact: Medium** — Hit counting (`IncrementHit`, `IncrementSweepHit`) uses Redis. At high QPS, sampling reduces Redis load while preserving refresh behavior.

**Recommendation:** For very high QPS (>50K), lower the sample rate:

```yaml
cache:
  refresh:
    hit_count_sample_rate: 0.05  # Sample 5% of hits (default 1.0 = 100%)
```

---

## 4. Tune `query_store.sample_rate`

**Impact: Low–Medium** — ClickHouse recording adds CPU and channel pressure. Sampling reduces load.

**Recommendation:** For high-throughput deployments:

```yaml
query_store:
  sample_rate: 0.5   # Record 50% of queries (default 1.0)
  # Or 0.1 for 10% when analytics precision is less critical
```

---

## 5. Increase L0 Cache Size

**Impact: Medium** — More L0 hits mean fewer Redis lookups and less work per request.

**Recommendation:** For high QPS, increase L0 size:

```yaml
cache:
  redis:
    lru_size: 50000   # Or 100000 for max-performance (default 10000)
```

---

## 6. Disable Request Logging in Production

**Impact: Low–Medium** — If request logging is not required, disable it to avoid file I/O:

```yaml
request_log:
  enabled: false
```

---

## 7. SO_REUSEPORT for Multiple UDP Listeners (Future)

**Impact: High** — A single UDP socket can become a bottleneck. `SO_REUSEPORT` allows multiple listeners on the same port, spreading traffic across kernel RX/TX queues.

**Status:** Would require custom listener setup with `syscall.SetsockoptInt` and passing a `PacketConn` to miekg/dns. Not yet implemented.

---

## 8. Reduce Work Before WriteMsg

**Already optimized:**
- Hit counting runs in a goroutine (after `HIGH_LOAD_TIMING_FIX`)
- Query store uses a buffered channel (non-blocking)
- Request logging is now async (this document)

---

## Configuration Summary for High QPS

```yaml
server:
  listen: ["0.0.0.0:53"]
  protocols: ["udp", "tcp"]

cache:
  redis:
    lru_size: 50000
  refresh:
    hit_count_sample_rate: 0.1

query_store:
  sample_rate: 0.5

request_log:
  enabled: false   # Or keep enabled with async logging
```

---

## What You Cannot Optimize in Userspace

- **UDP syscall cost:** Each response needs a `sendmsg` syscall. The kernel and NIC limit throughput.
- **Network stack:** At very high QPS, the bottleneck may be kernel networking or hardware. Consider horizontal scaling (multiple instances behind a load balancer) or moving clients to TCP/DoH for different characteristics.
