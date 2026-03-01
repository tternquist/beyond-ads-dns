# beyond-ads-dns Helm Chart

Deploy the [beyond-ads-dns](https://github.com/tternquist/beyond-ads-dns) ad-blocking DNS resolver on Kubernetes.

## Prerequisites

- Kubernetes 1.19+
- Helm 3+
- A Redis instance (required for the DNS cache). The chart does not install Redis by default; use `redis.url` to point to your Redis, or add a Redis dependency (e.g. Bitnami Redis).
- Optional: ClickHouse for query store (set `clickhouse.enabled: true` and provide `clickhouse.url`).

## Install

```bash
# Add Redis URL (required). Replace with your Redis service or external host.
helm install beyond-ads-dns ./helm/beyond-ads-dns \
  --set redis.url=redis://your-redis-host:6379

# With config persistence (recommended) and optional overrides
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
| `redis.url` | Redis URL (required) | `redis://beyond-ads-dns-redis:6379` |
| `redis.existingSecret` | Secret name for `REDIS_PASSWORD` | — |
| `clickhouse.enabled` | Enable query store (ClickHouse) | `false` |
| `clickhouse.url` | ClickHouse HTTP URL | `http://clickhouse:8123` |
| `clickhouse.runInitJob` | Run a one-off Job to create DB/table | `false` |
| `config.persistence.enabled` | Persist config-overrides (and admin password file) | `true` |
| `config.persistence.size` | PVC size | `1Gi` |
| `extraEnv` | Extra env vars (e.g. `HOSTNAME`, `UI_PASSWORD`) | `[]` |
| `extraEnvFrom` | Env from Secrets | `[]` |
| `ingress.enabled` | Create Ingress for Metrics UI | `false` |

See [values.yaml](values.yaml) for all options.

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
