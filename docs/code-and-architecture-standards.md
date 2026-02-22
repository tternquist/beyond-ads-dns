# Code and Architecture Standards

> **Purpose:** This document provides AI agents and human developers with an overview of the beyond-ads-dns architecture, code practices, and conventions. It is designed to be **periodically refreshed** as the codebase evolves. When implementing changes, consult the domain-specific docs referenced below for detailed guidance.

**Last refreshed:** 2025-02-22

---

## 1. Project Overview

**beyond-ads-dns** is an ad-blocking DNS resolver that uses public blocklists (e.g. Hagezi) and Redis caching to reduce upstream traffic. It is performance-optimized and supports multi-instance sync, a Metrics UI, and optional DoH/DoT for encrypted client connections.

**Stack:**
- **Backend:** Go (DNS resolver, control API, query store)
- **Web:** Node.js (Express) + React (Metrics UI)
- **Data:** Redis (cache), ClickHouse (query store)
- **Deployment:** Docker Compose (primary), optional bare-metal

---

## 2. Architecture Summary

### 2.1 High-Level Flow

```
DNS Query → Local Records → Safe Search → Blocklist → L0 Cache → L1 (Redis) → Upstream DNS
                ↓               ↓            ↓           ↓           ↓
            (static)      (rewrite)      (block?)    (hit?)    (hit?)   (fetch)
```

### 2.2 Package Layout (`internal/`)

| Package | Responsibility |
|---------|---------------|
| `dnsresolver` | Core DNS handler, upstream exchange, refresh sweeper, safe search |
| `cache` | Multi-tier caching (ShardedLRU + Redis), hit batching, expiry index |
| `blocklist` | Domain blocking with bloom filters, allowlist/denylist, scheduled pause |
| `config` | YAML config loading, validation, env overrides, deep merge |
| `control` | HTTP control plane (reload, stats, CRUD, sync, pprof, Prometheus) |
| `querystore` | ClickHouse event ingestion with async buffering |
| `localrecords` | Static DNS records |
| `sync` | Multi-instance primary/replica sync |
| `webhook` | Configurable block/error notifications |
| `dohdot` | DoH/DoT server for encrypted client connections |

### 2.3 Caching Architecture

- **L0:** In-memory ShardedLRU (32 shards), ~10–50μs latency
- **L1:** Redis distributed cache, ~0.5–2ms latency
- **Bloom filter:** Fast negative lookups for blocklists (0.1% FPR)
- **Refresh-ahead:** Proactive refresh for hot entries; sweeper for cold entries
- **Stale serving:** Serve expired entries while refreshing in background

See [`docs/performance.md`](performance.md) for tuning and monitoring.

### 2.4 Web Stack

- **Server:** `web/server/` — Express app, route modules (`routes/*`), services (`services/*`), utils (`utils/*`)
- **Client:** `web/client/` — React SPA, pages (`pages/*`), components (`components/*`), hooks (`hooks/*`), utils (`utils/*`)

---

## 3. Code Practices

### 3.1 Development Guidelines (Always Apply)

From `.cursor/rules/development-guidelines.mdc`:

- **Performance:** Consider performance for every change; note and verify regressions
- **Test coverage:** Aim for maximum coverage; add unit and integration tests
- **Documentation:** Update README, API docs, and config docs with changes
- **Backend config & UI:** Expose backend config in the UI when it makes sense

### 3.2 Consistency Review

From `.cursor/rules/consistency-review.mdc`:

- **Evaluate new code** against existing patterns and structure
- **Align architectural decisions** with established design
- **Maintain consistency** in naming, module organization, data flow, error handling, API design
- **Consult docs** in `docs/` before significant changes; follow them unless there is a documented reason to deviate

### 3.3 Backend (Go) Conventions

- **Interfaces:** Use compile-time checks (`var _ DNSCache = (*RedisCache)(nil)`) for testability
- **Concurrency:** `sync.RWMutex` for read-heavy data; `atomic.Value` for snapshot updates; `atomic.Bool` / `atomic.Pointer` for shared flags
- **Timeouts:** Use `context.WithTimeout` on all Redis/ClickHouse operations
- **Graceful degradation:** Stale serving, SERVFAIL backoff, upstream failover, connection pool retry on EOF
- **Config:** Default YAML → override YAML (deep merge) → env overrides

### 3.4 Frontend Conventions

- **API client:** Use `utils/apiClient.js` (`api.get/post/put/del`) instead of raw `fetch`
- **Error handling:** `ErrorBoundary` wraps main content; use structured `ApiError` for API failures
- **Polling:** Use `hooks/useApiPolling.js` for recurring API calls
- **State:** Prefer React Context for cross-cutting concerns; custom hooks for feature state

---

## 4. Testing

| Suite | Command | Location |
|-------|---------|----------|
| Go | `go test ./...` | `internal/*/*_test.go` |
| Web server | `npm test --prefix web/server` | `web/server/test/` |
| Web client | `npm test --prefix web/client` | `web/client/src/**/*.test.js` |
| Performance | `./tools/perf/benchmark.sh` | `tools/perf/` |

See [`docs/testing.md`](testing.md) for coverage, adding tests, and CI.

---

## 5. Error Handling and Logging

- **Error log:** Buffered and exposed via Control API `/errors`; persisted when configured
- **Trace events:** Enable per-query or per-refresh logging via `/trace-events` (no restart)
- **Log levels:** `error`, `warning`, `info`, `debug` (Settings → Application Logging)

See [`docs/errors.md`](errors.md) for known errors and troubleshooting.

---

## 6. Configuration

- **Default:** `config/default.yaml` (baked into image)
- **Override:** `config/config.yaml` (gitignored, user-editable)
- **Env overrides:** `REDIS_ADDRESS`, `REDIS_URL`, `CONFIG_PATH`, etc.
- **Control token:** Required for protected endpoints when `control.token` is set

---

## 7. API Design

- **Control API:** Go server at `control.listen` (default `:8081`); Node.js proxies to it
- **Auth:** Bearer token or `X-Auth-Token` header when token configured
- **Sync:** Separate sync tokens for replica auth

See [`docs/control-api.md`](control-api.md) for endpoint reference.

---

## 8. Documentation Index

| Document | Use When |
|----------|----------|
| [`README.md`](../README.md) | Setup, deployment, config overview |
| [`docs/code-review.md`](code-review.md) | Architecture details, recommendations, resolved/open items |
| [`docs/performance.md`](performance.md) | Caching, tuning, benchmarking |
| [`docs/errors.md`](errors.md) | Error meanings, troubleshooting |
| [`docs/testing.md`](testing.md) | Test locations, adding tests |
| [`docs/control-api.md`](control-api.md) | Control API contract |
| [`docs/clients-and-groups.md`](clients-and-groups.md) | Client identification, groups |
| [`docs/webhooks.md`](webhooks.md) | Webhook configuration |

---

## 9. Refreshing This Document

When refreshing this document:

1. **Update "Last refreshed"** at the top
2. **Review package layout** in §2.2 — add/remove packages as `internal/` changes
3. **Sync code practices** with `.cursor/rules/` and current patterns
4. **Update documentation index** (§8) if new docs are added
5. **Check code-review.md** for new recommendations or resolved items that should be reflected here

---

## 10. Quick Reference for AI Agents

- **Before implementing:** Read this doc + relevant domain docs from §8
- **Naming:** Match existing patterns (e.g. `*Manager`, `*Resolver`, `*Store`)
- **Tests:** Add `*_test.go` (Go) or `*.test.js` (client) alongside new code
- **Performance:** Profile hot paths; avoid unbounded growth (maps, buffers)
- **Security:** Validate config inputs; use env for secrets; rate-limit sensitive endpoints
- **Consistency:** Prefer existing abstractions (e.g. `apiClient`, `ErrorBoundary`) over new ones
