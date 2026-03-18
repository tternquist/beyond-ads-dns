# Architecture & Code Review

> Reviewed: 2026-03-18
> Branch: `claude/architecture-code-review-Avaqq`

---

## 1. Executive Summary

`beyond-ads-dns` is a well-structured, production-grade DNS resolver written in Go with a Node.js/React management UI. The overall architecture is sound: clear separation of concerns, good use of Go idioms, and solid operational features (HA, observability, graceful degradation). This review identifies specific areas for improvement ranging from critical bugs to minor style issues.

**Severity legend:** 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low · ✅ Positive finding

---

## 2. Architecture Overview

```
Client DNS Query
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  DNS Resolver (Go)                                  │
│                                                     │
│  Local Records → Safe Search → Blocklist Check      │
│       │                              │              │
│       ▼                         (blocked)           │
│  L0 Cache (ShardedLRU/SIEVE)        │              │
│       │ miss                    NXDOMAIN/NOERROR    │
│       ▼                                             │
│  L1 Cache (Redis)                                   │
│       │ miss                                        │
│       ▼                                             │
│  Upstream DNS (UDP/TCP/TLS/DoT/DoH/DoQ)             │
│       │                                             │
│       └──→ QueryStore (ClickHouse) [async]          │
└─────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  Control Plane (Go HTTP)                            │
│  Blocklist mgmt, cache ops, config reload           │
└─────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  Web Server (Express.js)  ←→  React SPA             │
│  Session auth, API proxy, Let's Encrypt             │
└─────────────────────────────────────────────────────┘
```

The multi-tier cache (L0 in-memory SIEVE → L1 Redis) combined with refresh-ahead sweeping and stale serving is the core performance innovation. The design is appropriate for the use case.

---

## 3. Findings

### 3.1 Security

#### 🟠 `auth.js`: Password hashed on every cold start, not cached across restarts

**File:** `web/server/src/auth.js:19–25`

```js
function loadStoredHash() {
  if (storedHash) return storedHash;
  const uiPassword = getUiPassword();
  if (uiPassword) {
    storedHash = bcrypt.hashSync(uiPassword, 10);  // hashed at first call
    return storedHash;
  }
  ...
}
```

The plaintext password from `UI_PASSWORD`/`ADMIN_PASSWORD` is re-hashed with bcrypt (cost 10) on the first request after each restart. This is correct for verification but means the plaintext password lives in `process.env` for the lifetime of the process. If an attacker can read `/proc/<pid>/environ` they get the plaintext password. This is a common deployment pattern but worth noting. **Recommendation:** Prefer file-based password storage (`ADMIN_PASSWORD_FILE`) or use a secrets manager; avoid plaintext passwords in environment variables.

#### 🟡 `auth.js`: `storedHash` is a module-level singleton

```js
let storedHash = null;
```

The module-level `storedHash` persists across requests. If `setAdminPassword()` is called concurrently (unlikely but possible), there's a TOCTOU window where one call reads the old hash while another writes the new one. Since Node.js is single-threaded this is not a practical exploit, but `storedHash = hash` in `setAdminPassword` should be set *after* file write completes (which it does — ✅).

#### 🔵 `authMiddleware`: Path-based bypass is brittle

**File:** `web/server/src/middleware/auth.js:13–16`

```js
if ((p === "/api/auth/login" || p === "/auth/login") && req.method === "POST") return next();
```

Hardcoded path comparisons work but are fragile. If the app mounts routes at a different prefix, auth bypass for login/status would silently break. Consider using a route-level approach (apply the middleware only to protected router groups) rather than allowlisting individual paths.

#### ✅ ClickHouse query parameterization is correct

`web/server/src/services/clickhouse.js` uses parameterized queries (`{param: Type}`) for all user-supplied filter values. `sortBy` is validated against an allowlist before interpolation. `sortDir` is forced to `"asc"` or `"desc"`. No SQL injection risk observed.

#### ✅ Identifier validation in Go ClickHouse client

`internal/querystore/clickhouse.go:isValidIdentifier` validates database/table names (alphanumeric + underscore, max 256 chars) before use in raw SQL. `isValidPartitionID` validates partition format. Both prevent injection in the Go-side ClickHouse HTTP client.

---

### 3.2 Concurrency & Correctness

#### 🟠 `blocklist/manager.go`: `logf` passes `nil` context to `slog.Logger.Log`

**File:** `internal/blocklist/manager.go:810`

```go
func (m *Manager) logf(level slog.Level, msg string, args ...any) {
    if m.logger == nil {
        return
    }
    m.logger.Log(nil, level, msg, args...)  // nil ctx
}
```

`slog.Logger.Log` accepts a `context.Context` as the first argument. Passing `nil` is technically valid (the default handler ignores it), but if a context-aware handler (e.g., trace context propagation) is ever used, this will panic. **Recommendation:** Pass `context.Background()` instead of `nil`.

#### 🟠 `blocklist/manager.go`: `ValidateSources` reads `lastAppliedCfg` without lock

**File:** `internal/blocklist/manager.go:296–302`

```go
func (m *Manager) ValidateSources(ctx context.Context) ([]HealthCheckResult, error) {
    m.configMu.RLock()
    sources := append([]config.BlocklistSource(nil), m.sources...)
    healthCfg := m.lastAppliedCfg.HealthCheck   // dereferences pointer under RLock ✓
    m.configMu.RUnlock()
    return m.validateSources(ctx, sources, healthCfg)
}
```

The lock covers the `lastAppliedCfg` dereference, but `healthCfg` is a pointer to a struct field. Once the lock is released, `m.lastAppliedCfg` could be swapped by `ApplyConfig`, leaving `healthCfg` pointing to freed memory if the old config is GC'd. In practice Go's GC prevents use-after-free, but the semantics are unclear. **Recommendation:** Copy the `HealthCheck` struct value under the lock:

```go
healthCfgVal := *m.lastAppliedCfg.HealthCheck  // copy the value
// pass &healthCfgVal
```

#### 🟡 `cache/redis.go`: `SetMaxKeys` is not protected by a mutex

**File:** `internal/cache/redis.go:969–977`

```go
func (c *RedisCache) SetMaxKeys(n int) {
    ...
    c.maxKeys = n  // plain write, no lock
}
```

`maxKeys` is read in `EvictToCap` without a lock. If `SetMaxKeys` is called from a config reload goroutine while `EvictToCap` is running, there's a data race. Since `maxKeys` is a plain `int` (not atomic), this is a real race condition on 64-bit platforms (though benign in practice — the worst case is using a stale cap value for one sweep). **Recommendation:** Use `atomic.Int64` or protect with a mutex.

#### 🟡 `cache/redis.go`: `redisKeysCache` double-checked locking pattern is correct but verbose

**File:** `internal/cache/redis.go:1194–1208`

The pattern acquires the mutex, checks, releases, does work, re-acquires, updates — correct but has a TOCTOU window where multiple goroutines could all miss the cache and call `countKeysByPrefix` concurrently. This is intentional (no thundering herd protection needed for a 30s cache), but a `sync.Once`-style singleflight would be cleaner at high concurrency. This is low severity given the 30s TTL.

#### 🟡 `dnsresolver/resolver.go`: `refreshUpstreamFailLastLog` protected by its own mutex, separate from resolver state

The resolver uses a dedicated `refreshUpstreamFailLogMu` mutex for the log dedup state. This is correct but could be replaced by `atomic.Int64` (Unix timestamp) for a lock-free implementation. Minor.

#### ✅ `atomic.Value` snapshot pattern for blocklists is correct

`blocklist/manager.go` uses `atomic.Value` for the snapshot, allowing lock-free reads in the hot path (`IsBlocked`). Writes swap the entire snapshot atomically. This is idiomatic Go for read-heavy, write-rarely data.

#### ✅ SIEVE eviction in L0 LRU is correct

`cache/lru.go` implements SIEVE eviction using a `uint32` atomic `visited` bit. Gets use `RLock`; the visited bit is set with `atomic.StoreUint32`, which is safe under `RLock`. Eviction (which sets `visited=0` and moves the hand) requires `Lock`. This is a correct lock-split.

---

### 3.3 Error Handling

#### 🟠 `blocklist/manager.go:LoadOnce`: health check result is partially redundant

**File:** `internal/blocklist/manager.go:322–332`

When `health_check.enabled=true`, `LoadOnce` calls `validateSources` first (HEAD/GET per URL), then immediately fetches each URL again for content. This means every blocklist URL is fetched **twice** per reload when health checks are enabled — once for validation, once for content. At scale (many large blocklist URLs), this doubles bandwidth and latency. **Recommendation:** Combine health check and content fetch into a single pass, or skip the pre-flight health check in `LoadOnce` and let fetch errors be handled directly (the per-source error handling already exists).

#### 🟡 `bootstrap.go`: ClickHouse startup retry uses `time.Sleep` in a hot loop

**File:** `cmd/beyond-ads-dns/bootstrap.go:140–165`

```go
for elapsed := time.Duration(0); elapsed < startupRetryMax; elapsed += startupRetryInterval {
    ...
    time.Sleep(startupRetryInterval)
}
```

The loop does not check `ctx.Done()`, so if a SIGTERM arrives during the 2-minute retry window, the process will not shut down gracefully until the retry loop exits. **Recommendation:** Select on `ctx.Done()` in the retry loop.

#### 🟡 `cache/hit_batcher.go`: futures closed (not sent) on pipeline error

**File:** `internal/cache/hit_batcher.go:190–196`

```go
if err != nil {
    for _, item := range ordered {
        for _, ch := range item.entry.futures {
            close(ch)  // receiver gets zero value, not an error signal
        }
    }
    return
}
```

When the Redis pipeline fails, futures are closed without sending a value. The receiver (if any) gets the zero value `0` and cannot distinguish an error from a legitimate zero count. Since `addHitFireAndForget` is the only current caller (no futures), this path is dead code, but if `addHit` (with futures) is used in future, this could cause silent misclassification. **Recommendation:** Document this clearly or use a sentinel value.

#### 🔵 `blocklist/manager.go:validateSources`: body not fully drained on non-2xx

**File:** `internal/blocklist/manager.go:277`

```go
io.CopyN(io.Discard, resp.Body, 64*1024)  // only 64KB
resp.Body.Close()
```

For non-2xx responses, only 64KB of the body is drained. If the server sends a large error page, the remaining body is abandoned, potentially preventing connection reuse. This is minor since error pages are rarely huge, but using `io.Copy(io.Discard, resp.Body)` (no limit) or configuring a `MaxBytesReader` would be cleaner. The 64KB limit is intentional to avoid large allocations — acceptable.

---

### 3.4 Performance

#### 🟡 `blocklist/manager.go:IsBlocked`: bloom filter subdomain traversal duplicates work

**File:** `internal/blocklist/manager.go:599–621`

```go
// Bloom filter check: traverse all subdomains
remaining := normalized
inBloom := false
for {
    if snapshot.bloomFilter.MayContain(remaining) {
        inBloom = true
        break
    }
    index := strings.IndexByte(remaining, '.')
    if index == -1 { break }
    remaining = remaining[index+1:]
}
if !inBloom { return false }

// Map lookup: traverse all subdomains again
return domainMatchExact(snapshot.blocked, normalized)
```

When the bloom filter returns a positive (which includes all true positives and ~0.1% false positives), `domainMatchExact` traverses the subdomain hierarchy *again* independently. At high QPS with long domain names, this doubles the string traversal work for hot domains. The two traversals could be unified: if the bloom check passes for a specific suffix level, check the map at that level immediately. This is a micro-optimization; the current approach is correct and readable.

#### 🔵 `cache/redis.go:EvictToCap`: `limit` computation bug (no-op branch)

**File:** `internal/cache/redis.go:873–876`

```go
limit := toEvict + evictionCandidateBatch  // e.g. 100 + 5000 = 5100
if limit > evictionCandidateBatch {
    limit = evictionCandidateBatch         // always caps to 5000; first line is dead
}
```

The first `limit` assignment is always overwritten by the `if` branch (since `toEvict > 0` means `limit > evictionCandidateBatch`). The intent seems to be `min(toEvict + batchSize, batchSize)` = `batchSize`, making the first line unnecessary. **Recommendation:** Simplify to `limit := evictionCandidateBatch`.

#### 🔵 `blocklist/manager.go`: `normalizeList` allocates empty `regex` slice always

```go
matcher := &domainMatcher{
    exact: make(map[string]struct{}),
    regex: make([]*regexp.Regexp, 0),  // always allocated
}
```

When no regex patterns exist (the common case), the empty slice is unnecessary. Minor allocation. Acceptable.

---

### 3.5 Code Quality & Maintainability

#### 🟡 `bootstrap.go`: DoH/DoT configuration has 6+ manual env-override patterns

**File:** `cmd/beyond-ads-dns/bootstrap.go:205–230`

The DoH/DoT section has repetitive env → config fallback patterns:
```go
dohCertFile := strings.TrimSpace(os.Getenv("DOH_DOT_CERT_FILE"))
if dohCertFile == "" {
    dohCertFile = cfg.DoHDotServer.CertFile
}
```
This pattern is repeated 5 times for different fields. A helper function `envOrDefault(envKey, configValue string) string` would eliminate ~25 lines of boilerplate and make the intent clearer.

#### 🟡 `config/config.go`: Legacy field migration adds complexity

The `Config` struct maintains both legacy top-level fields (`UpstreamTimeout`, `UpstreamBackoff`, etc.) and the new `Network` sub-struct, requiring `resolveNetworkConfig` to check both at runtime. This dual-field approach accumulates technical debt. Consider deprecating the legacy fields entirely in a future major version and documenting the migration timeline.

#### 🔵 `dnsresolver/resolver.go`: `Resolver` struct is very large

The `Resolver` struct has ~40 fields including multiple protocol-specific client maps, group blocklists, stats, trace events, and webhook notifiers. While Go doesn't enforce struct size limits, splitting into logical sub-structs (e.g., `networkClients`, `cacheState`, `blocklistState`) would improve readability and make the dependency graph clearer.

#### 🔵 `blocklist/manager.go`: `scheduledPauseEqual` and `familyTimeEqual` are nearly identical

Both functions compare `Enabled`, `Start`, `End`, `Days`, and type-specific lists with the same loop structure. A generic helper (e.g., `scheduleBaseEqual`) could reduce ~40 lines of duplication.

#### ✅ Interface-based design enables testability

`cache/interface.go` defines `DNSCache` with compile-time assertions (`var _ DNSCache = (*RedisCache)(nil)`). `querystore/store.go` similarly. Both enable clean mock-based unit testing without Redis or ClickHouse.

#### ✅ `blocklistConfigEqual` prevents unnecessary reloads

The skip-reload-when-unchanged optimization in `ApplyConfig` is well-motivated (avoiding 100MB+ allocations on no-op config saves) and correctly implemented. The equality check covers all semantically relevant fields.

---

### 3.6 Web Server (Node.js)

#### 🟡 `queries.js`: `sortBy`/`sortDir` interpolated directly into SQL string

**File:** `web/server/src/routes/queries.js:48–50`

```js
ORDER BY ${sortBy} ${sortDir}
```

`sortBy` and `sortDir` are normalized via `normalizeSortBy`/`normalizeSortDir` before use. This is safe, but the pattern is visually indistinguishable from unsafe interpolation. **Recommendation:** Add a comment at the interpolation site explaining that these values are pre-validated, to prevent future maintainers from following the pattern with unvalidated values.

#### 🟡 `index.js`: No rate limiting on auth endpoints

The login endpoint (`POST /api/auth/login`) processes bcrypt comparisons (deliberately slow, cost 10). Without rate limiting, an attacker can submit thousands of guesses per minute, limited only by bcrypt's CPU cost. **Recommendation:** Add a simple per-IP rate limit (e.g., using `express-rate-limit`) to the auth login route: max 10 attempts per minute per IP.

#### 🔵 `auth.js`: Minimum password length is only 6 characters

```js
if (pwd.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters" };
}
```

6 characters is below current NIST SP 800-63B guidelines (minimum 8 for memorized secrets, 15+ recommended for admin accounts). **Recommendation:** Raise to at least 8, preferably 12.

---

### 3.7 Positive Architectural Findings

✅ **SIEVE eviction** (NSDI '24) in the L0 LRU: avoids list reordering on cache hits, allowing `Get` to use `RLock` instead of `Lock`. Reduces contention by ~32x with sharding. Well-justified choice.

✅ **Atomic snapshot pattern** for blocklists: zero-copy, lock-free reads on the hot path. Writers swap the entire snapshot atomically, ensuring readers always see a consistent view.

✅ **Stale serving with background refresh**: DNS clients see low latency even during cache misses; upstream latency is hidden. The `stale_ttl` + `expired_entry_ttl` separation is well-designed.

✅ **Bloom filter for negative blocklist lookups**: 0.1% FPR avoids map traversal for most non-blocked queries. The subdomain-aware bloom check is correct.

✅ **Graceful Redis degradation**: The health monitor + `redisAvailable` atomic flag ensures L0-only fallback without restart. Re-enables L1 automatically on recovery.

✅ **Connection pooling for TCP/TLS upstreams**: Reuses established connections per upstream, reducing latency and handshake overhead.

✅ **Query batching in ClickHouse client**: Buffered in-memory with periodic flush reduces write amplification. Configurable `flush_to_store_interval` and `batch_size`.

✅ **bcrypt for password storage**: Cost 10 is appropriate for a self-hosted tool. File-based hash storage survives container restarts.

✅ **Parameterized queries in both Go and Node.js ClickHouse clients**: Consistent SQL injection prevention at both layers.

---

## 4. Summary Table

| # | File | Finding | Severity |
|---|------|---------|---------|
| 1 | `blocklist/manager.go:810` | `nil` context passed to `slog.Log` | 🟠 |
| 2 | `blocklist/manager.go:296` | `healthCfg` pointer read after lock release | 🟠 |
| 3 | `blocklist/manager.go:322` | Double HTTP fetch when health check enabled | 🟠 |
| 4 | `web/server/src/auth.js` | Plaintext password in `process.env` | 🟠 |
| 5 | `cache/redis.go:969` | `maxKeys` written without synchronization | 🟡 |
| 6 | `cache/redis.go:1194` | TOCTOU in Redis key count cache (benign) | 🟡 |
| 7 | `bootstrap.go:140` | Startup retry loop ignores `ctx.Done()` | 🟡 |
| 8 | `cache/hit_batcher.go:190` | Futures closed (not sent) on pipeline error | 🟡 |
| 9 | `bootstrap.go:205` | Repetitive env-override boilerplate | 🟡 |
| 10 | `config/config.go` | Legacy field dual-maintenance | 🟡 |
| 11 | `web/server/src/routes/queries.js:48` | Validated SQL interpolation (needs comment) | 🟡 |
| 12 | `web/server/src/index.js` | No rate limiting on login endpoint | 🟡 |
| 13 | `blocklist/manager.go:599` | Bloom + map traversal duplicates subdomain walk | 🔵 |
| 14 | `cache/redis.go:873` | Dead `limit` assignment in `EvictToCap` | 🔵 |
| 15 | `web/server/src/auth.js:75` | Minimum password length too short (6 chars) | 🔵 |
| 16 | `dnsresolver/resolver.go` | `Resolver` struct is very large | 🔵 |
| 17 | `blocklist/manager.go` | `scheduledPauseEqual`/`familyTimeEqual` duplication | 🔵 |

---

## 5. Recommended Prioritization

**Address immediately (before next release):**
1. Pass `context.Background()` instead of `nil` in `logf` (trivial fix, prevents future panic)
2. Fix `maxKeys` data race with `atomic.Int64` (correctness)
3. Add rate limiting to login endpoint (security)
4. Fix ClickHouse startup retry to respect `ctx.Done()` (graceful shutdown)

**Address in next sprint:**
5. Eliminate double HTTP fetch in `LoadOnce` when health check enabled (performance)
6. Raise minimum password length to 12
7. Add comment at SQL interpolation site in `queries.js`
8. Refactor DoH/DoT env override boilerplate in `bootstrap.go`

**Backlog (tech debt):**
9. Plan deprecation of legacy config fields
10. Consider splitting `Resolver` struct
11. Fix dead `limit` assignment in `EvictToCap`
12. Unify `scheduledPauseEqual`/`familyTimeEqual`
