# Grafana Integration Example

Deploy Beyond Ads DNS with Prometheus and Grafana for monitoring and dashboards. This example extends the base stack with:

- **Prometheus** — scrapes metrics from the resolver's `/metrics` endpoint
- **Grafana** — pre-configured with Prometheus and ClickHouse data sources

## Quick Start

From this directory:

```bash
docker compose up --build
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Metrics UI | http://localhost | Beyond Ads DNS web UI |
| DNS | localhost:53 (UDP/TCP) | DNS resolver |
| Prometheus | http://localhost:9090 | Metrics storage and query |
| Grafana | http://localhost:3000 | Dashboards (login: `admin` / `admin`) |

## Data Sources

Grafana is provisioned with:

1. **Prometheus** (default) — Operational metrics: cache hit rate, QPS, refresh stats, blocked queries
2. **ClickHouse** — Query analytics: latency percentiles, top domains, outcome distribution

## Sample Dashboards

Two dashboards are provisioned automatically:

1. **DNS Resolver Overview** — Prometheus-based: cache hit rate, queries/sec, L0 entries, blocked rate, cache hits vs misses, refresh sweep rate
2. **Query Analytics** — ClickHouse-based: QPS, P50/P95/P99 latency, queries over time, latency over time, outcome distribution, top domains

To import manually: Dashboards → Import → paste JSON from `config/grafana/provisioning/dashboards/default/`.

## Creating Dashboards

See [`docs/grafana-integration-plan.md`](../../docs/grafana-integration-plan.md) for:

- Suggested panels and PromQL/ClickHouse queries
- Dashboard layout ideas
- Alerting recommendations

### Example Prometheus Queries

- Cache hit rate: `dns_cache_hit_rate`
- Queries per second: `rate(dns_cache_hits_total[1m]) + rate(dns_cache_misses_total[1m])`
- Blocked queries/s: `rate(dns_queries_blocked_total[1m])`

### Example ClickHouse Queries

- QPS over time: `SELECT toStartOfMinute(ts) AS time, count() AS qps FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 1 HOUR GROUP BY time ORDER BY time`
- P95 latency: `SELECT quantile(0.95)(duration_ms) FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 1 HOUR`

## Config

- Default DNS config is in the image; overrides go in `./config/config.yaml` (created when you save from the UI)
- Prometheus scrape config: `./config/prometheus.yml`
- Grafana datasources: `./config/grafana/provisioning/datasources/datasources.yaml`

## Troubleshooting

**ClickHouse datasource: "failed to create ClickHouse client"** — The datasource uses HTTP protocol on port 8123. If you changed the provisioning config, restart Grafana (`docker compose restart grafana`) so it picks up the updated datasources.

## Data Persistence

Uses Docker named volumes for logs, Redis, ClickHouse, and Grafana data.
