## Primary/Replica Sync with Helm

This document describes how Helm values configure **primary/replica sync** for beyond-ads-dns, and how to use the example values files shipped with the chart.

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

### Helm values for sync

The chart exposes a `sync` section in `values.yaml`:

```yaml
sync:
  enabled: false              # global toggle for sync
  role: primary               # "primary" or "replica"

  # Primary-only fields
  tokens: []                  # list of { id, name } – becomes sync.tokens in config

  # Replica-only fields
  primaryURL: ""              # e.g. "http://beyond-ads-dns-primary:8081"
  syncToken: ""               # token ID to authenticate with primary
  syncInterval: "60s"         # how often replicas pull /sync/config
  statsSourceURL: ""          # optional, used for /sync/stats
```

These values are translated into the YAML `sync:` block in `config-overrides/config.yaml`:

- When `clickhouse.enabled: false` and `config.persistence.enabled: false`, the chart renders a ConfigMap with `query_store.enabled: false` and a `sync:` block.
- When `config.persistence.enabled: true`, an init container `set-sync-config` merges the Helm-driven `sync:` block into `/app/config-overrides/config.yaml` on the PVC without overwriting other user-managed keys.

### Example: primary release

The repo ships an example values file for a **primary** release at `helm/beyond-ads-dns/values-primary.yaml`.

Helm values for a **primary** release look like:

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

Install the primary:

```bash
cd /home/tom/projects/beyond-ads-dns
helm upgrade --install beyond-ads-dns-primary ./helm/beyond-ads-dns \
  -n beyond-ads-dns --create-namespace \
  -f helm/beyond-ads-dns/values-primary.yaml
```

### Example: replica release

The repo ships an example values file for a **replica** release at `helm/beyond-ads-dns/values-replica.yaml`.

Helm values for a **replica** release look like:

```yaml
sync:
  enabled: true
  role: replica
  primaryURL: "http://beyond-ads-dns.beyond-ads-dns.svc.cluster.local:8081"
  syncToken: "replica-1"
  syncInterval: "60s"
```

Install the replica:

```bash
cd /home/tom/projects/beyond-ads-dns
helm upgrade --install beyond-ads-dns-replica ./helm/beyond-ads-dns \
  -n beyond-ads-dns \
  -f helm/beyond-ads-dns/values-replica.yaml
```

The replica’s merged config (in `config-overrides/config.yaml`) will contain:

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

### Deployment topology

- **Recommended:** One Helm release as primary, separate Helm releases as replicas (e.g. `beyond-ads-dns-primary` + `beyond-ads-dns-replica`), using the example values files as a starting point.
- **Primary-only:** Use `values-primary.yaml` (or equivalent) with `sync.enabled: true`, `sync.role: primary` and simply omit any replica releases.

### Example with LoadBalancer (MetalLB)

To expose DNS and the Metrics UI / control API through a LoadBalancer (for example MetalLB) in front of a primary or replica release:

1. Use the appropriate sync values file:
   - `helm/beyond-ads-dns/values-primary.yaml` for the primary release.
   - `helm/beyond-ads-dns/values-replica.yaml` for replica releases.

2. Layer on the LoadBalancer overlay:

   ```bash
   # Primary with LoadBalancer
   helm upgrade --install beyond-ads-dns-primary ./helm/beyond-ads-dns \
     -n beyond-ads-dns --create-namespace \
     -f helm/beyond-ads-dns/values-primary.yaml \
     -f helm/beyond-ads-dns/values-loadbalancer.yaml

   # Replica with LoadBalancer
   helm upgrade --install beyond-ads-dns-replica ./helm/beyond-ads-dns \
     -n beyond-ads-dns \
     -f helm/beyond-ads-dns/values-replica.yaml \
     -f helm/beyond-ads-dns/values-loadbalancer.yaml
   ```

This configuration:

- Uses NodePort as the backend (`dns.exposeMode: nodePort`) while the Service is of type `LoadBalancer`.
- Exposes DNS on port 53 (UDP/TCP), Metrics UI on port 80, and control API on port 8081 at the LoadBalancer IP.

See `helm/beyond-ads-dns/values-loadbalancer.yaml` and `helm/beyond-ads-dns/README.md` for LoadBalancer-specific details (including optional MetalLB annotations).

Token IDs can be kept in plain-text values (simple) or moved into Secrets and templated into the `sync.tokens` / `sync.syncToken` fields if needed.

### Rolling upgrades across primary and replicas

Rolling upgrades are handled per release using Kubernetes `RollingUpdate` on the `Deployment`:

- **Primary and replica are independent Deployments.**
  - `beyond-ads-dns-primary` and `beyond-ads-dns-replica` each roll one pod at a time when you run `helm upgrade`.
  - DNS traffic remains available as long as at least one replica release stays healthy (for strict zero‑downtime, run `replicaCount > 1` on the replica release).

- **Upgrade order (recommended):**
  1. **Upgrade the primary** release:
     - Helm creates a new primary pod, waits for `/health`, then terminates the old one.
     - During the brief primary restart, replicas continue serving DNS using their last-synced config; sync pulls just fail temporarily and retry.
  2. **Upgrade the replica** release(s):
     - Each replica pod rolls while the primary remains up and serving `/sync/config`.
     - Replicas keep pulling config as usual; no special coordination is required.

- **Compatibility expectations:**
  - `/sync/config` responses are treated as a versioned contract:
    - New fields should be **additive** so older replicas can ignore them.
    - Removing or renaming fields should be avoided, or done in a way that both old and new versions can tolerate.
  - This allows **mixed-version windows** (new primary + old replicas or vice versa) during rolling upgrades without breaking sync.

When using a LoadBalancer in front of primary/replica Services, the rollout behavior is unchanged: the LoadBalancer continues to route to Ready pods while each Deployment rolls one pod at a time.

