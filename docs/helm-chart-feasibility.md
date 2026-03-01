# Helm Chart Feasibility Evaluation

This document evaluates whether it is feasible to build a Helm chart for beyond-ads-dns and outlines the main design choices and trade-offs.

**Conclusion: Yes, it is feasible.** The application is already containerized, uses environment variables for all critical configuration (Redis, ClickHouse, control URL), and has a clear separation between the app and its dependencies. The main design work is around exposing DNS on port 53 in Kubernetes and optional inclusion of Redis/ClickHouse.

---

## 1. Current Deployment Model

- **Primary:** Docker Compose (see `examples/basic-docker-compose/` and others).
- **Stack:** Single app image (Go DNS resolver + Node.js metrics API), Redis, ClickHouse.
- **Config:** Defaults in image; overrides via `CONFIG_PATH` (file) and env vars (`REDIS_URL`, `CLICKHOUSE_*`, etc.). No Helm or raw Kubernetes manifests exist today; Kubernetes is only mentioned in docs for ephemeral deployments and config persistence.

---

## 2. What a Helm Chart Would Deliver

| Component | Purpose |
|-----------|--------|
| **Deployment or DaemonSet** | Run the app container with correct ports and env |
| **Service(s)** | Expose DNS (53), Metrics UI (80), Control API (8081) |
| **ConfigMap / Secret** | Optional: render `config.yaml` from values; secrets for Redis/ClickHouse/admin password |
| **Redis** | Optional: subchart/dependency or “bring your own” |
| **ClickHouse** | Optional: subchart/dependency + init (schema from `db/clickhouse/init.sql`) |
| **PVCs** | Config-overrides (and admin password file), Redis data, ClickHouse data |
| **Ingress** | Optional: Metrics UI, DoH if used |

---

## 3. Feasibility Factors

### 3.1 Application Readiness

- **Single image:** One image (`ghcr.io/tternquist/beyond-ads-dns`) runs both DNS and Metrics API; no need to split for Helm.
- **Env-driven config:** Redis and ClickHouse are fully configurable via env (`REDIS_URL`/`REDIS_ADDRESS`, `REDIS_PASSWORD`, `REDIS_MODE`, `CLICKHOUSE_*`). The chart can inject these from `values.yaml` and Secrets without shipping a full config file.
- **Config file optional:** The app can run with defaults + env; `CONFIG_PATH` is for user/UI-editable overrides. The chart can either (a) omit a config file and rely on env, or (b) mount a ConfigMap/Secret for `config.yaml` generated from values.
- **Health:** Control server exposes `/health`; readiness/liveness can call it (e.g. via `wget`/HTTP in the container or a sidecar).

So the app is well-suited to a Helm-driven deployment.

### 3.2 DNS Port 53 in Kubernetes

Binding to port 53 (privileged) in Kubernetes is the main deployment constraint:

- **Option A – hostNetwork + DaemonSet**  
  Pods use the node network and bind 53 directly. One resolver per node; clients use node IPs or a load balancer in front of nodes. Fits “DNS on every node” or edge-style deployment.

- **Option B – hostNetwork + Deployment**  
  Single (or fixed replica) deployment with hostNetwork; schedule onto a dedicated node and expose that node’s IP as the DNS server.

- **Option C – NodePort (e.g. 3053)**  
  No hostNetwork; expose DNS via NodePort. Clients use `<node>:3053` or an external LB. Easiest from a security/scheduling perspective but not “port 53” on the node.

- **Option D – LoadBalancer / Ingress (DoH only)**  
  If users only need DoH, the DoH endpoint can be exposed via Ingress; plain DNS (53) still needs one of the options above or a separate setup.

**Recommendation:** The chart should support at least two modes in `values.yaml`, for example:

- `dns.exposeMode: hostNetwork` (DaemonSet or Deployment with hostNetwork)
- `dns.exposeMode: nodePort` (Deployment, Service type NodePort for 53 → 3053 or similar)

Default can be `nodePort` for simplicity; `hostNetwork` for users who need real port 53.

### 3.3 Dependencies: Redis and ClickHouse

- **Redis:** Required for the cache. Chart can:
  - Use a dependency (e.g. Bitnami Redis) with `redis.enabled: true`, or
  - Assume an external Redis and only set `REDIS_URL` / `REDIS_ADDRESS` (and optionally `REDIS_PASSWORD` from a Secret).

- **ClickHouse:** Optional (`query_store.enabled`). If included:
  - Schema must be applied from `db/clickhouse/init.sql` (init Job or init container that runs before the app).
  - Credentials and URL can be passed via env/Secret; chart can depend on Bitnami ClickHouse or allow external ClickHouse.

Making both Redis and ClickHouse optional (enable/disable + external URL override) keeps the chart usable in minimal and “bring your own” setups.

### 3.4 Config and Admin Password Persistence

- **Config overrides:** The app writes user/UI config to `CONFIG_PATH` (e.g. `/app/config-overrides/config.yaml`). In K8s this should be a writable volume. Options:
  - **PVC:** Recommended so blocklist changes and UI settings survive pod restarts.
  - **ConfigMap (read-only):** Only if no UI/CLI writes to config; otherwise use PVC or an init container that copies ConfigMap into an emptyDir and app mounts that (writes lost on restart unless synced elsewhere).

- **Admin password:** Same as today: either env (`UI_PASSWORD` / `ADMIN_PASSWORD`) or file (`ADMIN_PASSWORD_FILE`). File-based must be on a persistent volume (see [Initial setup](docs/initial-password-setup-proposal.md) and README). The chart should document that a PVC (or a volume that persists across restarts) is required if using file-based auth and config writes.

### 3.5 Multi-Instance Sync

The app supports primary/replica sync. The chart can expose values such as:

- `sync.enabled`, `sync.role` (primary/replica)
- `sync.primaryUrl` (for replicas)
- `sync.token` from a Secret

No structural blocker; just wiring values and optionally separate releases for primary vs replicas.

---

## 4. Scope and Effort (Rough)

| Task | Effort | Notes |
|------|--------|--------|
| Chart scaffold (Chart.yaml, values.yaml) | Small | Standard structure |
| App Deployment/DaemonSet + Service(s) | Small | Env from values + optional ConfigMap/Secret |
| DNS exposure (hostNetwork vs NodePort) | Small | Two modes in values + conditional manifests |
| Optional Redis (subchart or dependency) | Small | Bitnami Redis or similar |
| Optional ClickHouse + init.sql Job | Medium | Init Job or init container; document retention/TTL |
| PVCs for config + password | Small | Document persistence requirements |
| Ingress (optional) for UI/DoH | Small | Standard Ingress template |
| Docs (README in chart + link from main README) | Small | Install, values, DNS exposure, persistence |

Overall: **feasible with small-to-moderate effort**, consistent with existing architecture and docs.

---

## 5. Consistency with Repo

- **Architecture:** Matches [code-and-architecture-standards.md](code-and-architecture-standards.md): same app boundary (one container), same dependencies (Redis, optional ClickHouse).
- **Config:** Aligns with existing env-based config and [redis-password-setup.md](redis-password-setup.md) (e.g. `REDIS_PASSWORD` from Secret).
- **Documentation:** Fits development guidelines (document deployment, persistence, and config); README already mentions K8s for config/password persistence.

---

## 6. Recommendation

- **Proceed with a Helm chart.** Start with:
  - One workload (Deployment with NodePort for DNS by default).
  - Env-based config only (no mandatory config file).
  - Optional Redis and ClickHouse as dependencies or external URLs.
  - Optional PVC for config-overrides and admin password file.
  - Clear values for `dns.exposeMode` (e.g. `nodePort` | `hostNetwork`) and, if `hostNetwork`, optional DaemonSet variant.
- **Document:** DNS port 53 options, config/password persistence, and optional dependencies in the chart README and, if desired, in the main README under a “Kubernetes / Helm” section.

This keeps the chart simple, flexible, and consistent with the rest of the project while leaving room to add Ingress, DaemonSet, and more advanced Redis/ClickHouse topologies later.
