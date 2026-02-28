# Redis Key Schema

This document describes the Redis key layout used by beyond-ads-dns. The same Redis instance may be used by the DNS resolver (Go) for caching and by the web server (Node.js) for sessions; keys are namespaced by prefix to avoid collisions.

---

## Overview

| Namespace   | Prefix (standalone) | Prefix (cluster)   | Owner   | Purpose                          |
|------------|---------------------|--------------------|---------|----------------------------------|
| DNS cache  | `dns:*`             | `dns:*`            | Resolver| Cached DNS responses             |
| DNS metadata | `dnsmeta:*`       | `{dnsmeta}:*`      | Resolver| Hit counts, expiry index, locks  |
| Sessions   | (connect-redis default, e.g. `sess:*`) | same | Web UI  | Admin session storage (optional) |

In **Redis Cluster** mode, all `dnsmeta` keys use the hash tag `{dnsmeta}` so they land on the same slot, allowing pipelines without `CROSSSLOT` errors. The `dns:*` cache keys are not tagged and are distributed by key name.

---

## 1. DNS cache keys (`dns:*`)

**Format:** `dns:<qname>:<qtype>:<qclass>`

- **qname:** Query name (e.g. `example.com.` or `example.com`), as used by the resolver.
- **qtype:** DNS type (numeric), e.g. `1` (A), `28` (AAAA), `5` (CNAME).
- **qclass:** DNS class (numeric), typically `1` (IN).

**Example:** `dns:example.com.:1:1` (A record, IN class for `example.com.`).

### Data type and layout

- **Current (preferred):** **Hash**
  - `msg` (binary): Packed `dns.Msg` (wire format).
  - `soft_expiry` (string): Unix timestamp when the entry is considered stale for refresh; TTL is derived from this.
  - `created_at` (string): Unix timestamp when the entry was first stored (used by sweep to avoid deleting “warm” keys).
- **Legacy:** **String** — raw packed `dns.Msg`. Still read for backward compatibility; on read the resolver may migrate to the hash format via `SetWithIndex`.

### TTL

- Redis TTL is set to `ttl + gracePeriod` (gracePeriod = `min(ttl, maxGracePeriod)`, e.g. 1 hour). Keys expire in Redis after that.
- “Soft” expiry (for refresh/sweep decisions) is stored in the hash field `soft_expiry`; the resolver may serve the response until Redis TTL or until it is replaced.

### Operations

- **Write:** `HSET` + `ZADD` (expiry index) + `EXPIRE` (see §2).
- **Read:** `HGET msg`, `HGET soft_expiry` (and optionally `HGET created_at`).
- **Delete:** `DEL` (and `ZREM` from expiry index).

---

## 2. DNS metadata keys (`dnsmeta:*` or `{dnsmeta}:*`)

Used for refresh locking, hit counting, sweep hit counting, and the expiry index. In cluster mode the prefix is `{dnsmeta}:` so all metadata keys share one slot.

### 2.1 Refresh lock

**Key:** `dnsmeta:refresh:<cache_key>` or `{dnsmeta}:refresh:<cache_key>`

- **cache_key:** Same as the DNS cache key, e.g. `dns:example.com.:1:1`.
- **Type:** String.
- **Value:** `"1"` (presence indicates lock held).
- **TTL:** Short (e.g. 10s); used to avoid duplicate background refreshes for the same cache key.
- **Operations:** `SET key 1 NX EX <ttl>` to acquire, `DEL` to release.

### 2.2 Hit count (cache hits in a window)

**Key:** `dnsmeta:hit:<cache_key>` or `{dnsmeta}:hit:<cache_key>`

- **cache_key:** Same as the DNS cache key.
- **Type:** String (integer).
- **Value:** Count of cache hits in the current window.
- **TTL:** `window` (e.g. 5m); refreshed on each batched increment.
- **Operations:** `INCRBY` (batched), `EXPIRE` with window; `GET` for sweep/refresh logic.

### 2.3 Sweep hit count

**Key:** `dnsmeta:hit:sweep:<cache_key>` or `{dnsmeta}:hit:sweep:<cache_key>`

- **cache_key:** Same as the DNS cache key.
- **Type:** String (integer).
- **Value:** Count of “sweep” hits (hits on entries that are past soft expiry, used to decide refresh vs. delete).
- **TTL:** `sweepHitWindow`; refreshed on each batched increment.
- **Operations:** `INCRBY` (batched), `EXPIRE`; `GET` (often pipelined) for sweep decisions.

### 2.4 Expiry index

**Key:** `dnsmeta:expiry:index` or `{dnsmeta}:expiry:index`

- **Type:** Sorted Set.
- **Score:** Soft-expiry Unix timestamp of the cache entry.
- **Member:** DNS cache key (e.g. `dns:example.com.:1:1`).
- **Purpose:** List cache keys by soft-expiry time for sweep (candidates for refresh or deletion). Reconcile logic periodically removes members whose cache key no longer exists (e.g. evicted by Redis TTL).
- **Operations:** `ZADD` on cache write, `ZRANGEBYSCORE` for candidates, `ZREM` on delete/reconcile.

---

## 3. Web UI sessions (optional)

When the web server uses Redis for session storage (`connect-redis` with the same Redis as the resolver), sessions use the store’s default key prefix (e.g. `sess:*` in connect-redis). These keys are separate from `dns:*` and `dnsmeta:*` and are not used by the DNS resolver.

---

## 4. Key patterns for administration

- **Count DNS cache entries:** `SCAN` with pattern `dns:*` (avoid `KEYS dns:*` on large instances). The resolver caches this count for 30s for stats.
- **Redis DNS key cap:** When `cache.redis.max_keys` is set (default 10000, 0 = no cap), the refresh sweeper evicts keys when over cap. Eviction order: lowest cache hits first, then oldest (by `created_at`). This keeps hot keys and prevents unbounded L1 growth.
- **Clear all DNS cache and metadata:** Delete by prefix:
  - `dns:*`
  - `dnsmeta:*` (standalone/sentinel) or `{dnsmeta}:*` (cluster).  
  The control API “clear cache” does both and clears the in-memory L0 cache.

---

## 5. References

- Cache implementation: `internal/cache/redis.go`
- Cache key construction: `internal/dnsresolver/resolver.go` (`cacheKey`: `dns:<name>:<qtype>:<qclass>`)
- Hit batching: `internal/cache/hit_batcher.go`
- Architecture: `docs/code-and-architecture-standards.md`, `docs/performance.md`
