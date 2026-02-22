# sync.Pool for dns.Msg — Feasibility Analysis

**Status: Implemented.** L0/L1 cache Get uses `CopyTo` into a pooled msg; resolver calls `ReleaseMsg` after extracting rcode for logging.

This document analyzes the recommendation to use `sync.Pool` for `dns.Msg` in hot paths, including allocation sites, lifecycle constraints, and implementation options.

## Allocation Sites in Hot Paths

### 1. L0 Cache (LRU) — `internal/cache/lru.go`

```go
msg := entry.msg.Copy()  // line 91
```

- **Frequency:** Every L0 cache hit (hot path at 95–99% hit rate)
- **What allocates:** `Copy()` does `dns.CopyTo(new(Msg))` — allocates one `*dns.Msg` plus slices/RRs inside `CopyTo`
- **Contract:** Caller mutates the returned msg (`Id`, `Question`) before `WriteMsg`

### 2. L1 Cache (Redis) — `internal/cache/redis.go`

```go
msg := new(dns.Msg)
msg.Unpack(data)  // getHash:113, getLegacy:146
```

- **Frequency:** Every L1 cache hit (L0 miss)
- **What allocates:** `new(dns.Msg)` plus `Unpack` internals
- **Contract:** Same as L0 — caller mutates and writes

### 3. miekg/dns CopyTo internals

From `msg.go`:

```go
func (dns *Msg) CopyTo(r1 *Msg) *Msg {
    r1.MsgHdr = dns.MsgHdr
    r1.Compress = dns.Compress
    r1.Question = cloneSlice(dns.Question)
    rrArr := make([]RR, len(dns.Answer)+len(dns.Ns)+len(dns.Extra))
    // ... append r.copy() for each RR
}
```

Pooling the `*Msg` struct saves one allocation, but `CopyTo` still allocates:
- `cloneSlice(dns.Question)`
- `make([]RR, ...)` for Answer/Ns/Extra
- `r.copy()` for each RR (multiple allocations)

So the **Msg struct itself** is a small part of the total; the bulk is in slices and RR copies.

---

## Caller Lifecycle Constraint

The resolver passes the cached msg to `logRequestWithBreakdown`, which spawns a goroutine:

```go
go r.logRequestData(clientAddr, protocol, question, outcome, cached, ...)
```

`logRequestData` only reads `response.Rcode` to build the log entry. The goroutine holds a reference to the msg until it finishes.

**Implication:** We cannot `Put` the msg back to the pool until the goroutine is done, unless we stop passing the full msg to the goroutine.

---

## Implementation Options

### Option A: Extract rcode Before Goroutine + Pool in Cache

1. Change `logRequestData` to accept `rcode string` instead of `response *dns.Msg`
2. In `logRequestWithBreakdown`, extract `rcode` from `response` before spawning the goroutine
3. Add `sync.Pool` for `*dns.Msg` in the cache package
4. LRU `Get`: get from pool, `entry.msg.CopyTo(pooled)`, return pooled
5. Redis `getHash`/`getLegacy`: get from pool, `msg.Unpack(data)` into it, return pooled
6. Add `ReleaseMsg(msg *dns.Msg)` to the cache interface; resolver calls it after extracting rcode

**Pros:** Saves `*dns.Msg` allocation on every cache hit  
**Cons:** API change (new `ReleaseMsg`), all cache implementations must support it, easy to forget `Release` and leak

### Option B: Pool in Resolver Only (CopyTo Path)

1. Resolver has a `msgPool sync.Pool`
2. On cache hit: `pooled := getFromPool(); cached.CopyTo(pooled); use pooled; Put(pooled)`
3. Still need to fix `logRequestData` so we can Put before the goroutine runs

**Pros:** No cache interface change  
**Cons:** Resolver must know when the msg is from cache vs upstream/blocked/local (different allocation paths). Only helps the L0/L1 hit path.

### Option C: No Pool — Accept Allocation

The `*dns.Msg` allocation is small relative to:
- `CopyTo`’s slice and RR allocations
- JSON encoding (already optimized with structs)
- Redis/network I/O

**Benchmark:** `BenchmarkShardedLRUCacheGet` allocates ~1–2 KB per Get (msg + CopyTo internals). The Msg struct is ~50–100 bytes. Pooling saves that fraction.

---

## Recommendation

**Implemented:** Profile showed dns.Copy + mallocgc at ~38% of CPU. We implemented Option A: pool in cache, `CopyTo` into pooled msg, `ReleaseMsg` when done. `logRequestData` now takes `rcode string` so we can release before the logging goroutine.

**Previously (Option C):** Defer pooling — the `*dns.Msg` allocation was a small fraction.

- The `*dns.Msg` allocation is a small share of total allocation in the hot path
- `CopyTo` and RR copies dominate; pooling the Msg alone doesn’t address those
- Adding `ReleaseMsg` and a clear “caller must release” contract increases complexity and risk of misuse
- The `logRequestData` change (extract rcode before goroutine) is a good refactor on its own, but the benefit is not tied to pooling

**If you want to pursue pooling later:**

1. **Refactor first:** Change `logRequestData` to take `rcode string` instead of `response *dns.Msg`
2. **Benchmark:** Add allocation benchmarks before/after to measure impact
3. **Pool in cache:** LRU and Redis `Get` use `CopyTo`/`Unpack` into a pooled Msg
4. **Explicit release:** Add `ReleaseMsg` and document it clearly; consider wrapping the resolver in a helper that ensures release on all paths

---

## Alternative: Reduce CopyTo Cost

The profile shows `dns (*msg) CopyTo` at 2.93s (1.86%). The main cost is in `CopyTo`, not in `new(Msg)`.

**Possible improvement:** If miekg/dns added a `CopyTo` that reuses slices in the destination (e.g. `r1.Answer = r1.Answer[:0]` and append), we could avoid some allocations. That would require changes in miekg/dns or a fork.

---

## References

- `docs/performance-bottleneck-review.md` — original recommendation
- `internal/cache/lru.go` — `Get` contract and `Copy()`
- `internal/cache/redis.go` — `getHash`, `getLegacy`
- `internal/dnsresolver/resolver.go` — `ServeDNS` cache hit path, `logRequestWithBreakdown`
- `docs/code-review.md` N6 — notes on `msg.Copy()` (contract requires copy; resolver mutates)
