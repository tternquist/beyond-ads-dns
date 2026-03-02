# beyond-ads-dns Helm Chart

Deploy the [beyond-ads-dns](https://github.com/tternquist/beyond-ads-dns) ad-blocking DNS resolver on Kubernetes.

## Prerequisites

- Kubernetes 1.19+
- Helm 3+
- Redis (required for the DNS cache). Either:
  - **Install automatically:** set `redis.enabled: true` (Bitnami Redis is installed as a subchart), or
  - **Use external Redis:** set `redis.url` to your Redis address (e.g. `redis://redis.default.svc.cluster.local:6379`).
- Optional: ClickHouse for query store (set `clickhouse.enabled: true` and provide `clickhouse.url`).

## Install

**If you use `redis.enabled: true`**, fetch the Redis dependency first:

```bash
cd helm/beyond-ads-dns && helm dependency update && cd ../..
```

**Option A – Redis as a dependency (all-in-one):**

```bash
helm install beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.enabled=true
```

If you previously used hostNetwork, the release may still have that stored; then the chart renders a DaemonSet (not a Deployment) and you’ll see no app Deployment. Force the default (NodePort + Deployment):

```bash
helm upgrade beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.enabled=true \
  --set dns.exposeMode=nodePort \
  --set dns.daemonSet=false
```

Then confirm: `kubectl get deployment beyond-ads-dns` and `kubectl get pods -l app.kubernetes.io/name=beyond-ads-dns`.

DNS uses **NodePort** by default (port 30053); use `<node-ip>:30053` for DNS.

**If you see *"didn't have free ports"*:** the workload is likely a DaemonSet (host ports) from an earlier install. Do this once:

1. **Delete the DaemonSet** (if present), then **upgrade with nodePort** so the release no longer uses hostNetwork:
   ```bash
   kubectl delete daemonset beyond-ads-dns --ignore-not-found
   helm upgrade beyond-ads-dns ./helm/beyond-ads-dns \
     --set redis.enabled=true \
     --set dns.exposeMode=nodePort \
     --set dns.daemonSet=false
   ```
   If the DaemonSet still reappears after upgrade, the release’s stored values are still hostNetwork. Do a clean reinstall (step 3).

2. **Confirm only the Deployment exists:**
   ```bash
   kubectl get deployment,daemonset -l app.kubernetes.io/name=beyond-ads-dns
   ```
   You should see only a Deployment, no DaemonSet.

3. **Optional clean slate:** uninstall and reinstall so the release has no old values:
   ```bash
   helm uninstall beyond-ads-dns
   helm install beyond-ads-dns ./helm/beyond-ads-dns --set redis.enabled=true
   ```

**Option B – External Redis:**

```bash
helm install beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.url=redis://your-redis-host:6379

# With config persistence and optional overrides
helm install beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.url=redis://redis.default.svc.cluster.local:6379 \
  --set config.persistence.enabled=true \
  --set extraEnv[0].name=HOSTNAME --set extraEnv[0].value=dns.example.com
```

## DNS exposure

The chart supports two ways to expose DNS (port 53):

| Mode | Values | Use case |
|------|--------|----------|
| **nodePort** (default) | `dns.exposeMode: nodePort`, `dns.nodePort: 30053` | DNS is reachable at `<node-ip>:30053`. No hostNetwork. Port must be in 30000–32767. |
| **hostNetwork** | `dns.exposeMode: hostNetwork` | Pod binds port 53 on the node. Set `dns.daemonSet: true` for one resolver per node. |

Example: use real port 53 on every node with a DaemonSet:

```bash
helm install beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.url=redis://redis:6379 \
  --set dns.exposeMode=hostNetwork \
  --set dns.daemonSet=true
```

## Exposing metrics UI and control API (MetalLB)

To expose the **metrics UI** (port 80) and **control server** (port 8081) via MetalLB (or any LoadBalancer), set the service type to `LoadBalancer`:

```bash
helm upgrade beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.enabled=true \
  --set service.type=LoadBalancer
```

MetalLB will assign an external IP to the service. Then use:

- **Metrics UI:** `http://<EXTERNAL-IP>/`
- **Control API (e.g. /health):** `http://<EXTERNAL-IP>:8081/health`

Check the assigned IP: `kubectl get svc beyond-ads-dns` (see the `EXTERNAL-IP` column).

**Optional – MetalLB annotations** (e.g. request a specific pool or IP) via `service.annotations`:

```yaml
service:
  type: LoadBalancer
  annotations:
    metallb.universe.tf/address-pool: production
  # or to request a specific IP (if your MetalLB supports it):
  # annotations:
  #   metallb.universe.tf/loadBalancerIPs: 192.168.1.100
```

DNS (port 53) remains available via NodePort at `<node-ip>:30053` when `dns.exposeMode` is `nodePort`.

## Configuration

| Value | Description | Default |
|-------|-------------|---------|
| `image.repository` | App image | `ghcr.io/tternquist/beyond-ads-dns` |
| `image.tag` | Image tag | `stable` |
| `redis.enabled` | Install Bitnami Redis as a subchart | `false` |
| `redis.url` | Redis URL when not using the dependency | `redis://beyond-ads-dns-redis:6379` |
| `redis.architecture` | Subchart: `standalone` or `replication` | `standalone` |
| `redis.auth.enabled` | Subchart: enable Redis auth (set `REDIS_PASSWORD` from secret) | `false` |
| `redis.master.persistence.*` | Subchart: persistence size, etc. | `512Mi` |
| `clickhouse.enabled` | Enable query store (ClickHouse) | `false` |
| `clickhouse.url` | ClickHouse HTTP URL | `http://clickhouse:8123` |
| `clickhouse.runInitJob` | Run a one-off Job to create DB/table | `false` |
| `config.persistence.enabled` | Persist config-overrides (and admin password file) | `true` |
| `config.persistence.size` | PVC size | `1Gi` |
| `extraEnv` | Extra env vars (e.g. `HOSTNAME`, `UI_PASSWORD`) | `[]` |
| `extraEnvFrom` | Env from Secrets | `[]` |
| `probes.startup.enabled` | Use a startupProbe so the pod isn't killed while Redis/control server start | `true` |
| `probes.startup.failureThreshold` | Startup probe attempts before fail (× periodSeconds = max startup time) | `18` (90s) |
| `ingress.enabled` | Create Ingress for Metrics UI | `false` |

See [values.yaml](values.yaml) for all options.

### CrashLoopBackOff / "Terminated with: Completed"

If the pod shows **CrashLoopBackOff** and the container's last state is **Terminated with: Completed**, the app is being killed by the **liveness probe** before it is ready. The app must connect to Redis and start the control server (port 8081) before `/health` succeeds. The chart enables a **startupProbe** by default so Kubernetes does not run liveness until the app has had time to become ready.

**ClickHouse and unready status:** With ClickHouse (query store) enabled, the app retries the ClickHouse connection for **up to 2 minutes** before giving up and starting the control server. During that time `/health` is not available, so the pod stays Not Ready. The chart uses a **longer startup probe** when `clickhouse.enabled` is true (`failureThreshold: 30` → 2.5 min) so the container is not restarted during that retry. If ClickHouse is unreachable, the app will eventually disable the query store and become ready; ensure your startup probe allows that. Without ClickHouse, the default is `failureThreshold: 24` (2 min). If your Redis or cluster is slow, increase `probes.startup.failureThreshold` further.

**"connection refused" on port 8081 (startup probe):** The app binds the control server (port 8081) only after it has connected to Redis (and, if enabled, after the ClickHouse retry window). When **`redis.enabled` is true**, the chart runs a **wait-for-redis** init container so Redis is ready before the app starts, which usually prevents this. When using **external Redis** (`redis.enabled: false`), the app may need 10–30+ seconds to reach Redis; if the startup probe still fails, increase `probes.startup.initialDelaySeconds` (e.g. `25`) or `probes.startup.failureThreshold`. Defaults: `initialDelaySeconds: 10`, `failureThreshold: 24` without ClickHouse (2 min window) or `30` with ClickHouse (2.5 min). If the probe keeps failing, check Redis reachability and app logs: `kubectl logs -l app.kubernetes.io/name=beyond-ads-dns -c beyond-ads-dns`.

### Redis dependency

When `redis.enabled` is `true`, the chart installs [Bitnami Redis](https://github.com/bitnami/charts/tree/main/bitnami/redis) as a subchart in standalone mode. An init container **wait-for-redis** runs before the app and blocks until Redis accepts connections, so the app connects quickly and the startup probe (port 8081) usually succeeds. Run `helm dependency update` inside the chart directory before installing. You can override subchart settings (e.g. `redis.master.persistence.size`, `redis.auth.enabled`) under the `redis` key in values; if you enable `redis.auth.enabled`, the app receives `REDIS_PASSWORD` from the Bitnami-created secret automatically. The Redis image uses the `latest` tag by default so pulls succeed; set `redis.image.tag` to a specific tag to pin a version.

## Config and admin password

- **Config overrides:** The app writes UI/CLI config to `/app/config-overrides`. Use `config.persistence.enabled: true` (default) so a PVC is created and settings survive restarts.
- **Admin password:** Set `extraEnv` with `UI_PASSWORD` or `ADMIN_PASSWORD`, or use an existing Secret and `extraEnvFrom`. If you rely on the file-based password (set via UI), it is stored under config-overrides—ensure that volume is persistent.

## ClickHouse disabled (default)

ClickHouse is **disabled by default** (`clickhouse.enabled: false`). The chart (1) sets `CLICKHOUSE_ENABLED=false` (emitted last so `extraEnv` cannot override) and (2) when **config persistence is on**, runs an **init container** that patches the persisted `config.yaml` to set `query_store.enabled: false` so the app does not wait for ClickHouse even if the file was previously saved with the query store on. If you still see "clickhouse unreachable at startup", verify the env in the pod: `kubectl exec deploy/beyond-ads-dns -- printenv CLICKHOUSE_ENABLED` (should print `false`) and that the init ran: `kubectl describe pod -l app.kubernetes.io/name=beyond-ads-dns` (look for init container `patch-query-store-disabled`).

## ClickHouse init

When using an external ClickHouse and you need the schema created automatically:

1. Set `clickhouse.enabled: true`, `clickhouse.url`, and `clickhouse.runInitJob: true`.
2. The chart runs a pre-install/pre-upgrade hook Job that creates the `beyond_ads` database and `dns_queries` table (see [db/clickhouse/init.sql](https://github.com/tternquist/beyond-ads-dns/blob/main/db/clickhouse/init.sql)).

If your ClickHouse requires authentication, create a Secret with the password and set `clickhouse.existingSecret` and `clickhouse.passwordSecretKey`. The init Job does not currently pass credentials to the HTTP interface; for authenticated ClickHouse, run the schema manually or use an image that supports it.

## Uninstall

```bash
helm uninstall beyond-ads-dns
```

If you used config persistence, the PVC is retained. Delete it explicitly if desired:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=beyond-ads-dns
```

## Design notes

See [docs/helm-chart-feasibility.md](https://github.com/tternquist/beyond-ads-dns/blob/main/docs/helm-chart-feasibility.md) in the main repository for design rationale and options.
