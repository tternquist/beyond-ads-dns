# Grafana Integration Plan for Beyond Ads DNS

This document outlines how to integrate Beyond Ads DNS with Grafana for monitoring, dashboards, and alerting.

**Implementation status**: Phase 1 (Prometheus metrics) and Phase 2 (Grafana setup) are implemented. Run `docker compose up` to start the full stack including Prometheus and Grafana. Grafana is available at http://localhost:3000 (admin/admin).

## Current State

### Existing Data Sources

| Source | Location | Data Available |
|--------|----------|----------------|
| **Control server** (Go) | `:8081` | `/cache/stats`, `/cache/refresh/stats`, `/blocklists/stats`, `/querystore/stats`, `/health` |
| **Metrics API** (Node.js) | `:80` | `/api/redis/summary`, `/api/queries/recent`, `/api/health` |
| **ClickHouse** | `:8123` | `dns_queries` table (ts, client_ip, protocol, qname, qtype, outcome, rcode, duration_ms, etc.) |
| **Redis** | `:6379` | Keyspace stats (hits, misses, keys) via `INFO` |

### What's Missing

- **Prometheus `/metrics` endpoint**: The README mentions "Prometheus metrics" but the Go app does not yet expose a standard Prometheus scrape target.
- **Time-series metrics**: Control server endpoints return point-in-time JSON; no built-in time-series storage.

---

## Recommended Integration Strategy

Use a **three-pillar approach**:

1. **Prometheus + Grafana** — Real-time operational metrics (cache, refresh, blocklist)
2. **ClickHouse + Grafana** — Query analytics and historical trends
3. **Optional: Redis exporter** — Redis-specific metrics if needed

---

## Phase 1: Prometheus Metrics (High Priority)

### 1.1 Add Prometheus Metrics to the Go Application

**Goal**: Expose a `/metrics` endpoint in Prometheus exposition format for scraping.

**Implementation**:

- Add `github.com/prometheus/client_golang` to `go.mod`
- Register metrics in the control server (`cmd/beyond-ads-dns/main.go`)
- Expose `/metrics` on the same port as the control server (`:8081`)

**Metrics to expose**:

| Metric Name | Type | Description | Labels |
|-------------|------|-------------|--------|
| `dns_cache_hits_total` | Counter | Total cache hits (L0 + L1) | - |
| `dns_cache_misses_total` | Counter | Total cache misses | - |
| `dns_cache_hit_rate` | Gauge | Cache hit rate (0–100) | - |
| `dns_l0_entries` | Gauge | L0 (LRU) cache entries | - |
| `dns_l0_hits` | Counter | L0 cache hits | - |
| `dns_l0_misses` | Counter | L0 cache misses | - |
| `dns_refresh_sweep_count` | Counter | Total keys refreshed by sweeper | - |
| `dns_refresh_last_sweep_count` | Gauge | Keys refreshed in last sweep | - |
| `dns_blocklist_blocked_total` | Counter | Domains blocked by blocklist | - |
| `dns_blocklist_allow_total` | Counter | Domains allowed via allowlist | - |
| `dns_blocklist_deny_total` | Counter | Domains denied via denylist | - |
| `dns_querystore_flushed_total` | Counter | Query batches flushed to ClickHouse | - |
| `dns_querystore_pending` | Gauge | Pending queries in buffer | - |

**Files to modify**:

- `go.mod` — add Prometheus dependency
- `internal/dnsresolver/resolver.go` — increment counters on cache hit/miss, block, etc.
- `cmd/beyond-ads-dns/main.go` — mount `promhttp.Handler()` at `/metrics`

**Note**: Counters should be incremented in the resolver hot path. Use `prometheus.Counter` and `prometheus.Gauge`; avoid high-cardinality labels (e.g., per-domain) to keep scrape size small.

### 1.2 Add Prometheus to Docker Compose

```yaml
  prometheus:
    image: prom/prometheus:v2.48.0
    container_name: beyond-ads-prometheus
    restart: unless-stopped
    volumes:
      - ./config/prometheus.yml:/etc/prometheus/prometheus.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=15d'
      - '--web.enable-lifecycle'
    ports:
      - "9090:9090"
    depends_on:
      - app
```

**Scrape config** (`config/prometheus.yml`):

```yaml
scrape_configs:
  - job_name: 'beyond-ads-dns'
    scrape_interval: 15s
    static_configs:
      - targets: ['app:8081']
    metrics_path: /metrics
```

---

## Phase 2: Grafana Setup

### 2.1 Add Grafana to Docker Compose

```yaml
  grafana:
    image: grafana/grafana:10.2.0
    container_name: beyond-ads-grafana
    restart: unless-stopped
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_SERVER_ROOT_URL=http://localhost:3000
      - GF_INSTALL_PLUGINS=grafana-clickhouse-datasource
    volumes:
      - ./data/grafana:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
      - clickhouse
```

### 2.2 Configure Data Sources

**Prometheus**

- URL: `http://prometheus:9090`
- Access: Server (default)

**ClickHouse**

- Install plugin: `grafana-clickhouse-datasource`
- URL: `http://clickhouse:8123`
- Database: `beyond_ads`
- User/Password: from env (e.g. `beyondads` / `beyondads`)

---

## Phase 3: Dashboards

### 3.1 DNS Resolver Overview Dashboard

**Panels** (from Prometheus):

| Panel | Query | Visualization |
|-------|-------|---------------|
| Cache hit rate | `dns_cache_hit_rate` | Stat / Gauge |
| Cache hits/s | `rate(dns_cache_hits_total[1m])` | Time series |
| Cache misses/s | `rate(dns_cache_misses_total[1m])` | Time series |
| L0 entries | `dns_l0_entries` | Stat |
| Refresh sweep rate | `rate(dns_refresh_sweep_count[5m])` | Time series |
| Blocked queries/s | `rate(dns_blocklist_blocked_total[1m])` | Time series |

### 3.2 Query Analytics Dashboard (ClickHouse)

**Panels**:

| Panel | Query | Visualization |
|-------|-------|---------------|
| Queries per second | `SELECT toStartOfMinute(ts) AS time, count() AS qps FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 1 HOUR GROUP BY time ORDER BY time` | Time series |
| P50 / P95 / P99 latency | `SELECT quantile(0.5)(duration_ms), quantile(0.95)(duration_ms), quantile(0.99)(duration_ms) FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 1 HOUR` | Stat |
| Outcome distribution | `SELECT outcome, count() FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 24 HOUR GROUP BY outcome` | Pie chart |
| Top queried domains | `SELECT qname, count() AS c FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 1 HOUR GROUP BY qname ORDER BY c DESC LIMIT 20` | Table / Bar |
| Latency over time | `SELECT toStartOfMinute(ts) AS time, avg(duration_ms) AS avg_ms, quantile(0.95)(duration_ms) AS p95_ms FROM beyond_ads.dns_queries WHERE ts >= now() - INTERVAL 6 HOUR GROUP BY time ORDER BY time` | Time series |

### 3.3 Combined Dashboard Layout

```
+------------------+------------------+------------------+
| Cache Hit Rate   | Queries/sec      | P95 Latency (ms) |
+------------------+------------------+------------------+
|                  Cache hits / misses (time series)    |
+------------------+------------------+------------------+
|                  Latency percentiles (time series)    |
+------------------+------------------+------------------+
| Outcome pie      | Top domains      | Refresh stats    |
+------------------+------------------+------------------+
```

---

## Phase 4: Alerting (Optional)

### 4.1 Grafana Alerting

Configure alerts in Grafana using Prometheus metrics:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Low cache hit rate | `dns_cache_hit_rate < 80` for 5m | Warning |
| High cache miss rate | `rate(dns_cache_misses_total[5m]) > 1000` | Warning |
| Resolver down | `up{job="beyond-ads-dns"} == 0` | Critical |
| High P95 latency | From ClickHouse or exported metric | Warning |

### 4.2 Contact Points

- Email, Slack, or PagerDuty via Grafana contact points
- Alternatively: use Prometheus Alertmanager if you prefer to centralize alerting

---

## Phase 5: Optional Enhancements

### 5.1 Redis Exporter

If you want Redis-specific metrics (memory, connected clients, evictions) in Prometheus:

- Add `redis_exporter` container to docker-compose
- Scrape Redis; Grafana queries via Prometheus

### 5.2 JSON API as Fallback

If you cannot add Prometheus metrics immediately, use the **Grafana Infinity** plugin:

- Data source: JSON API
- Query: `http://app:80/api/redis/summary` or proxy to `http://app:8081/cache/stats`
- Requires transformations to turn JSON into time series (less ideal for dashboards)

### 5.3 Structured Logs → Loki

If you add structured (JSON) logging to the Go app:

- Ship logs to Loki
- Grafana Explore: correlate logs with metrics
- Useful for debugging blocked domains, upstream failures, etc.

---

## Implementation Order

| Step | Task | Effort | Dependencies |
|------|------|--------|--------------|
| 1 | Add Prometheus metrics to Go app | Medium | - |
| 2 | Add Prometheus + Grafana to docker-compose | Low | Step 1 |
| 3 | Create Prometheus dashboard | Low | Step 2 |
| 4 | Configure ClickHouse data source | Low | - |
| 5 | Create ClickHouse analytics dashboard | Medium | Step 4 |
| 6 | Add alerting rules | Low | Step 3 |
| 7 | Document setup in README | Low | All |

---

## File Changes Summary

| File | Change |
|------|--------|
| `go.mod` | Add `github.com/prometheus/client_golang` |
| `internal/dnsresolver/resolver.go` | Increment Prometheus counters on cache hit/miss, block, etc. |
| `cmd/beyond-ads-dns/main.go` | Expose `/metrics`, optionally inject metrics registry |
| `internal/cache/redis.go` | Optional: export LRU stats via callback or metrics |
| `config/prometheus.yml` | New file: Prometheus scrape config |
| `docker-compose.yml` | Add `prometheus` and `grafana` services |
| `docs/grafana-integration-plan.md` | This plan |

---

## References

- [Prometheus Go client](https://github.com/prometheus/client_golang)
- [Grafana ClickHouse plugin](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/)
- [Grafana Infinity (JSON API)](https://grafana.com/grafana/plugins/grafana-infinity-datasource/)
