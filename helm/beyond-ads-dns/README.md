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

If you plan to install ClickHouse via the chart (set `clickhouse.enabled: true`), run the same `helm dependency update` so the ClickHouse subchart is fetched.

**Option A – Redis as a dependency (all-in-one):**

```bash
helm install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.enabled=true
```

If you previously used hostNetwork, the release may still have that stored; then the chart renders a DaemonSet (not a Deployment) and you’ll see no app Deployment. Force the default (NodePort + Deployment):

```bash
helm upgrade beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.enabled=true \
  --set dns.exposeMode=nodePort \
  --set dns.daemonSet=false
```

Then confirm: `kubectl get deployment beyond-ads-dns -n beyond-ads-dns` and `kubectl get pods -l app.kubernetes.io/name=beyond-ads-dns -n beyond-ads-dns`.

DNS uses **NodePort** by default (port 30053); use `<node-ip>:30053` for DNS.

**If you see *"didn't have free ports"*:** the workload is likely a DaemonSet (host ports) from an earlier install. Do this once:

1. **Delete the DaemonSet** (if present), then **upgrade with nodePort** so the release no longer uses hostNetwork:
   ```bash
   kubectl delete daemonset beyond-ads-dns -n beyond-ads-dns --ignore-not-found
   helm upgrade beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
     --set redis.enabled=true \
     --set dns.exposeMode=nodePort \
     --set dns.daemonSet=false
   ```
   If the DaemonSet still reappears after upgrade, the release’s stored values are still hostNetwork. Do a clean reinstall (step 3).

2. **Confirm only the Deployment exists:**
   ```bash
   kubectl get deployment,daemonset -l app.kubernetes.io/name=beyond-ads-dns -n beyond-ads-dns
   ```
   You should see only a Deployment, no DaemonSet.

3. **Optional clean slate:** uninstall and reinstall so the release has no old values:
   ```bash
   helm uninstall beyond-ads-dns -n beyond-ads-dns
   helm install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns --set redis.enabled=true
   ```

**Option B – External Redis:**

```bash
helm install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.url=redis://your-redis-host:6379

# With config persistence and optional overrides
helm install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
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
helm install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.url=redis://redis:6379 \
  --set dns.exposeMode=hostNetwork \
  --set dns.daemonSet=true
```

## Exposing metrics UI and control API (MetalLB)

To expose the **metrics UI** (port 80) and **control server** (port 8081) via MetalLB (or any LoadBalancer), set the service type to `LoadBalancer`:

```bash
helm upgrade beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.enabled=true \
  --set service.type=LoadBalancer
```

MetalLB will assign an external IP to the service. Then use:

- **Metrics UI:** `http://<EXTERNAL-IP>/`
- **Control API (e.g. /health):** `http://<EXTERNAL-IP>:8081/health`

Check the assigned IP: `kubectl get svc beyond-ads-dns -n beyond-ads-dns` (see the `EXTERNAL-IP` column).

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

### Example: DNS on port 53 via LoadBalancer (MetalLB)

If your LoadBalancer implementation (e.g. MetalLB) supports **UDP + TCP on port 53**, you can expose DNS on real port 53 directly from the LoadBalancer IP without using `hostNetwork`. The chart already exposes DNS on port 53 on the Service; you only need to:

An example overlay values file is provided at `values-loadbalancer.yaml`:

```yaml
dns:
  exposeMode: nodePort
  nodePort: 30053   # backend NodePort used by the LB

service:
  type: LoadBalancer
  # annotations:
  #   metallb.universe.tf/address-pool: production
```

With this configuration:

- The Service exposes:
  - DNS on **port 53** (UDP/TCP) and
  - Metrics UI on **80** and control API on **8081**.
- The LoadBalancer gets an external IP; DNS clients can use **`<EXTERNAL-IP>:53`**, and the Metrics UI is reachable at **`http://<EXTERNAL-IP>/`**.

You can still enable an Ingress for the Metrics UI if you prefer hostname-based access:

```yaml
ingress:
  enabled: true
  # ...hosts / tls as needed...
```

> **Note:** Support for UDP on LoadBalancers is implementation-specific. Ensure your cloud LB / MetalLB pool is configured to forward **UDP and TCP** traffic on port 53 to the service.

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
| `clickhouse.url` | ClickHouse HTTP URL (see ClickHouse quick start) | `""` |
| `clickhouse.runInitJob` | Run a one-off Job to create DB/table | `false` |
| `config.persistence.enabled` | Persist config-overrides (and admin password file) | `true` |
| `config.persistence.size` | PVC size | `1Gi` |
| `restartToken` | Optional token to force a rolling restart when using persisted config (PVC) | `""` |
| `extraEnv` | Extra env vars (e.g. `HOSTNAME`, `UI_PASSWORD`) | `[]` |
| `extraEnvFrom` | Env from Secrets | `[]` |
| `probes.startup.enabled` | Use a startupProbe so the pod isn't killed while Redis/control server start | `true` |
| `probes.startup.failureThreshold` | Startup probe attempts before fail (× periodSeconds = max startup time) | `18` (90s) |
| `ingress.enabled` | Create Ingress for Metrics UI | `false` |

See [values.yaml](values.yaml) for all options. For primary/replica sync and LoadBalancer setups, example values files are provided:

- `values-primary.yaml` – runs a primary instance that owns DNS-affecting config and exposes `/sync/config`.
- `values-replica.yaml` – runs one or more replicas that pull config from the primary.
- `values-loadbalancer.yaml` – overlay that turns the Service into a LoadBalancer (e.g. MetalLB) and uses NodePort as the backend for DNS on port 53.

### Rolling app version updates

The chart uses the standard Kubernetes **RollingUpdate** strategy for the `Deployment`, so changing the container image tag triggers a zero‑downtime rollout.

- **1. Pick an image tag**
  - Recommended for production: `stable` or a pinned version like `v1.2.3`.
  - See the root `README.md` (**Image tags** section) for the meaning of `stable`, `appliance`, `latest`, `edge`, and versioned tags.

- **2. Upgrade the release with the new tag**

  ```bash
  # Example: upgrade to v1.2.3 while keeping existing values
  helm upgrade beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
    --reuse-values \
    --set image.tag=v1.2.3 \
    --set clickhouse.createUser=false
  ```

  - Kubernetes will:
    - Create new pods with the new image tag.
    - Wait for them to become Ready (`/health` probe).
    - Gradually terminate old pods, keeping DNS available throughout (subject to your `replicaCount`).

- **3. Verify the rollout**

  ```bash
  kubectl rollout status deployment/beyond-ads-dns -n beyond-ads-dns
  kubectl get pods -l app.kubernetes.io/name=beyond-ads-dns -n beyond-ads-dns
  ```

- **4. Notes**
  - Changing `image.tag` always updates the pod template, so a rolling update happens even when `config.persistence.enabled: true`; you do **not** need to bump `restartToken` just to change app versions.
  - For the lowest impact during upgrades, run with `replicaCount > 1` so new pods can take traffic before old ones terminate.
  - In `DaemonSet` + `hostNetwork` mode (one pod per node), version changes behave like a rolling restart across nodes; expect a brief DNS blip per node. For strict zero‑downtime, prefer the `Deployment`/NodePort pattern with multiple replicas.

### Config changes and automatic rollouts

There are two main ways config is applied and rolled out:

- **ConfigMap-backed overrides (no persistence):**
  - When `clickhouse.enabled: false` and `config.persistence.enabled: false`, the chart renders a `ConfigMap` named `<release>-beyond-ads-dns-config-overrides` and mounts it read-only into the pod.
  - The `Deployment` template adds an annotation:
    - `checksum/config-overrides: {{ include (print $.Template.BasePath "/config-overrides-cm.yaml") . | sha256sum }}`
  - Any change to the `config-overrides-cm.yaml` template (for example via Helm values) changes this checksum, which changes the pod template and triggers a standard Kubernetes **rolling restart** on `helm upgrade`.

- **PVC-backed overrides (persistence enabled – default):**
  - When `config.persistence.enabled: true`, the app writes `/app/config-overrides/config.yaml` to a **PVC**, so UI/CLI changes survive pod restarts.
  - Kubernetes does **not** detect changes inside the PVC, so changing config at runtime does not automatically restart pods.
  - To trigger a controlled restart after making changes that require one, set or bump `restartToken`:

    ```bash
    helm upgrade beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
      --reuse-values \
      --set restartToken=$(date +%s)
    ```

  - The `Deployment` template includes `restartToken` as a pod-template annotation; changing it forces a new ReplicaSet and a Kubernetes **rolling restart**, even though the underlying PVC contents are unchanged.

### Scaling app replicas against a single Redis

The chart is designed so that **multiple app instances share one Redis instance** (whether that Redis is installed as a subchart or provided externally).

- **Deployment mode (default – recommended for scaling):**
  - Ensure the chart is running as a **Deployment**, not a DaemonSet:
    - `dns.exposeMode=nodePort`
    - `dns.daemonSet=false`
  - Then scale the app by increasing `replicaCount`; all pods will connect to the same Redis URL:
    - With **Redis subchart**:
      ```bash
      helm upgrade --install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
        --set redis.enabled=true \
        --set dns.exposeMode=nodePort \
        --set dns.daemonSet=false \
        --set replicaCount=3
      ```
    - With **external Redis**:
      ```bash
      helm upgrade --install beyond-ads-dns -n beyond-ads-dns ./helm/beyond-ads-dns \
        --set redis.url=redis://redis.default.svc.cluster.local:6379 \
        --set dns.exposeMode=nodePort \
        --set dns.daemonSet=false \
        --set replicaCount=3
      ```
  - The chart injects a single `REDIS_URL` into every pod (`beyond-ads-dns.redisUrl` helper), so all replicas share the same Redis database and cache.

- **DaemonSet + hostNetwork mode (one pod per node):**
  - When `dns.exposeMode=hostNetwork` and `dns.daemonSet=true`, the chart renders a DaemonSet instead of a Deployment.
  - Each node runs one pod, and **all pods still point at the same Redis** (subchart or external) via `REDIS_URL`.
  - In this mode you do **not** use `replicaCount`; scaling is effectively driven by the number of nodes.

For most cluster setups, using a **Deployment with `replicaCount > 1` against a single Redis** is the simplest way to scale query capacity while keeping a single shared DNS cache.

### CrashLoopBackOff / "Terminated with: Completed"

If the pod shows **CrashLoopBackOff** and the container's last state is **Terminated with: Completed**, the app is being killed by the **liveness probe** before it is ready. The app must connect to Redis and start the control server (port 8081) before `/health` succeeds. The chart enables a **startupProbe** by default so Kubernetes does not run liveness until the app has had time to become ready.

**ClickHouse and unready status:** With ClickHouse (query store) enabled, the app retries the ClickHouse connection for **up to 2 minutes** before giving up and starting the control server. During that time `/health` is not available, so the pod stays Not Ready. The chart uses a **longer startup probe** when `clickhouse.enabled` is true (`failureThreshold: 30` → 2.5 min) so the container is not restarted during that retry. If ClickHouse is unreachable, the app will eventually disable the query store and become ready; ensure your startup probe allows that. Without ClickHouse, the default is `failureThreshold: 24` (2 min). If your Redis or cluster is slow, increase `probes.startup.failureThreshold` further.

**"connection refused" on port 8081 (startup probe):** The app binds the control server (port 8081) only after it has connected to Redis (and, if enabled, after the ClickHouse retry window). When **`redis.enabled` is true**, the chart runs a **wait-for-redis** init container so Redis is ready before the app starts, which usually prevents this. When using **external Redis** (`redis.enabled: false`), the app may need 10–30+ seconds to reach Redis; if the startup probe still fails, increase `probes.startup.initialDelaySeconds` (e.g. `25`) or `probes.startup.failureThreshold`. Defaults: `initialDelaySeconds: 10`, `failureThreshold: 24` without ClickHouse (2 min window) or `30` with ClickHouse (2.5 min). If the probe keeps failing, check Redis reachability and app logs: `kubectl logs -l app.kubernetes.io/name=beyond-ads-dns -c beyond-ads-dns`.

### Redis dependency

When `redis.enabled` is `true`, the chart installs [Bitnami Redis](https://github.com/bitnami/charts/tree/main/bitnami/redis) as a subchart in standalone mode. An init container **wait-for-redis** runs before the app and blocks until Redis accepts connections, so the app connects quickly and the startup probe (port 8081) usually succeeds. Run `helm dependency update` inside the chart directory before installing. You can override subchart settings (e.g. `redis.master.persistence.size`, `redis.auth.enabled`) under the `redis` key in values; if you enable `redis.auth.enabled`, the app receives `REDIS_PASSWORD` from the Bitnami-created secret automatically. The Redis image uses the `latest` tag by default so pulls succeed; set `redis.image.tag` to a specific tag to pin a version.

## Config and admin password

- **Config overrides:** The app writes UI/CLI config to `/app/config-overrides`. Use `config.persistence.enabled: true` (default) so a PVC is created and settings survive restarts.
- **Admin password:** Set `extraEnv` with `UI_PASSWORD` or `ADMIN_PASSWORD`, or use an existing Secret and `extraEnvFrom`. If you rely on the file-based password (set via UI), it is stored under config-overrides—ensure that volume is persistent.

### Redis max keys (L1 cache cap)

The size of the Redis DNS cache is controlled by `cache.redis.max_keys` in the app config (L1 cap). **Default is 10000 keys; `0` disables the cap.**

- **Recommended (Helm + UI):**
  - Ensure `config.persistence.enabled: true` (default) so config is stored on a PVC.
  - Expose the Metrics UI (e.g. `service.type=LoadBalancer` or `kubectl port-forward svc/beyond-ads-dns 8081:8081 -n beyond-ads-dns` and use the UI URL).
  - In the UI, go to **Settings → Cache** and edit **“Redis max keys (L1 cap)”**, then save. The new value is written to `config-overrides/config.yaml` on the PVC and survives pod restarts and Helm upgrades.

- **Pre-seeding via config file (advanced):**
  - Create a `config.yaml` that includes a `cache.redis.max_keys` override, for example:

    ```yaml
    cache:
      redis:
        max_keys: 500000  # L1 cap; 0 = no cap
    ```

  - Store this file on a PVC and point the chart at it with `config.persistence.existingClaim` (instead of creating a new claim). On startup the app will pick up the configured L1 cap from that file.

## ClickHouse disabled (default)

ClickHouse is **disabled by default** (`clickhouse.enabled: false`). The chart (1) sets `CLICKHOUSE_ENABLED=false` (emitted last so `extraEnv` cannot override) and (2) when **config persistence is on**, runs an **init container** that patches the persisted `config.yaml` to set `query_store.enabled: false` so the app does not wait for ClickHouse even if the file was previously saved with the query store on. If you still see "clickhouse unreachable at startup", verify the env in the pod: `kubectl exec deploy/beyond-ads-dns -- printenv CLICKHOUSE_ENABLED` (should print `false`) and that the init ran: `kubectl describe pod -l app.kubernetes.io/name=beyond-ads-dns` (look for init container `patch-query-store-disabled`).

## ClickHouse init

When using an external ClickHouse and you need the schema created automatically:

1. Set `clickhouse.enabled: true`, `clickhouse.url`, and `clickhouse.runInitJob: true`.
2. The chart runs a pre-install/pre-upgrade hook Job that creates the `beyond_ads` database and `dns_queries` table (see [db/clickhouse/init.sql](https://github.com/tternquist/beyond-ads-dns/blob/main/db/clickhouse/init.sql)).

If your ClickHouse requires authentication, you can provide **admin credentials** for the init Job:

- Set `clickhouse.adminUser` (default `default`).
- Provide a password via one of:
  - `clickhouse.adminExistingSecret` + `clickhouse.adminPasswordSecretKey` (recommended),
  - or inline `clickhouse.adminPassword`.
- If admin-specific values are not set, the Jobs fall back to:
  - `clickhouse.existingSecret` + `clickhouse.passwordSecretKey`, or
  - inline `clickhouse.password`.

The init Job will then authenticate to the ClickHouse HTTP interface when creating the database and table.

### ClickHouse quick start (bundled Redis + ClickHouse)

The default chart configuration can run **everything in one Helm release**: Redis, ClickHouse, and the beyond-ads-dns app.

1. **Create the namespace and ClickHouse password Secret** (once):

   ```bash
   kubectl create namespace beyond-ads-dns --dry-run=client -o yaml | kubectl apply -f -

   kubectl create secret generic beyond-ads-dns-clickhouse \
     --from-literal=password='s3cr3t' \
     -n beyond-ads-dns
   ```

2. **Fetch chart dependencies (Redis + ClickHouse subcharts):**

   ```bash
   cd helm/beyond-ads-dns
   helm dependency update
   cd ../..
   ```

3. **Install everything (recommended all-in-one values):**

   ```bash
   helm install beyond-ads-dns ./helm/beyond-ads-dns \
     -n beyond-ads-dns --create-namespace \
     --set redis.enabled=true \
     --set service.type=LoadBalancer \
     --set clickhouse.enabled=true \
     --set clickhouse.runInitJob=true \
     --set clickhouse.createUser=true \
     --set clickhouse.existingSecret=beyond-ads-dns-clickhouse \
     --set clickhouse.url=http://clickhouse:8123
   ```

   With this configuration:

   - The chart installs Bitnami Redis and ClickHouse subcharts.
   - A ClickHouse init Job creates the `beyond_ads` database and `dns_queries` table.
   - A create-user Job creates the `beyondads` user with the password from the Secret and grants it privileges on `beyond_ads.dns_queries`.
   - The app is configured with:
     - `CLICKHOUSE_ENABLED=true`
     - `CLICKHOUSE_URL=http://clickhouse:8123`
     - `CLICKHOUSE_DATABASE=beyond_ads`
     - `CLICKHOUSE_TABLE=dns_queries`

4. **ClickHouse routing and consistency**

   The ClickHouse subchart uses local `MergeTree` tables (not replicated). To ensure the query store always sees a **consistent view of data**, the Helm chart also creates an internal `Service` named `clickhouse` that:

   - Routes HTTP traffic only to the **primary** ClickHouse pod (`beyond-ads-dns-clickhouse-0`).
   - Is used as the app’s `CLICKHOUSE_URL` via `clickhouse.url=http://clickhouse:8123`.

   This avoids situations where inserts go to one pod but reads hit a different pod with an empty local table.

### Helm examples: create ClickHouse user (recommended: Secret)

Create a Kubernetes Secret containing the ClickHouse password (recommended):

```bash
# create secret in the release namespace (replace with a strong password)
kubectl create secret generic beyond-ads-dns-clickhouse \
  --from-literal=password='s3cr3t' \
  -n beyond-ads-dns
```

Install/upgrade the chart and ask it to create the ClickHouse user from that Secret and grant it access:

```bash
helm upgrade --install beyond-ads-dns ./helm/beyond-ads-dns \
  -n beyond-ads-dns --create-namespace \
  --set clickhouse.enabled=true \
  --set clickhouse.runInitJob=true \
  --set clickhouse.createUser=true \
  --set clickhouse.existingSecret=beyond-ads-dns-clickhouse
```

If you must provide a password inline (not recommended), set `clickhouse.createUser=true` and `clickhouse.password`:

```bash
helm upgrade --install beyond-ads-dns ./helm/beyond-ads-dns \
  -n beyond-ads-dns --create-namespace \
  --set clickhouse.enabled=true \
  --set clickhouse.runInitJob=true \
  --set clickhouse.createUser=true \
  --set clickhouse.password='s3cr3t'
```

If your Secret key uses a different name, set `clickhouse.passwordSecretKey` to the key name (default `password`).

The ClickHouse user created by the chart is granted appropriate privileges on `clickhouse.database.clickhouse.table` (defaults: `beyond_ads.dns_queries`), including the column-level `INSERT` permissions required by newer ClickHouse versions. Grants are applied idempotently, so re-running the Job on upgrade is safe.

**Note on auto-create Job timeout:** The chart runs a post-install Job to create the ClickHouse user when `clickhouse.createUser=true`. That Job retries the ClickHouse HTTP endpoint and will exit with a clear error if the endpoint is not reachable after a short timeout. If the job fails, ensure ClickHouse is installed and reachable, or set `clickhouse.createUser=false` and create the user manually once ClickHouse is available.

## Uninstall

```bash
helm uninstall beyond-ads-dns -n beyond-ads-dns
```

If you used config persistence, the PVC is retained. Delete it explicitly if desired:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=beyond-ads-dns -n beyond-ads-dns
```

## Design notes

See [docs/helm-chart-feasibility.md](https://github.com/tternquist/beyond-ads-dns/blob/main/docs/helm-chart-feasibility.md) in the main repository for design rationale and options.
