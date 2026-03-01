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

**ClickHouse and unready status:** With ClickHouse (query store) enabled, the app retries the ClickHouse connection for **up to 2 minutes** before giving up and starting the control server. During that time `/health` is not available, so the pod stays Not Ready. The chart uses a **longer startup probe** when `clickhouse.enabled` is true (2 minutes instead of 90s) so the container is not restarted during that retry. If ClickHouse is unreachable, the app will eventually disable the query store and become ready after the 2-minute retry; ensure your startup probe allows that (default when ClickHouse is enabled: 24 × 5s = 2 min). If your Redis or cluster is slow, increase `probes.startup.failureThreshold` (e.g. `30` for 2.5 minutes).

**"connection refused" on port 8081:** If you see readiness/liveness probe failures with `dial tcp ... 8081: connect: connection refused`, the control server is not up yet (or has crashed). Ensure the release includes the **startupProbe** so Kubernetes does not run readiness/liveness until the app is ready: `kubectl get pod -l app.kubernetes.io/name=beyond-ads-dns -o yaml | grep -A6 startupProbe`. If `startupProbe` is missing, upgrade the Helm release. If the startup probe is present but probes still fail later, the app may have crashed after starting—check `kubectl logs` and `kubectl describe pod` for OOMKilled, Redis errors, or panics.

### Redis dependency

When `redis.enabled` is `true`, the chart installs [Bitnami Redis](https://github.com/bitnami/charts/tree/main/bitnami/redis) as a subchart in standalone mode. Run `helm dependency update` inside the chart directory before installing. You can override subchart settings (e.g. `redis.master.persistence.size`, `redis.auth.enabled`) under the `redis` key in values; if you enable `redis.auth.enabled`, the app receives `REDIS_PASSWORD` from the Bitnami-created secret automatically. The Redis image uses the `latest` tag by default so pulls succeed; set `redis.image.tag` to a specific tag to pin a version.

## Config and admin password

- **Config overrides:** The app writes UI/CLI config to `/app/config-overrides`. Use `config.persistence.enabled: true` (default) so a PVC is created and settings survive restarts.
- **Admin password:** Set `extraEnv` with `UI_PASSWORD` or `ADMIN_PASSWORD`, or use an existing Secret and `extraEnvFrom`. If you rely on the file-based password (set via UI), it is stored under config-overrides—ensure that volume is persistent.

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
