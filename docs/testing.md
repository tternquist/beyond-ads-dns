# Automated Testing

This document describes all automated tests in beyond-ads-dns: how to run them, what they cover, and where they live.

## Overview

| Test Suite | Framework | Location | Command |
|------------|-----------|----------|---------|
| Go unit tests | `testing` | `internal/*`, `cmd/*` | `go test ./...` |
| Web server tests | Node.js `node:test` | `web/server/test/` | `npm test --prefix web/server` |
| Web client tests | Vitest | `web/client/src/**/*.test.js` | `npm test --prefix web/client` |
| Performance benchmarks | perf-tester + bash | `tools/perf/` | `./tools/perf/benchmark.sh` |

All unit and integration tests run in CI on every push and pull request (see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

---

## Go Unit Tests

**Command:** `go test ./...`

**Location:** Tests live alongside source in `internal/` packages, with filenames ending in `_test.go`.

### Test Packages

| Package | File | Coverage |
|---------|------|----------|
| `cmd/perf-tester` | `main_test.go` | generateNames, shuffle, average, percentile, loadNames, readNamesFile, writeNamesFile |
| `internal/anonymize` | `anonymize_test.go` | IP anonymization (hash, truncate) |
| `internal/blocklist` | `bloom_test.go` | Bloom filter for blocklist lookups |
| | `manager_test.go` | Blocklist manager (IsBlocked, allowlist, denylist, regex) |
| | `parser_test.go` | Blocklist line parsing and normalization |
| `internal/cache` | `lru_test.go` | L0 in-memory LRU cache |
| | `redis_test.go` | Redis cache operations (uses miniredis) |
| `internal/clientid` | `resolver_test.go` | Client ID resolution, ResolveGroup, ApplyConfig with groups |
| `internal/config` | `config_test.go` | Config loading, ClientEntries (map/list format), client_groups, GroupBlocklistConfig (HasCustomBlocklist, GroupBlocklistToConfig) |
| | `override_test.go` | ReadOverrideMap, WriteOverrideMap |
| `internal/dnsresolver` | `resolver_test.go` | DNS resolution logic, ApplyClientIdentificationConfig with groups, per-group blocklist (TestResolverPerGroupBlocklist), blocklist benchmarks |
| `internal/control` | `reload_test.go` | Reload handlers, sync (config/status/stats/replica-stats), client-identification with list format |
| `internal/dohdot` | `server_test.go` | DoH handler (GET/POST, validation, doHResponseWriter) |
| `internal/errorlog` | `buffer_test.go` | Error log buffering |
| | `persistence_test.go` | Error log persistence |
| `internal/metrics` | `metrics_test.go` | Prometheus Init, Registry, Record*, UpdateGauges |
| `internal/localrecords` | `manager_test.go` | Local DNS records management |
| `internal/logging` | `logging_test.go` | ParseLevel, NewLogger, NewDefaultLogger, NewDiscardLogger |
| `internal/requestlog` | `logger_test.go` | Request logging |
| | `daily_writer_test.go` | DailyWriter (date-based log rotation) |
| `internal/sync` | `replicastats_test.go` | ReplicaStatsStore, StoreReplicaStats, GetAllReplicaStats |
| | `primary_test.go` | UpdateTokenLastUsed |
| `internal/querystore` | `exclusion_test.go` | ExclusionFilter (domains, clients, Update) |
| | `clickhouse_test.go` | ClickHouseStore with mock HTTP server |
| `internal/webhook` | `webhook_test.go` | Webhook delivery |

### Running Go Tests

```bash
# Run all Go tests
go test ./...

# Run with verbose output
go test -v ./...

# Run tests for a specific package
go test ./internal/blocklist/...

# Run with race detector
go test -race ./...

# Run with coverage
go test -cover ./...
```

---

## Web Server Tests

**Command:** `npm test --prefix web/server` (or `cd web/server && npm test`)

**Framework:** Node.js built-in test runner (`node --test`)

**Location:** `web/server/test/app.test.js`

### Coverage

The web server tests exercise the Express API and application setup:

- **Static serving**: Index.html fallback from static directory
- **End-to-end rendering**: SPA index.html structure and initial-load APIs (`/api/auth/status`, `/api/info`) reachable
- **Health & info**: `/api/health`, `/api/info`, `/api/system/cpu-count`
- **Query endpoints** (disabled state): `/api/queries/summary`, `/api/queries/latency`, `/api/queries/recent`, `/api/queries/time-series`, `/api/queries/export`
- **Blocklist API**: Read/update config, scheduled pause, health check, validation, apply/stats (control URL required)
- **Config API**: Merge, redact secrets, export (YAML), import
- **System config**: GET/PUT `client_identification` and `client_groups` (including per-group blocklist), legacy map format
- **Auth**: Status when disabled, 401 when enabled and not logged in, login flow

Tests use in-memory session stores and temporary config files; no Redis or ClickHouse required for the test run.

### Running Web Server Tests

```bash
cd web/server
npm install
npm test
```

---

## Web Client Tests

**Command:** `npm test --prefix web/client` (or `cd web/client && npm test`)

**Framework:** [Vitest](https://vitest.dev/) v4

**Location:** `web/client/src/**/*.test.js` (co-located with source)

### Test Files

| File | Coverage |
|------|----------|
| `src/App.test.jsx` | End-to-end rendering: full app bootstrap, navigation to Settings/Blocklists, app shell and page content |
| `src/pages/SettingsPage.test.jsx` | Clear Redis/ClickHouse cache flow: render, confirm dialog, API calls, success/error toasts |
| `src/LoginPage.test.jsx` | Login form, auth flow, error handling |
| `src/components/DomainEditor.test.jsx` | Domain tag editor |
| `src/components/FilterInput.test.jsx` | Filter input component |
| `src/utils/validation.test.js` | Form validation: durations, URLs, DNS names, IPv4/IPv6, blocklist, upstreams, local records, replica sync, response form |
| `src/utils/queryParams.test.js` | Query parameter parsing and serialization |
| `src/utils/format.test.js` | Formatting utilities (numbers, durations, etc.) |

### Running Web Client Tests

```bash
cd web/client
npm install
npm test          # Single run
npm run test:watch  # Watch mode for development
```

---

## Performance Benchmarks

**Command:** `./tools/perf/benchmark.sh` (from repo root or `tools/perf`)

**Prerequisites:** Resolver and control server running (e.g. via Docker Compose). Default: `127.0.0.1:53` (DNS), `http://127.0.0.1:8081` (control).

### Benchmark Suite

The script runs five tests and writes logs to `tools/perf/`:

| Test | Description | Output |
|------|-------------|--------|
| 1. Cold cache | Flush Redis, all queries from upstream | `cold-cache.log` |
| 2. Warm cache | L1 Redis only, no warmup | `warm-cache.log` |
| 3. Hot cache | L0 + L1, with warmup | `hot-cache.log` |
| 4. High concurrency | 200 concurrent queries | `high-concurrency.log` |
| 5. Large dataset | 50k queries | `large-dataset.log` |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RESOLVER` | `127.0.0.1:53` | DNS resolver address |
| `CONTROL_URL` | `http://127.0.0.1:8081` | Control API URL |
| `QUERIES` | `10000` | Queries per test (except Test 5) |
| `CONCURRENCY` | `50` | Concurrent queries |

### Manual perf-tester Usage

```bash
go run ./cmd/perf-tester \
  -resolver 127.0.0.1:53 \
  -control-url http://127.0.0.1:8081 \
  -flush-redis \
  -queries 10000 \
  -concurrency 50
```

See [`tools/perf/README.md`](../tools/perf/README.md) for options (warmup, TCP, custom name lists, etc.).

---

## CI Pipeline

The [CI workflow](../.github/workflows/ci.yml) runs on every push and pull request:

1. **Go tests** (if `go.mod` exists): `go test ./...`
2. **Web server tests**: `npm ci --prefix web/server` then `npm test --prefix web/server`
3. **Web client tests**: `npm ci --prefix web/client` then `npm test --prefix web/client`

Performance benchmarks are **not** run in CI; they require a live resolver and are intended for local or manual runs.

---

## Adding New Tests

- **Go**: Add `*_test.go` in the same package. Use `testing` and table-driven tests where appropriate.
- **Web server**: Add test cases to `web/server/test/app.test.js` using `node:test` and `node:assert/strict`.
- **Web client**: Add `*.test.js` next to the module under test. Use Vitest's `describe`, `it`, and `expect`.
- **Performance**: Extend `tools/perf/benchmark.sh` or add new scripts in `tools/perf/`.
