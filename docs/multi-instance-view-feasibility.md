# Multi-Instance View Feasibility Evaluation

## Summary

A multi-instance view from the primary that shows statistics from each configured replica is **feasible** with moderate effort. The main gaps are: (1) the primary does not know replica control API URLs, and (2) there is no aggregation layer for cross-instance stats. This document evaluates options and recommends an approach.

---

## Current Architecture

### Sync Model

- **Primary**: Source of truth for DNS-affecting config. Stores sync tokens (id, name, created_at, last_used). Replicas pull config from primary.
- **Replica**: Pulls config from primary at `sync_interval`. Stores `primary_url` and `sync_token`. Does not register its own URL with the primary.
- **Flow**: One-way only — replica → primary (pull). Primary never initiates requests to replicas.

### Statistics Sources

| Stat Type | Source | Per-Instance? | Notes |
|-----------|--------|---------------|-------|
| Blocklist stats | DNS control API `/blocklists/stats` | Yes | Blocked, allow, deny counts |
| Cache stats | DNS control API `/cache/stats` | Yes | L0/L1 cache, hit rate |
| Refresh stats | DNS control API `/cache/refresh/stats` | Yes | Sweep counts, refreshed 24h |
| Query latency | ClickHouse (via web server) | Depends | Shared DB = aggregated; per-instance DB = per instance |
| Upstream stats | ClickHouse | Depends | Same as above |
| Query time-series | ClickHouse | Depends | Same as above |

### Key Gap

The primary has **no knowledge of replica control API URLs**. Sync tokens only store `id`, `name`, `created_at`, `last_used`. The primary cannot reach replicas to fetch their stats.

---

## Feasibility Assessment

### Option A: Primary Pulls from Replica Control APIs

**Approach**: Primary stores replica control URLs (e.g., per token or in a separate config). Primary fetches stats from each replica's control API.

**Requirements**:
- Extend config: add `replica_url` or `control_url` to sync token schema (or a separate `replicas` list).
- Primary must have network access to each replica's control API (typically `http://replica-host:8081`).
- Replica control API must be reachable from primary (not behind NAT/firewall blocking inbound).

**Pros**:
- Simple mental model: primary "pulls" stats like replicas pull config.
- Real-time stats on demand.
- Reuses existing control API endpoints.

**Cons**:
- Replicas behind NAT cannot expose control API to primary.
- Admin must manually configure replica URLs.
- Each replica may require control token; primary needs to store credentials per replica.

**Feasibility**: ✅ Feasible when replicas are reachable from primary (e.g., same network, VPN, or public IPs).

---

### Option B: Replica Heartbeat with URL Registration

**Approach**: Implement `POST /sync/heartbeat` on primary. When a replica pulls config, it also sends a heartbeat with its control URL. Primary stores `token_id → control_url` and uses that to fetch stats.

**Requirements**:
- New endpoint: `POST /sync/heartbeat` (or extend `/sync/config` response handling).
- Replica sends `control_url` in heartbeat body.
- Same network reachability as Option A.

**Pros**:
- Automatic discovery of replica URLs.
- Aligns with feature plan Phase 3: "Replica heartbeat — optional POST /sync/heartbeat so primary can show replica status."

**Cons**:
- Replica must know its own externally reachable URL (non-trivial in Docker/K8s).
- Still requires primary → replica connectivity.

**Feasibility**: ✅ Feasible; adds discovery but does not solve NAT/firewall issues.

---

### Option C: Replica Push Stats to Primary

**Approach**: Replicas push their stats to the primary (e.g., in sync request or separate `POST /sync/stats`). Primary stores and serves aggregated view.

**Requirements**:
- New endpoint on primary: `POST /sync/stats` (replica pushes blocklist/cache/refresh stats).
- Primary stores last-known stats per token/replica.
- No primary → replica connection needed.

**Pros**:
- Works when replicas are behind NAT (replicas already reach primary for config pull).
- No need to expose replica control API.
- Stats updated on each sync cycle.

**Cons**:
- Stats are delayed by sync interval (e.g., 60s).
- Primary must implement storage (in-memory or config) for replica stats.
- Query stats (ClickHouse) still need separate handling.

**Feasibility**: ✅ Feasible and robust for NAT/firewall scenarios.

---

### Option D: Shared ClickHouse with instance_id

**Approach**: If all instances use the same ClickHouse, add `instance_id` (or `instance_name`) to query events. Primary aggregates query stats by instance from ClickHouse.

**Requirements**:
- Schema change: add `instance_id` column to query table.
- Config: each instance sets its instance_id (e.g., hostname, replica name).
- All instances point to same ClickHouse.

**Pros**:
- Query stats (latency, upstream, time-series) can be aggregated by instance without primary calling replicas.
- Single source of truth for query analytics.

**Cons**:
- Does not cover blocklist, cache, or refresh stats (those come from control API).
- Requires ClickHouse schema migration and config change.
- Not applicable if each instance uses its own ClickHouse.

**Feasibility**: ✅ Feasible when shared ClickHouse is used; complements Options A–C for query stats.

---

## Recommended Approach

**Hybrid: Option C (push) + Option D (shared ClickHouse)**

1. **Replica push for control-plane stats** (blocklist, cache, refresh):
   - Extend sync client to push stats when it pulls config (or on a separate timer).
   - Primary stores last stats per token in memory (or lightweight store).
   - New API: `GET /api/instances/stats` returns primary + all replicas.

2. **Shared ClickHouse for query stats** (optional enhancement):
   - Add `instance_id` to query schema; each instance identifies itself.
   - Primary's existing ClickHouse queries can filter/group by instance.
   - UI shows per-instance query charts when instance_id is present.

3. **Replica URL for pull-based stats** (optional fallback):
   - Allow optional `control_url` per token for primary to pull stats when replicas are reachable.
   - Use push when URL not set or pull fails.

---

## Implementation Effort Estimate

| Component | Effort | Description |
|-----------|--------|-------------|
| Sync client: push stats on pull | Low | Add stats fetch + POST to primary in sync loop |
| Primary: `POST /sync/stats` endpoint | Low | Validate token, store stats keyed by token |
| Primary: in-memory replica stats store | Low | Map token_id → { name, last_stats, last_updated } |
| Web API: `GET /api/instances/stats` | Low | Aggregate primary (from control) + replicas (from store) |
| UI: Multi-instance stats view | Medium | New tab or section: instance selector, per-instance blocks |
| ClickHouse: instance_id (optional) | Medium | Schema migration, config, query updates |
| Replica URL config (optional pull) | Low | Add control_url to token schema, primary fetch logic |

**Total**: ~2–4 days for push-based approach without ClickHouse changes; +1–2 days for instance_id in ClickHouse.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Replica stats stale (sync interval) | Show "last updated" timestamp; consider shorter sync interval for stats-only heartbeat |
| Primary restart loses in-memory stats | Persist to Redis or config; or accept cold-start empty state |
| Many replicas → slow aggregation | Fetch in parallel; cache response briefly (e.g., 30s) |
| Auth for replica control API (pull model) | Store optional control token per replica; use in fetch headers |

---

## Conclusion

A multi-instance view is **feasible** with the push-based approach (Option C), which works regardless of network topology. The primary already has the sync framework and token model; adding a stats push and aggregation layer is a natural extension. Query stats can be enhanced later with `instance_id` in ClickHouse when a shared database is used.
