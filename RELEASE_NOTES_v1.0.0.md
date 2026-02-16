# beyond-ads-dns v1.0.0

**Release Date:** February 16, 2026

We're excited to announce the first stable release of **beyond-ads-dns**, a high-performance ad-blocking DNS resolver that uses public blocklists (e.g. Hagezi) and Redis caching to reduce upstream traffic.

---

## Highlights

- **Multi-tier caching**: L0 in-memory LRU (~10–50μs), L1 Redis (~0.5–2ms), Bloom filter for fast blocklist lookups
- **Refresh-ahead & stale serving**: Proactive cache refresh and serving of slightly stale entries to minimize latency
- **Metrics UI**: React-based dashboard with Redis stats, query analytics, blocklist management, and instance sync
- **Docker-first deployment**: Multiple Docker Compose examples for basic, Let's Encrypt, Grafana, Raspberry Pi, Unbound, and high-throughput setups
- **Production-ready**: Redis Sentinel/Cluster, ClickHouse query store, Prometheus metrics, webhooks, and optional DoH/DoT server

---

## Core Features

### DNS Resolver

- **Blocklist support**: Hosts file, AdBlock-style (`||domain^`, `$important`, `$script`), and common list formats
- **Allowlist & denylist**: Override blocklist decisions per domain
- **Upstream options**: Plain DNS, DoT (`tls://host:853`), DoH (`https://host/dns-query`)
- **Resolver strategies**: Failover, load balance, or weighted (response-time EWMA)
- **Block responses**: NXDOMAIN or custom IP (e.g. block page)
- **Local DNS records**: Static records returned without upstream lookup (works when internet is down)

### Caching

- **L0 cache**: In-memory LRU for hot queries (~10–50μs)
- **L1 cache**: Redis with configurable eviction (default: `allkeys-lru`)
- **Refresh-ahead**: Proactive refresh for hot and near-expiry entries
- **Sweeper**: Periodic scan and refresh of keys close to expiry with hit thresholds
- **Stale serving**: Serve expired entries within `stale_ttl` while refreshing in background
- **Distributed locks**: Per-key refresh locks to prevent stampedes

### Blocklist Management

- **Scheduled pause**: Temporarily disable blocking (e.g. work hours)
- **Health checks**: Validate blocklist URLs before applying
- **Hot reload**: Apply blocklist changes via `/blocklists/reload` without restart

### Query Store & Analytics

- **ClickHouse storage**: Query timestamp, client, qname, outcome, latency
- **Sampling**: `sample_rate` (0.0–1.0) to reduce load at scale
- **Anonymization**: Hash or truncate client IP for GDPR/privacy
- **Partition TTL**: Configurable retention with partition-level TTL

### Metrics UI

- **Redis stats**: Cache hit rates, key counts, eviction stats
- **Query table**: Filter, paginate, sort, CSV export
- **Blocklist management**: Add/remove sources, allowlist, denylist from the UI
- **Instance sync**: Configure primary/replica sync from the Sync tab
- **System settings**: Clear Redis cache, clear ClickHouse data
- **Dark mode**: Optional dark theme

### Security & Deployment

- **DoH/DoT server**: Accept encrypted DNS from clients (TLS certs required)
- **Block page**: Resolve blocked domains to your server IP; Metrics UI serves block page
- **User/password login**: Optional UI authentication via `UI_PASSWORD` or `set-admin-password` command
- **Sessions**: Redis-backed sessions with configurable secret
- **HTTPS**: Let's Encrypt (HTTP or DNS challenge) or manual certificates
- **Control API token**: Optional token for blocklist reload and config changes

### Multi-Instance Sync

- **Primary/replica**: One primary, multiple replicas
- **Token-based auth**: Create and revoke sync tokens from the UI
- **Config sync**: Blocklists, upstreams, local records synced from primary to replicas

### Integrations

- **Webhooks**: HTTP POST on block and error events; multiple targets; Discord, Slack-ready; rate limiting
- **Prometheus metrics**: Exposed at `:8081/metrics` when control server is enabled
- **Grafana**: Pre-configured dashboards for DNS resolver overview and query analytics
- **Safe search**: Force safe search for Google and Bing (parental controls)

---

## Docker Compose Examples

| Example | Description |
|---------|-------------|
| **Basic** | Minimal deployment with Redis, ClickHouse, Metrics UI |
| **Let's Encrypt** | Automatic HTTPS for Metrics UI |
| **Grafana** | Prometheus + Grafana for monitoring and dashboards |
| **Max Performance** | Tuned for high throughput (2GB Redis, 100K L0 cache) |
| **Raspberry Pi** | MicroSD-friendly: no ClickHouse, tmpfs for Redis |
| **Unbound** | Unbound as recursive upstream with full DNSSEC |
| **Source build** | Build image from source for custom deployments |

---

## Quick Start

```bash
cd examples/basic-docker-compose
docker compose up -d
```

- **DNS**: `localhost:53` (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

---

## Requirements

- **Go 1.24+** (for source builds)
- **Redis** (required for DNS cache)
- **ClickHouse** (optional; disable with `query_store.enabled: false`)

---

## Documentation

- [README](README.md) – Installation, configuration, architecture
- [Performance](docs/performance.md) – Caching architecture and tuning
- [Webhooks](docs/webhooks.md) – Webhook configuration and examples
- [Errors](docs/errors.md) – Error reference and troubleshooting
- [ClickHouse disk writes](docs/clickhouse-disk-writes.md) – Reducing disk I/O

---

## Docker Images

Multi-arch images are published to GitHub Container Registry:

- `ghcr.io/<org>/beyond-ads-dns:v1.0.0` (amd64, arm64)
- `ghcr.io/<org>/beyond-ads-dns:latest`

---

## Full Changelog

See the [commit history](https://github.com/tternquist/beyond-ads-dns/commits/v1.0.0) for a complete list of changes.
