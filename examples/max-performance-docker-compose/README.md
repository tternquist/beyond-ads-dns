# Maximum Performance Docker Compose

Deploy beyond-ads-dns with performance tuning for high throughput and low latency. Suitable for busy networks or servers with ample RAM.

## Quick Start

```bash
cd examples/max-performance-docker-compose
docker compose up -d
```

- **DNS**: port 53 (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Performance Optimizations

| Component | Default | Max Performance |
|-----------|---------|-----------------|
| **Redis** | 512MB | 2GB maxmemory |
| **L0 cache** | 10K entries | 100K entries |
| **Refresh max_inflight** | 50 | 200 |
| **Refresh max_batch_size** | 2000 | 2000 |
| **Min TTL** | 300s | 600s |
| **Max TTL** | 1h | 3h |
| **Query store batch** | 500 | 1000 |

## Resource Allocation

| Service | Memory Limit | Memory Reservation |
|---------|--------------|-------------------|
| app | 1G | 512M |
| redis | 2.5G | 2G |
| clickhouse | 4G | 2G |

Ensure your host has at least **6GB RAM** available for this stack.

## Expected Performance

With warm cache and tuned settings:

- **P50 latency**: &lt; 0.5ms (L0 hits)
- **P95 latency**: &lt; 2ms (L1 hits)
- **QPS**: 100K+ per instance (hot cache)
- **Cache hit rate**: 95–99% (with refresh-ahead)

See [`docs/performance.md`](../../docs/performance.md) for detailed tuning and benchmarking.

## Config

Performance overrides are in `./config/config.yaml`. Edit blocklists or upstreams from the Metrics UI; changes persist to this file.

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:latest` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).
