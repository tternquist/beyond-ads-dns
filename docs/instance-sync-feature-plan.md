# Multi-Instance Sync Feature Plan

## Overview

This document outlines a feature to keep multiple instances of Beyond Ads DNS in sync: **one primary instance** and **any number of replicas**. Instances connect via API tokens. Replicas receive DNS-affecting configuration from the primary but may have independent tuning settings.

---

## 1. Architecture

### 1.1 Roles

| Role | Description |
|------|-------------|
| **Primary** | Source of truth for DNS-affecting config. Manages tokens, replicas, sync settings. Can modify all settings. |
| **Replica** | Receives synced config from primary. Cannot modify DNS-affecting settings. Can tune refresh, query store, etc. locally. |

### 1.2 Sync Flow

```
┌─────────────────┐                    ┌─────────────────┐
│     Primary      │  ←── API token ──   │    Replica A    │
│  (source of      │                    │  (pulls config) │
│   truth)         │  ←── API token ──   │    Replica B    │
└─────────────────┘                    └─────────────────┘
        │
        │  Push or Pull?
        │  - Pull: Replicas poll primary periodically
        │  - Push: Primary pushes on change (requires replica callback URLs)
        │  Recommended: Pull (simpler, works behind NAT/firewalls)
```

**Recommended: Pull model** — Replicas poll the primary at a configurable interval. Simpler, no callback URLs, works when replicas are behind NAT.

---

## 2. Configuration Classification

### 2.1 DNS-Affecting (Client Functionality) — Primary Only

These settings directly affect DNS resolution and client behavior. **Replicas cannot modify them**; they are synced from the primary.

| Config Section | Fields | UI Location |
|----------------|--------|-------------|
| `blocklists` | `refresh_interval`, `sources`, `allowlist`, `denylist` | Blocklists tab |
| `upstreams` | `upstreams`, `resolver_strategy` | DNS Settings → Upstream Resolvers |
| `local_records` | `local_records` | DNS Settings → Local DNS Records |
| `response` | `blocked`, `blocked_ttl` | Config (no dedicated UI today) |
| Blocklist control | Pause/resume | Overview → Blocking Control (per instance) |

### 2.2 Tuning (Replica-Configurable)

Replicas may override these for local optimization. Primary sync does not overwrite them.

| Config Section | Fields | Notes |
|----------------|--------|-------|
| `cache.refresh` | `enabled`, `hit_window`, `hot_threshold`, `min_ttl`, `hot_ttl`, `serve_stale`, `stale_ttl`, `lock_ttl`, `max_inflight`, `sweep_interval`, `sweep_window`, `max_batch_size`, `sweep_min_hits`, `sweep_hit_window`, `batch_stats_window` | Refresh sweeper tuning |
| `query_store` | `enabled`, `flush_to_store_interval`, `flush_to_disk_interval`, `batch_size`, `retention_days` | Query analytics tuning |
| `cache` | `min_ttl`, `max_ttl`, `negative_ttl`, `servfail_backoff`, `respect_source_ttl` | Cache TTL tuning |
| `request_log` | `enabled`, `directory`, `filename_prefix` | Request logging |

---

## 3. API Token Model

### 3.1 Token Storage

- **Primary**: Stores tokens in config or a dedicated store (e.g., `sync_tokens` in override config or Redis).
- **Replica**: Stores `primary_url` and `sync_token` in config.

### 3.2 Token Schema

```yaml
# Primary config (sync section)
sync:
  enabled: true
  tokens:
    - id: "token-abc123"
      name: "Replica A"
      created_at: "2025-02-13T12:00:00Z"
      last_used: "2025-02-13T14:30:00Z"
    - id: "token-def456"
      name: "Replica B"
      ...
```

- **Token ID**: Cryptographically random (e.g., 32 bytes hex). Used as Bearer token.
- **Name**: Human-readable label for the replica (optional).

### 3.3 Authentication

- Primary control API: Accept `Authorization: Bearer <token>` or `X-Auth-Token: <token>` for sync endpoints.
- Replica: Sends token when pulling config from primary.

---

## 4. Sync API Endpoints

### 4.1 Primary (Server)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sync/config` | Sync token | Returns DNS-affecting config (blocklists, upstreams, local_records, response) for replicas to apply |
| GET | `/sync/status` | Sync token | Returns primary identity, last config change timestamp |
| GET | `/sync/instances` | Control token | List registered replicas (from token usage) |

### 4.2 Replica (Client)

- Replica uses `primary_url` + `sync_token` to call `GET /sync/config` on primary.
- Replica merges synced config with local override config (tuning only).
- Replica writes synced DNS-affecting config to its override file, then triggers reloads (blocklists, upstreams, local-records).

---

## 5. Config Merge Strategy (Replica)

When replica receives synced config from primary:

1. **Overwrite** DNS-affecting sections: `blocklists`, `upstreams`, `local_records`, `response`.
2. **Preserve** tuning sections: `cache.refresh`, `query_store`, `cache` (TTLs), `request_log`.
3. **Preserve** instance-specific: `server.listen`, `control`, `ui.hostname`, `sync` (replica's own sync config).

```yaml
# Replica override (after merge)
# Synced from primary (read-only in UI):
blocklists: { ... }
upstreams: [ ... ]
local_records: [ ... ]
response: { ... }

# Local tuning (editable in UI):
cache:
  refresh: { ... }  # Replica-specific
query_store:
  enabled: true
  flush_to_store_interval: "5m"
  flush_to_disk_interval: "5m"
  retention_days: 14  # Replica may want longer retention
```

---

## 6. UI Changes

### 6.1 New Tab: Sync / Instances

**Primary view:**

- **Instance role**: Badge "Primary" or "Replica"
- **Sync tokens** (primary only):
  - List tokens with name, created, last used
  - Create token (generates ID, copy to clipboard)
  - Revoke token
- **Replicas** (primary only):
  - List replicas that have pulled config (from token usage / heartbeat)
  - Status: last sync time, version/config hash
- **Sync settings** (replica only):
  - Primary URL (e.g., `http://primary:8081`)
  - Sync token (masked input)
  - Sync interval (e.g., 60s, 5m)
  - Last sync time, last error

### 6.2 DNS Settings Tab — Replica Behavior

When instance is a **replica**:

- **Upstream Resolvers**: Read-only. Show "Synced from primary" badge. Hide Save/Apply.
- **Local DNS Records**: Read-only. Same treatment.
- **Blocklists tab**: Read-only. Same treatment.
- **Blocking Control** (pause/resume): Configurable per instance; each replica can independently pause/resume blocking.

### 6.3 Tuning Section (Replica)

When instance is a **replica**, add or expose:

- **Cache & Refresh** tuning (cache.refresh, cache TTLs)
- **Query Store** tuning (enabled, flush_to_store_interval, flush_to_disk_interval, retention_days)
- **Request Log** tuning

These can live in a new "Tuning" sub-tab or be moved from Config into a dedicated tab.

### 6.4 Config Tab

- **Primary**: Full config import/export, restart.
- **Replica**: Export shows merged config. Import restricted to tuning sections only (or disabled for DNS-affecting sections).

---

## 7. Implementation Phases

### Phase 1: Config & Sync Core

1. **Config schema**
   - Add `sync` section to config:
     - `role`: `primary` | `replica`
     - `tokens` (primary): list of `{id, name, created_at, last_used}`
     - `primary_url`, `sync_token`, `sync_interval` (replica)
2. **Sync API (primary)**
   - `GET /sync/config` — returns DNS-affecting config
   - `GET /sync/status` — returns primary info + config hash/version
   - Token validation middleware for sync endpoints
3. **Sync client (replica)**
   - Background goroutine: poll primary at `sync_interval`, fetch config, merge, write override, trigger reloads

### Phase 2: Web Server & UI

4. **Web server**
   - `GET /api/sync/status` — instance role, sync state
   - `GET /api/sync/tokens` (primary) — list tokens
   - `POST /api/sync/tokens` (primary) — create token
   - `DELETE /api/sync/tokens/:id` (primary) — revoke token
   - `GET /api/sync/replicas` (primary) — list replicas (from token usage)
   - `PUT /api/sync/settings` (replica) — update primary_url, token, interval
5. **UI**
   - New "Sync" tab with role-specific views
   - Replica: read-only DNS Settings, Blocklists; Blocking Control configurable per instance
   - Replica: Tuning section for cache/query store

### Phase 3: Polish

6. **Config hash/version** — detect when primary config changed, reduce unnecessary reloads
7. **Replica heartbeat** — optional `POST /sync/heartbeat` so primary can show replica status
8. **Conflict handling** — if replica has local DNS-affecting overrides, warn on first sync (or overwrite with clear log)

---

## 8. Security Considerations

- **Token storage**: Tokens stored in config override file. Ensure file permissions (e.g., 0600) and avoid committing to version control.
- **TLS**: Recommend HTTPS for `primary_url` in production.
- **Token scope**: Sync tokens only allow `GET /sync/*`. Control token remains separate for admin operations.
- **Rate limiting**: Consider rate limits on `/sync/config` to prevent abuse.

---

## 9. Example Configurations

### Primary

```yaml
# config/config.yaml (override)
sync:
  role: primary
  enabled: true
  tokens:
    - id: "a1b2c3d4e5f6..."
      name: "Replica A"
```

### Replica

```yaml
# config/config.yaml (override)
sync:
  role: replica
  enabled: true
  primary_url: "http://primary-host:8081"
  sync_token: "a1b2c3d4e5f6..."
  sync_interval: "60s"

# Local tuning (not overwritten by sync)
query_store:
  retention_days: 14
cache:
  refresh:
    sweep_interval: "20s"
```

---

## 10. Open Questions

1. **Config versioning**: Use hash of DNS-affecting config for change detection?
2. **Replica registration**: Should replicas register with primary (POST) to get a name, or is token name sufficient?
3. **Failover**: If primary is down, should replicas continue with last synced config (yes) or enter a degraded mode?
4. **Multi-primary**: Out of scope for v1; single primary only.

---

## 11. Files to Modify

| Component | Files |
|-----------|-------|
| Config | `internal/config/config.go`, `config/config.example.yaml` |
| Go control server | `cmd/beyond-ads-dns/main.go` (sync endpoints) |
| Sync client | New `internal/sync/client.go` (replica pull loop) |
| Web server | `web/server/src/index.js` (sync API routes) |
| Web client | `web/client/src/App.jsx` (Sync tab, replica read-only logic) |
| Docs | `README.md`, `docs/` |

---

*Document created: 2025-02-13*
