# Control API Reference

The Go control server exposes HTTP endpoints for managing the DNS resolver. The Node.js web server proxies to these endpoints. This document describes the contract between the Go backend and Node.js frontend.

## Base URL

The control server listens on the address configured in `control.listen` (default: `0.0.0.0:8081`). The Node.js server uses `DNS_CONTROL_URL` to reach it.

## Authentication

When `control.token` is set, protected endpoints require one of:

- **Bearer token**: `Authorization: Bearer <token>`
- **X-Auth-Token header**: `X-Auth-Token: <token>`

Sync endpoints use a separate sync token (from `sync.tokens`) via `Authorization: Bearer <sync_token>` or `X-Sync-Token: <sync_token>`.

## Endpoints

### Health & Debug

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check. Returns `{"ok": true}`. |
| GET | `/errors` | Token | Application error log entries. |
| GET | `/trace-events` | Token | Trace events enabled for runtime logging. Returns `{"events": [...], "all_events": [...]}`. |
| PUT | `/trace-events` | Token | Update trace events. Body: `{"events": ["refresh_upstream", "query_resolution", "upstream_exchange", ...]}`. Applies immediately without restart. |
| GET | `/metrics` | No | Prometheus metrics. |
| GET | `/debug/pprof/*` | No | Go pprof profiling endpoints. |

### Blocklists

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/blocklists/reload` | Token | - | `{"ok": true}` or `{"error": "..."}` |
| GET | `/blocklists/stats` | Token | - | `{"blocked": n, "allow": n, "deny": n}` |
| GET | `/blocklists/health` | Token | - | `{"sources": [...], "enabled": bool}` |
| POST | `/blocklists/pause` | Token | `{"duration_minutes": 1-1440}` | `{"paused": bool, "until": "..."}` |
| POST | `/blocklists/resume` | Token | - | `{"paused": false}` |
| GET | `/blocklists/pause/status` | Token | - | `{"paused": bool, "until": "..."}` |
| GET | `/blocked/check` | No | `?domain=<name>` | `{"blocked": bool}` |

### Cache

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| GET | `/cache/stats` | Token | - | Cache statistics object |
| GET | `/cache/refresh/stats` | Token | - | Refresh sweeper statistics |
| POST | `/cache/clear` | Token | - | `{"ok": true}` or `{"error": "..."}` |

### Query Store

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/querystore/stats` | Token | Query store statistics object |

### Local Records

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/local-records/reload` | Token | - | `{"ok": true}` or `{"error": "..."}` |

### Upstreams

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| GET | `/upstreams` | Token | - | `{"upstreams": [...], "resolver_strategy": "..."}` |
| POST | `/upstreams/reload` | Token | - | `{"ok": true}` or `{"error": "..."}` |

### Response Config

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/response/reload` | Token | - | `{"ok": true}` or `{"error": "..."}` |

### Safe Search

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/safe-search/reload` | Token | - | `{"ok": true}` or `{"error": "..."}` |

### Client Identification

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/client-identification/reload` | Token | - | `{"ok": true}` or `{"error": "..."}` |

Reloads client IP → name mappings and group assignments from config. Also applies per-group blocklists (Phase 3). Config supports:
- **List format**: `clients: [{ ip, name, group_id }]` with optional `client_groups: [{ id, name, description, blocklist? }]`
- **Legacy map format**: `clients: { "ip": "name" }` (no groups)

Each group's `blocklist` can have `inherit_global` (true = use global blocklist; false = use group's own sources/allowlist/denylist).

See [Clients and Groups](clients-and-groups.md) for full documentation.

### Sync (Primary/Replica)

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| GET | `/sync/config` | Sync token | - | DNS-affecting config (for replicas) |
| GET | `/sync/status` | Sync token | - | `{"role": "primary", "ok": true}` |
| POST | `/sync/stats` | Sync token | Replica stats JSON body | `{"ok": true}` |
| GET | `/sync/replica-stats` | Token | - | `{"replicas": [...]}` |

## Error Format

On error, endpoints return JSON with an `error` key:

```json
{"error": "human-readable message"}
```

HTTP status codes: `400` (bad request), `401` (unauthorized), `500` (internal server error), `503` (service unavailable for sync when not primary).

## Reload Endpoints

All reload endpoints (`/blocklists/reload`, `/local-records/reload`, `/upstreams/reload`, etc.) follow the same pattern:

1. Load config from `CONFIG_PATH` (or config path passed at startup)
2. Apply the relevant config subset to the target component
3. Return `{"ok": true}` on success or `{"error": "..."}` on failure
