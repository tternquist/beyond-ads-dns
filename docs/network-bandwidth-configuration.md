# Network Bandwidth Configuration and Balancing

This document describes how various configuration options affect network bandwidth usage and how to find a reasonable balance for your deployment.

## Overview

beyond-ads-dns uses the network for several distinct purposes:

| Traffic Type | Direction | Purpose |
|--------------|-----------|---------|
| **Upstream DNS** | Outbound | Resolving uncached queries and cache refresh |
| **Blocklist fetch** | Outbound | Downloading blocklist sources (HTTP/HTTPS) |
| **Redis** | Outbound/Inbound | Cache reads/writes, hit counting, refresh locks |
| **ClickHouse** | Outbound | Query analytics (batched inserts) |
| **Sync** | Outbound/Inbound | Replica pulls config from primary |
| **Webhooks** | Outbound | HTTP POST on block/error events |

Each of these can be tuned to reduce bandwidth on constrained links (e.g. metered connections, low-bandwidth WAN, Raspberry Pi on slow uplink).

---

## 1. Upstream DNS Traffic

Upstream DNS traffic is the largest variable. It depends on cache hit rate and refresh behavior.

### Configuration Options

| Option | Default | Effect on Bandwidth |
|--------|---------|---------------------|
| `cache.min_ttl` | 300s | **Higher** = fewer refreshes, less upstream traffic |
| `cache.max_ttl` | 1h | **Higher** = longer cache lifetime, less upstream traffic |
| `cache.refresh.enabled` | true | **false** = no proactive refresh; fewer upstream queries but more cache misses |
| `cache.refresh.max_inflight` | 50 | **Lower** = fewer concurrent upstream refreshes (throttles burst) |
| `cache.refresh.max_batch_size` | 2000 | **Lower** = fewer keys refreshed per sweep |
| `cache.refresh.sweep_interval` | 15s | **Higher** = sweeps less often, fewer refresh bursts |
| `cache.refresh.sweep_window` | 1m | **Lower** = fewer candidates per sweep |
| `cache.refresh.sweep_min_hits` | 1 | **Higher** = only refresh entries with more hits; cold keys expire instead |
| `cache.refresh.hit_count_sample_rate` | 1.0 | **Lower** (e.g. 0.1) = fewer Redis writes; may undercount hot entries |
| `cache.redis.lru_size` | 10000 | **Higher** = more L0 hits, fewer Redis/upstream queries |

### Balancing

- **Minimize upstream traffic**: Increase `min_ttl` (e.g. 600s–900s), `max_ttl` (e.g. 3h–6h), and `sweep_min_hits` (e.g. 5–10). Reduce `max_inflight` and `max_batch_size`.
- **Trade-off**: Higher TTLs mean slower propagation of DNS changes. Very high `sweep_min_hits` may let rarely-queried domains expire and cause occasional cache misses.

---

## 2. Blocklist Fetch Traffic

Blocklists are fetched over HTTP/HTTPS on a schedule. Each source is downloaded in full.

### Configuration Options

| Option | Default | Effect on Bandwidth |
|--------|---------|---------------------|
| `blocklists.refresh_interval` | 6h | **Higher** = fewer fetches (e.g. 12h, 24h) |
| `blocklists.sources` | (varies) | **Fewer sources** or **smaller lists** = less data per refresh |

### Balancing

- **Minimize blocklist traffic**: Use `refresh_interval: "12h"` or `"24h"`. Prefer smaller blocklists (e.g. `pro` instead of `pro.plus`) if acceptable for your use case.
- **Trade-off**: Longer intervals mean new malicious domains take longer to appear in the blocklist. Very long intervals (e.g. 48h) may be acceptable for home use.

---

## 3. Redis Traffic

Redis is used for the L1 cache, hit counting, and refresh locks. When Redis is local (same host), traffic is minimal. When Redis is remote (e.g. across WAN), every cache miss and hit-count write adds latency and bandwidth.

### Configuration Options

| Option | Default | Effect on Bandwidth |
|--------|---------|---------------------|
| `cache.redis.lru_size` | 10000 | **Higher** = more L0 hits, fewer Redis reads |
| `cache.refresh.hit_count_sample_rate` | 1.0 | **Lower** (e.g. 0.1–0.2) = fewer Redis writes for hit counting |
| `cache.refresh.max_batch_size` | 2000 | **Lower** = fewer Redis operations per sweep |
| `cache.min_ttl` / `max_ttl` | 300s / 1h | **Higher** = fewer cache refreshes, fewer Redis writes |

### Balancing

- **Minimize Redis traffic**: Increase `lru_size` (e.g. 50000) so more queries hit L0. Set `hit_count_sample_rate: 0.1` to reduce IncrementHit/IncrementSweepHit writes.
- **Trade-off**: `hit_count_sample_rate < 1.0` can undercount hot entries; refresh decisions may be less accurate. See [performance.md](performance.md) for details.

---

## 4. ClickHouse (Query Store) Traffic

Query analytics are batched and sent to ClickHouse. Each batch is an HTTP POST with JSON.

### Configuration Options

| Option | Default | Effect on Bandwidth |
|--------|---------|---------------------|
| `query_store.enabled` | true | **false** = no query analytics, no ClickHouse traffic |
| `query_store.flush_to_store_interval` | 5s | **Higher** = fewer, larger batches (e.g. 15s–30s) |
| `query_store.batch_size` | 2000 | **Higher** = larger batches, fewer HTTP requests |
| `query_store.sample_rate` | 1.0 | **Lower** (e.g. 0.1–0.5) = record fewer queries, less data |
| `query_store.exclude_domains` | [] | Exclude high-volume domains to reduce data |
| `query_store.exclude_clients` | [] | Exclude specific clients to reduce data |

### Balancing

- **Minimize ClickHouse traffic**: Increase `flush_to_store_interval` (e.g. 15s–30s) and `batch_size` (e.g. 5000). Use `sample_rate: 0.1` to record 10% of queries.
- **Trade-off**: Lower `sample_rate` reduces analytics fidelity. Higher `flush_to_store_interval` increases memory use (buffer holds more events) and risk of data loss on crash.

---

## 5. Sync Traffic (Primary/Replica)

Replicas pull DNS-affecting config from the primary on a schedule. Config payload includes blocklists, upstreams, client groups, etc.

### Configuration Options

| Option | Default | Effect on Bandwidth |
|--------|---------|---------------------|
| `sync.sync_interval` | 60s | **Higher** = fewer sync requests (e.g. 5m–15m) |
| `sync.stats_source_url` | "" | When set, replica fetches stats from a web server; **omit** to avoid extra HTTP traffic |

### Balancing

- **Minimize sync traffic**: Use `sync_interval: "5m"` or `"15m"` if config changes infrequently.
- **Trade-off**: Longer intervals mean config changes (blocklist, upstreams) propagate more slowly to replicas.

---

## 6. Webhook Traffic

Webhooks send HTTP POSTs on block or error events. Rate limiting caps the number of requests.

### Configuration Options

| Option | Default | Effect on Bandwidth |
|--------|---------|---------------------|
| `webhooks.on_block.enabled` | false | **false** = no block webhooks |
| `webhooks.on_block.rate_limit_max_messages` | 60 | **Lower** = fewer webhooks per timeframe |
| `webhooks.on_block.rate_limit_timeframe` | 1m | **Higher** = same cap over longer period |
| `webhooks.on_error.*` | (similar) | Same for error webhooks |

### Balancing

- **Minimize webhook traffic**: Disable webhooks if not needed. Use lower `rate_limit_max_messages` or longer `rate_limit_timeframe` to cap bursts.

---

## Recommended Profiles

### Low-Bandwidth / Metered Connection

```yaml
blocklists:
  refresh_interval: "12h"   # or "24h"

cache:
  min_ttl: "600s"
  max_ttl: "3h"
  redis:
    lru_size: 50000
  refresh:
    enabled: true
    max_inflight: 20
    max_batch_size: 500
    sweep_interval: "30s"
    sweep_window: "1m"
    sweep_min_hits: 5
    hit_count_sample_rate: 0.2

query_store:
  flush_to_store_interval: "15s"
  batch_size: 5000
  sample_rate: 0.1

sync:
  sync_interval: "5m"   # if using replicas
```

### Balanced (Default)

Use the defaults in `config/default.yaml` and `config/config.example.yaml`. They are tuned for typical home/small-office deployments.

### High Throughput (Unconstrained Bandwidth)

See [examples/max-performance-docker-compose/](../examples/max-performance-docker-compose/). Larger `lru_size`, higher `max_inflight`, larger batches.

---

## Monitoring and Tuning

1. **Cache hit rate**: Target >95%. Low hit rate → more upstream traffic. Increase `lru_size`, `min_ttl`, `max_ttl`.
2. **Refresh sweep stats**: `curl http://localhost:8081/cache/refresh/stats` — high `refreshed_24h` suggests more upstream traffic. Consider `sweep_min_hits` or `max_batch_size`.
3. **Query store buffer**: If `query-store-buffer-full` appears in logs, increase `batch_size` or `flush_to_store_interval`; or increase `sample_rate` if you want to record fewer queries.
4. **Redis**: If Redis is remote and slow, consider `hit_count_sample_rate: 0.1` (see [performance.md](performance.md)).

---

## Summary

| Goal | Key Actions |
|------|-------------|
| **Reduce upstream DNS** | ↑ `min_ttl`, `max_ttl`; ↑ `sweep_min_hits`; ↓ `max_inflight`, `max_batch_size` | 
| **Reduce blocklist** | ↑ `refresh_interval`; fewer/smaller sources |
| **Reduce Redis** | ↑ `lru_size`; ↓ `hit_count_sample_rate` |
| **Reduce ClickHouse** | ↑ `flush_to_store_interval`; ↓ `sample_rate`; or disable |
| **Reduce sync** | ↑ `sync_interval` |

Start with defaults, measure, then tune incrementally. Change one parameter at a time and observe before applying further changes.
