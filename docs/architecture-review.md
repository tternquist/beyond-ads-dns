# Architecture Review and Recommendations

This document provides an architecture review of the beyond-ads-dns project and proposes recommended changes to improve maintainability, testability, and scalability.

## Executive Summary

The project has a solid foundation: clear internal package structure, well-designed config system, and a sophisticated multi-tier caching architecture. The main areas for improvement are **separation of concerns** in the main entry point, **interface-based design** for key dependencies, and **modularization** of the control API and web server.

---

## Current Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           cmd/beyond-ads-dns/main.go                         │
│  (Config, ErrorBuffer, RequestLog, QueryStore, Cache, Blocklist, Resolver,   │
│   Control Server, DoH/DoT, Sync Client, DNS Servers)                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
┌───────────────┐             ┌─────────────────┐             ┌─────────────────┐
│ internal/     │             │ internal/       │             │ internal/       │
│ blocklist     │             │ dnsresolver     │             │ cache           │
│ config        │             │ (Resolver)      │             │ (RedisCache)     │
│ localrecords  │             └────────┬────────┘             └─────────────────┘
└───────────────┘                      │
        │                               │ depends on *cache.RedisCache (concrete)
        │                               │
        ▼                               ▼
┌───────────────┐             ┌─────────────────┐
│ internal/     │             │ internal/       │
│ querystore    │             │ dohdot          │
│ (Store iface) │             │ (Handler iface) │
└───────────────┘             └─────────────────┘
```

### Strengths

1. **Clear package boundaries** — `internal/` packages (blocklist, cache, config, dnsresolver, etc.) have focused responsibilities.
2. **Interface usage** — `querystore.Store`, `requestlog.Writer`, `dohdot.Handler`, `webhook.Formatter`, `metrics.StatsProvider` enable swapping implementations.
3. **Config design** — `internal/config` has validation, defaults, env overrides, and merge logic.
4. **Multi-tier caching** — L0 LRU, L1 Redis, Bloom filter, refresh-ahead, and stale serving are well-documented and performant.
5. **Comprehensive features** — Blocklists, local records, sync, DoH/DoT, webhooks, safe search, client identification.

---

## Recommendations

### 1. Extract Control Server to Dedicated Package (High Priority)

**Current state:** The control server and its 20+ HTTP handlers are defined inline in `main.go` (~350 lines in `startControlServer`).

**Recommendation:** Create `internal/control` (or `internal/api`) and move all handlers into a dedicated package. Each handler group (blocklists, cache, sync, etc.) can live in its own file.

**Benefits:**
- Reduces `main.go` size and improves readability
- Enables unit testing of handlers in isolation
- Clearer ownership and discoverability

**Proposed structure:**
```
internal/control/
  server.go      # Server setup, mux, auth helpers
  blocklists.go  # /blocklists/* handlers
  cache.go       # /cache/* handlers
  sync.go        # /sync/* handlers
  upstreams.go   # /upstreams/* handlers
  ...
```

---

### 2. Introduce Cache Interface (High Priority)

**Current state:** `dnsresolver.Resolver` depends on `*cache.RedisCache` directly. There is no `cache.Cache` or `cache.DNSCache` interface.

**Recommendation:** Define a `DNSCache` interface in `internal/cache` with the methods used by the resolver:

```go
type DNSCache interface {
    Get(ctx context.Context, key string) (*dns.Msg, error)
    GetWithTTL(ctx context.Context, key string) (*dns.Msg, time.Duration, error)
    Set(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error
    SetWithIndex(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error
    IncrementHit(ctx context.Context, key string, window time.Duration) (int64, error)
    GetHitCount(ctx context.Context, key string) (int64, error)
    IncrementSweepHit(ctx context.Context, key string, window time.Duration) (int64, error)
    GetSweepHitCount(ctx context.Context, key string) (int64, error)
    TryAcquireRefresh(ctx context.Context, key string, ttl time.Duration) (bool, error)
    ReleaseRefresh(ctx context.Context, key string)
    ExpiryCandidates(ctx context.Context, until time.Time, limit int) ([]ExpiryCandidate, error)
    RemoveFromIndex(ctx context.Context, key string)
    DeleteCacheKey(ctx context.Context, key string)
    ClearCache(ctx context.Context) error
    GetCacheStats() CacheStats
    Close() error
}
```

Ensure `*RedisCache` implements this interface. Update `Resolver` to accept `DNSCache` instead of `*RedisCache`.

**Benefits:**
- Easier unit testing with mock/in-memory cache
- Potential for alternate backends (e.g., memcached) without resolver changes
- Aligns with existing interface usage (querystore, requestlog)

---

### 3. Modularize main.go Startup (Medium Priority)

**Current state:** `main.go` performs all setup sequentially: config, error buffer, webhooks, request log, query store, cache, blocklist, resolver, control server, DoH/DoT, sync, DNS servers. The file is ~700 lines.

**Recommendation:** Extract a `bootstrap` or `server` package that wires components. Alternatively, use a `Server` struct that holds dependencies and has `Start()` / `Shutdown()` methods.

**Proposed structure:**
```
cmd/beyond-ads-dns/
  main.go         # Flag parsing, subcommands, minimal orchestration
  bootstrap.go    # Load config, create components, wire dependencies (or internal/server)
```

**Benefits:**
- Clearer separation between CLI concerns and server lifecycle
- Easier to test startup logic
- Reduces cognitive load when reading main.go

---

### 4. Split Web Server Routes into Modules (Medium Priority)

**Current state:** `web/server/src/index.js` is ~3000+ lines with 50+ route handlers defined inline.

**Recommendation:** Extract route handlers into modules by domain:

```
web/server/src/
  index.js           # App setup, middleware, route registration
  routes/
    auth.js          # /api/auth/*
    config.js        # /api/config, /api/system/config
    queries.js       # /api/queries/*
    blocklists.js    # /api/blocklists/*
    cache.js         # /api/cache/*
    sync.js          # /api/sync/*
    dns.js           # /api/dns/*
    errors.js        # /api/errors/*
    webhooks.js      # /api/webhooks/*
    ...
```

**Benefits:**
- Easier to navigate and maintain
- Enables parallel development
- Reduces merge conflicts

---

### 5. Centralize Config Reload Logic (Medium Priority)

**Current state:** Each control API reload endpoint (blocklists, local-records, upstreams, response, safe-search, client-identification) calls `config.Load(configPath)` and then applies a subset to the relevant manager. This pattern is repeated 6+ times.

**Recommendation:** Introduce a `ConfigReloader` or helper that:
- Loads config once per request
- Applies the appropriate subset to the target component
- Returns a consistent error format

Alternatively, a single `/config/reload` endpoint that accepts a `scope` parameter (e.g., `blocklists`, `upstreams`) could reduce duplication.

**Benefits:**
- DRY principle
- Consistent error handling
- Single place to add reload logging/metrics

---

### 6. Consider Structured Logging (Low Priority)

**Current state:** The project uses `log.Logger` (stdlib) throughout.

**Recommendation:** Consider migrating to `log/slog` (Go 1.21+) for structured logging. This would enable:
- JSON output for production
- Key-value fields (e.g., `query_id`, `qname`, `outcome`)
- Log levels that integrate with observability pipelines

**Benefits:**
- Better observability in production
- Easier log aggregation and filtering
- Aligns with modern Go practices

---

### 7. Reduce Sync Client Coupling (Low Priority)

**Current state:** `sync.Client` depends on concrete types: `*blocklist.Manager`, `*localrecords.Manager`, `*dnsresolver.Resolver`. This is acceptable for a single implementation but limits flexibility.

**Recommendation:** If you anticipate alternate implementations (e.g., different config sources), consider defining small interfaces such as `BlocklistApplicator`, `LocalRecordsApplicator`, `UpstreamConfigApplicator` that the sync client uses. This is optional and can be deferred until needed.

---

### 8. Document API Contract Between Go and Node.js (Low Priority)

**Current state:** The Go control server exposes HTTP endpoints; the Node.js web server proxies to them. The contract (paths, methods, request/response shapes) is implicit.

**Recommendation:** Add an OpenAPI/Swagger spec or a simple markdown doc listing:
- Control API endpoints (Go)
- Expected request/response formats
- Authentication (Bearer token, sync token)

**Benefits:**
- Clear contract for frontend/backend developers
- Easier to detect breaking changes
- Potential for generated clients

---

## Implementation Priority

| Priority | Recommendation                         | Effort | Impact |
|----------|----------------------------------------|--------|--------|
| High     | Extract control server to package      | Medium | High   |
| High     | Introduce cache interface              | Low    | High   |
| Medium   | Modularize main.go startup             | Medium | Medium |
| Medium   | Split web server routes                | Medium | Medium |
| Medium   | Centralize config reload logic         | Low    | Medium |
| Low      | Structured logging (slog)              | Medium | Low    |
| Low      | Reduce sync client coupling            | Low    | Low    |
| Low      | Document API contract                  | Low    | Low    |

---

## Summary

The beyond-ads-dns architecture is sound and production-ready. The recommended changes focus on **modularization** and **interface-based design** to improve maintainability and testability without altering the core DNS resolution logic.

### Implemented (this review)

- **Cache interface** — `internal/cache.DNSCache` interface added; `*RedisCache` implements it; `Resolver` now accepts `DNSCache` instead of `*RedisCache`.
- **Control server extraction** — `internal/control` package created with all HTTP handlers; `main.go` reduced by ~350 lines.
