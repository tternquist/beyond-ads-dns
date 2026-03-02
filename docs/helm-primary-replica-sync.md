## Primary/Replica Sync with Helm (Design Notes)

This document sketches how Helm values could be used to configure **primary/replica sync** for beyond-ads-dns. It is intentionally **design-only** for now – the chart does not yet implement these values.

### Goals

- **Single source of truth** for DNS-affecting config (blocklists, upstreams, client groups, safe search, client identification) on a **primary** instance.
- One or more **replica** instances pull this data from the primary via the existing `/sync/config` API and apply it locally.
- Keep **query_store, cache, server, control** settings local to each instance.

### Existing building blocks (already implemented in Go)

- `config.SyncConfig` with:
  - `role: "primary" | "replica"`
  - `enabled: true | false`
  - `tokens: []SyncToken` (primary; list of replica tokens)
  - `primary_url`, `sync_token`, `sync_interval`, `stats_source_url` (replica).
- Control API on the primary:
  - `GET /sync/config` → `DNSAffectingConfig` (JSON) containing:
    - `upstreams`, `resolver_strategy`, `upstream_timeout`
    - `blocklists` (sources, allow/deny, schedule, health check)
    - `client_groups` (including per-group blocklists + safe search)
    - `client_identification` (enabled + `clients: [{ip, name, group_id}]`)
    - `local_records`
    - `response` (blocked behavior + TTL)
    - `safe_search`.
- Sync client on replicas (`internal/sync.Client`):
  - Periodically pulls `/sync/config` with a sync token.
  - Merges DNS-affecting config into `config-overrides/config.yaml`.
  - Reloads resolver (blocklists, client groups, safe search, client identification, upstreams, local records).

### Proposed Helm values (not yet wired)

Add a `sync` section to chart values:

```yaml
sync:
  enabled: false              # global toggle for sync
  role: primary               # "primary" or "replica"

  # Primary-only fields
  tokens: []                  # list of { id, name } – becomes sync.tokens in config

  # Replica-only fields
  primaryURL: ""              # e.g. "http://beyond-ads-dns.beyond-ads-dns.svc.cluster.local:8081"
  syncToken: ""               # token ID to authenticate with primary
  syncInterval: "60s"         # how often replicas pull /sync/config
```

These values would be translated into the YAML `sync:` block in `config-overrides/config.yaml` (or a ConfigMap) that the Go app already consumes.

### Example: primary release

Helm values for a **primary** release could look like:

```yaml
sync:
  enabled: true
  role: primary
  tokens:
    - id: "replica-1"
      name: "cluster-replica-1"
    - id: "replica-2"
      name: "cluster-replica-2"
```

At runtime, the primary’s merged config would contain:

```yaml
sync:
  enabled: true
  role: primary
  tokens:
    - id: "replica-1"
      name: "cluster-replica-1"
    - id: "replica-2"
      name: "cluster-replica-2"
```

The control server would then:

- Accept `Authorization: Bearer replica-1` or `X-Sync-Token: replica-1`.
- Serve DNS-affecting config via `GET /sync/config` to authenticated replicas.

### Example: replica release

Helm values for a **replica** release could look like:

```yaml
sync:
  enabled: true
  role: replica
  primaryURL: "http://beyond-ads-dns.beyond-ads-dns.svc.cluster.local:8081"
  syncToken: "replica-1"
  syncInterval: "60s"
```

The replica’s merged config would contain:

```yaml
sync:
  enabled: true
  role: replica
  primary_url: "http://beyond-ads-dns.beyond-ads-dns.svc.cluster.local:8081"
  sync_token: "replica-1"
  sync_interval: 60s
```

On startup, the app would:

- Detect `sync.enabled: true` and `sync.role: replica`.
- Start the sync client pointing at `primary_url` using `sync_token`.
- Periodically pull `/sync/config` and apply DNS-affecting config from the primary.

### Open questions / TODOs for future chart work

- **Where to write `sync:` config**:
  - Non-persistent config: extend `config-overrides-cm.yaml`.
  - Persistent config (PVC): likely a small init container that merges Helm-driven `sync:` into the existing `config-overrides/config.yaml` without overwriting user changes.
- **Token management**:
  - Keep token IDs in plain-text values (simple).
  - Or store them in a Secret and template into `config-overrides`.
- **Deployment topology**:
  - One release as primary, separate releases as replicas (recommended).
  - Or explicit values/annotation to mark the “primary” pod when using a single release with multiple pods.

This document is meant as a reference so we can wire the Helm chart to these sync capabilities in a future change, without having to rediscover how the Go-side sync works.

