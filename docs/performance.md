# Performance Optimizations and Caching Levels

This document describes the multi-level caching architecture and performance optimizations implemented in beyond-ads-dns.

## Overview

The DNS resolver uses a sophisticated multi-tier caching strategy to minimize latency and reduce upstream queries. The architecture includes:

1. **L0 Cache**: In-memory LRU cache (local to each instance)
2. **L1 Cache**: Redis distributed cache (shared across instances)
3. **Bloom Filter**: Fast negative lookups for blocklists
4. **Refresh-Ahead**: Proactive cache refresh to avoid expiry
5. **Stale Serving**: Serve slightly expired entries while refreshing

## Caching Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DNS Query Path                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Blocklist Check │
                    │  (Bloom Filter)  │
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   L0 Cache (LRU) │
                    │   In-Memory      │────► Cache Hit (~0.01ms)
                    └──────────────────┘
                              │ Cache Miss
                              ▼
                    ┌──────────────────┐
                    │   L1 Cache       │
                    │   Redis          │────► Cache Hit (~0.5-2ms)
                    └──────────────────┘
                              │ Cache Miss
                              ▼
                    ┌──────────────────┐
                    │   Upstream DNS   │────► Upstream (~10-50ms)
                    │   (Cloudflare)   │
                    └──────────────────┘
```

## L0 Cache: Local In-Memory LRU

### Description

The L0 cache is a thread-safe, in-memory LRU (Least Recently Used) cache that stores the most frequently accessed DNS responses locally within each resolver instance.

### Benefits

- **Ultra-low latency**: ~10-50 microseconds (0.01-0.05ms)
- **No network overhead**: Completely local to the process
- **Hot query optimization**: Frequently queried domains stay in memory
- **Automatic eviction**: LRU algorithm ensures memory efficiency

### Configuration

```yaml
cache:
  redis:
    lru_size: 10000  # Number of entries (default: 10000, 0 to disable)
```

### Behavior

- **Entry lifecycle**: Each entry has a soft expiry (based on DNS TTL) and a hard expiry (soft + grace period)
- **Grace period**: Entries remain accessible for up to 2× their TTL or 1 hour (whichever is smaller)
- **Thread safety**: All operations are protected by read-write mutexes
- **Memory management**: Automatic eviction when cache is full
- **Copy-on-return**: Returns copies of DNS messages to prevent mutations

### Performance Impact

For hot queries (top 1-10% of domains), L0 cache typically:
- Reduces latency by 98% compared to Redis
- Reduces latency by 99.9% compared to upstream
- Handles 1M+ queries/second per instance

### Monitoring

View L0 cache statistics via the API:

```bash
curl http://localhost:8081/cache/stats
```

Response includes:
```json
{
  "hits": 1000000,
  "misses": 50000,
  "hit_rate": 95.24,
  "lru": {
    "entries": 10000,
    "max_entries": 10000,
    "fresh": 8500,
    "stale": 1200,
    "expired": 300,
    "fill_ratio": 0.85,
    "estimated_elements": 9800,
    "estimated_fpr": 0.001
  }
}
```

## L1 Cache: Redis Distributed Cache

### Description

Redis serves as the distributed L1 cache, shared across all resolver instances. It provides persistence and synchronization across the cluster.

### Benefits

- **Shared cache**: All instances benefit from cached responses
- **Persistence**: Survives process restarts (with Redis persistence)
- **Low latency**: ~0.5-2ms for local Redis, ~2-5ms for networked Redis
- **High capacity**: Can store millions of entries

### Configuration

```yaml
cache:
  redis:
    address: "redis:6379"
    db: 0
    password: ""
    lru_size: 10000  # L0 cache size
  min_ttl: "300s"      # Minimum TTL for cached entries
  max_ttl: "1h"        # Maximum TTL for cached entries
  negative_ttl: "5m"   # TTL for NXDOMAIN responses
```

### Connection Pool Optimization

The Redis client is configured with optimized connection pooling:

- **Pool size**: 50 connections
- **Min idle connections**: 2 (small warm pool for burst traffic; balances memory vs cold-start latency)
- **Read/Write buffer size**: 16KB each (reduced from 32KB default for memory; see `MEMORY_PERFORMANCE_TRADE_OFFS.md`)
- **Max retries**: 3 (automatic retry on transient failures)
- **Timeouts**: 2s dial, 2s read, 2s write

### Cache Key Format

```
dns:<qname>:<qtype>:<qclass>
```

Example: `dns:example.com:1:1` (A record for example.com)

### Storage Format

Redis hash with two fields:
- `msg`: Wire-encoded DNS response (binary)
- `soft_expiry`: UNIX timestamp for TTL expiration

### Eviction Policy

Redis is configured with `allkeys-lru` eviction:
- Evicts least recently used keys when memory limit is reached
- Cache entries do NOT have Redis TTLs (persist until evicted)
- Metadata keys (hit counters, locks) DO have TTLs

### Performance Impact

- Reduces upstream queries by 80-95%
- Typical latency: 0.5-2ms (local Redis) vs 10-50ms (upstream)
- Handles 100K+ queries/second across cluster

## Bloom Filter: Blocklist Optimization

### Description

A probabilistic data structure that provides O(1) negative lookups for blocklist queries. If the bloom filter says a domain is NOT blocked, we can skip the expensive map lookup entirely.

### Benefits

- **Fast negative lookups**: O(1) constant time
- **Memory efficient**: ~1.2 bits per element at 0.1% FPR
- **No false negatives**: Never says "not blocked" when it is blocked
- **Rare false positives**: <0.1% false positive rate

### Algorithm

1. Check if domain (or any parent domain) might be in blocklist
2. If bloom filter says "definitely not blocked" → return immediately
3. If bloom filter says "might be blocked" → check actual map

### Performance Impact

For non-blocked domains (99%+ of queries in typical deployments):
- Reduces blocklist lookup time by 50-90%
- Especially effective for large blocklists (>100K domains)

### Configuration

Bloom filter is automatically created and populated:
- Size optimized for blocklist size
- 0.1% false positive rate (configurable in code)
- Automatically rebuilt on blocklist refresh

### Statistics

View bloom filter statistics:

```bash
curl http://localhost:8081/blocklists/stats
```

Response includes:
```json
{
  "blocked": 1500000,
  "allow": 10,
  "deny": 5,
  "bloom": {
    "size": 21623736,
    "hash_count": 10,
    "set_bits": 14384912,
    "fill_ratio": 0.665,
    "estimated_elements": 1498234,
    "estimated_fpr": 0.000956
  }
}
```

## Refresh-Ahead Strategy

### Description

Proactively refresh cached entries before they expire, based on request frequency and remaining TTL.

### Request-Driven Refresh

When serving a cached entry:
1. Check if remaining TTL is below threshold
2. For "hot" entries (≥20 requests/min): refresh when TTL < 2 minutes
3. For normal entries: refresh when TTL < 30 seconds
4. Schedule background refresh if threshold is met

### Periodic Sweep Refresh

Every 15 seconds:
1. Scan Redis expiry index for entries expiring within 2 minutes
2. Filter to entries with ≥1 hit in the last 7 days
3. Schedule background refresh for qualifying entries
4. Process up to 200 entries per sweep

### Concurrency Control

- **Distributed locks**: Per-key locks in Redis (10s TTL)
- **Inflight limit**: Max 50 concurrent refreshes per instance
- **No stampede**: Only one instance refreshes each key

### Benefits

- **Prevents expiry**: Hot entries never truly expire
- **Consistent performance**: No latency spikes from expired cache
- **Reduced upstream load**: Spreads refresh load over time

### Configuration

```yaml
cache:
  refresh:
    enabled: true
    hit_window: "1m"        # Window for counting request frequency
    hot_threshold: 20       # Requests in hit_window to mark as "hot"
    min_ttl: "30s"          # Refresh threshold for normal entries
    hot_ttl: "2m"           # Refresh threshold for hot entries
    lock_ttl: "10s"         # Per-key refresh lock duration
    max_inflight: 50        # Max concurrent refreshes per instance
    sweep_interval: "15s"   # How often the sweeper runs
    sweep_window: "2m"      # How far ahead the sweeper scans
    max_batch_size: 2000    # Max keys processed per sweep
    sweep_min_hits: 1       # Min hits in sweep_hit_window to refresh
    sweep_hit_window: "168h" # Time window for sweep_min_hits (7 days)
```

### Monitoring

View refresh statistics:

```bash
curl http://localhost:8081/cache/refresh/stats
```

Response includes:
```json
{
  "last_sweep_time": "2024-01-15T10:30:00Z",
  "last_sweep_count": 47,
  "average_per_sweep_24h": 52.3,
  "sweeps_24h": 5760,
  "refreshed_24h": 301248
}
```

## Stale Serving

### Description

Serve slightly expired cache entries while refreshing them in the background, avoiding hard cache misses.

### Behavior

1. Entry soft TTL expires (based on DNS TTL)
2. For up to 5 minutes after expiry:
   - Serve stale entry to client immediately
   - Schedule background refresh
   - Client gets instant response
3. After stale TTL expires: hard cache miss (fetch from upstream)

### Benefits

- **No latency spikes**: Clients never wait for refresh
- **Better user experience**: Consistently fast responses
- **Resilience**: Works even if refresh temporarily fails

### Configuration

```yaml
cache:
  refresh:
    serve_stale: true       # Enable stale serving
    stale_ttl: "5m"         # Max time to serve stale entries
```

## Performance Tuning Guide

### For Maximum Cache Hit Rate

```yaml
cache:
  min_ttl: "600s"           # Cache entries for at least 10 minutes
  max_ttl: "3h"             # Allow longer caching
  redis:
    lru_size: 50000         # Large L0 cache
  refresh:
    hot_ttl: "5m"           # Refresh hot entries earlier
    min_ttl: "1m"           # Refresh normal entries earlier
    sweep_window: "5m"      # Scan further ahead
```

### For Minimum Upstream Load

```yaml
cache:
  min_ttl: "900s"           # 15 minute minimum
  max_ttl: "6h"             # 6 hour maximum
  refresh:
    enabled: true
    hot_ttl: "10m"          # Very early refresh
    sweep_window: "10m"     # Wide sweep window
    sweep_min_hits: 0       # Refresh all entries
```

### For Minimum Memory Usage

```yaml
cache:
  redis:
    lru_size: 1000          # Small L0 cache
  refresh:
    enabled: false          # Disable refresh-ahead
```

### For Maximum Throughput

```yaml
cache:
  redis:
    lru_size: 100000        # Very large L0 cache
  refresh:
    max_inflight: 200       # More concurrent refreshes
    max_batch_size: 2000    # Larger sweep batches
```

## Benchmarking

### Running Performance Tests

Use the built-in performance tester:

```bash
# Test with cold cache
go run ./cmd/perf-tester \
  -resolver 127.0.0.1:53 \
  -flush-redis \
  -queries 10000 \
  -concurrency 50

# Test with warm cache (run twice)
go run ./cmd/perf-tester \
  -resolver 127.0.0.1:53 \
  -queries 10000 \
  -concurrency 50 \
  -warmup 5000

# Test with custom domain list
go run ./cmd/perf-tester \
  -names domains.txt \
  -queries 50000 \
  -concurrency 100
```

### Interpreting Results

**Cold cache (first run):**
- Latency: 10-50ms (upstream dependent)
- QPS: Limited by upstream

**Warm cache (L1 only):**
- Latency: 0.5-2ms (Redis latency)
- QPS: 50K-100K per instance

**Hot cache (L0 + L1):**
- Latency: 0.01-0.05ms (in-memory)
- QPS: 500K-1M+ per instance

### Expected Performance

With default configuration:

| Metric | Cold Cache | Warm Cache (L1) | Hot Cache (L0) |
|--------|------------|-----------------|----------------|
| P50 Latency | 15ms | 0.8ms | 0.02ms |
| P95 Latency | 35ms | 1.5ms | 0.05ms |
| P99 Latency | 50ms | 2.5ms | 0.1ms |
| QPS per instance | 2K | 80K | 800K |
| Cache hit rate | 0% | 85-95% | 95-99% |

## Monitoring and Metrics

### Cache Statistics

```bash
# Overall cache stats (L0 + L1)
curl http://localhost:8081/cache/stats

# Refresh statistics
curl http://localhost:8081/cache/refresh/stats

# Blocklist and bloom filter stats
curl http://localhost:8081/blocklists/stats
```

### Key Metrics to Monitor

1. **Cache hit rate**: Target >95% for production
2. **L0 cache fill ratio**: Target 80-95%
3. **Refresh sweep count**: Should be consistent
4. **Bloom filter FPR**: Should be <0.1%
5. **Average query latency**: Target <2ms

### Troubleshooting

**Low cache hit rate (<80%)**
- Increase L0 cache size
- Increase min_ttl
- Enable refresh-ahead

**High latency (>5ms average)**
- Check Redis latency
- Increase L0 cache size
- Verify bloom filter is working

**High memory usage**
- Decrease L0 cache size
- Decrease max_ttl
- Enable Redis eviction

**High upstream query rate**
- Enable refresh-ahead
- Increase hot_ttl and min_ttl thresholds
- Increase sweep_window

## Best Practices

1. **Start with defaults**: The default configuration works well for most deployments
2. **Monitor before tuning**: Collect metrics for at least 24 hours before optimization
3. **Tune incrementally**: Change one parameter at a time
4. **Test under load**: Use the performance tester to validate changes
5. **Consider memory**: L0 cache uses ~1-5KB per entry
6. **Plan for peak load**: Size caches for 2× expected peak QPS
7. **Use refresh-ahead**: Enabled by default, provides consistent performance
8. **Enable stale serving**: Improves user experience during refresh

## Architecture Considerations

### Single Instance

For single-instance deployments:
- L0 cache provides the most benefit
- Redis is still useful for persistence
- Consider larger L0 cache (50K-100K entries)

### Multi-Instance Cluster

For clustered deployments:
- Shared Redis L1 cache is critical
- Each instance has its own L0 cache
- Hot entries may be duplicated across instances
- Consider smaller L0 cache per instance (10K-20K entries)

### High Availability

For HA deployments:
- Use Redis Sentinel or Cluster
- Redis uses RDB every 5 minutes by default; AOF is disabled (cache repopulates quickly)
- Set appropriate timeouts
- Monitor Redis health

## Summary

The multi-tier caching architecture provides:

- **3-4 orders of magnitude** latency improvement for hot queries
- **80-95%** reduction in upstream queries
- **Consistent performance** through refresh-ahead
- **Memory efficiency** through bloom filters and LRU eviction
- **Scalability** to millions of queries per second

The combination of L0 (in-memory), L1 (Redis), bloom filters, and refresh-ahead creates a robust, high-performance DNS caching system suitable for production use at scale.
