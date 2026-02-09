# Performance Breakdown Columns Migration

This migration adds detailed performance breakdown columns to the `dns_queries` table to help understand where time is being spent in DNS query handling.

## New Columns

- **`cache_lookup_ms`** (Float64): Time spent looking up the response in L0 (in-memory) and L1 (Redis) caches
- **`network_write_ms`** (Float64): Time spent writing the DNS response to the client over the network

## Understanding Performance

The existing `duration_ms` column measures **end-to-end latency** from receiving the request to sending the response. With these new columns, you can now see the breakdown:

```
duration_ms = cache_lookup_ms + network_write_ms + overhead
```

Where overhead includes:
- DNS message parsing and preparation
- Hit counting and statistics
- Logging
- Other processing

## Typical Values for Cached Queries

For queries served from cache (outcome='cached'):

- **cache_lookup_ms**: 0.010-0.050ms (10-50 microseconds)
  - L0 cache hits: ~0.010-0.020ms (fastest)
  - L1 cache hits: ~0.030-0.050ms (Redis lookup)
  
- **network_write_ms**: 0.150-0.300ms (150-300 microseconds)
  - Local network: ~0.150-0.200ms
  - Remote clients: 0.200-0.300ms+

- **Total duration_ms**: 0.200-0.400ms (typical for cached responses)

## Running the Migration

### For Existing Installations

```bash
# Connect to ClickHouse and run the migration
clickhouse-client --host localhost --port 9000 \
  --query "$(cat db/clickhouse/migrate_add_performance_columns.sql)"
```

Or via HTTP:

```bash
curl "http://localhost:8123/" \
  --data-binary @db/clickhouse/migrate_add_performance_columns.sql
```

### For New Installations

The columns are automatically created when using `init.sql`.

## Verifying the Migration

```sql
-- Check that columns exist
DESCRIBE beyond_ads.dns_queries;

-- View performance breakdown for recent cached queries
SELECT 
    qname,
    duration_ms,
    cache_lookup_ms,
    network_write_ms,
    duration_ms - cache_lookup_ms - network_write_ms as overhead_ms
FROM beyond_ads.dns_queries
WHERE outcome = 'cached'
  AND ts >= now() - INTERVAL 1 HOUR
ORDER BY ts DESC
LIMIT 100;

-- Average performance breakdown
SELECT 
    outcome,
    round(avg(duration_ms), 3) as avg_total_ms,
    round(avg(cache_lookup_ms), 3) as avg_cache_ms,
    round(avg(network_write_ms), 3) as avg_network_ms,
    round(avg(duration_ms - cache_lookup_ms - network_write_ms), 3) as avg_overhead_ms
FROM beyond_ads.dns_queries
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY outcome
ORDER BY outcome;
```

## Impact

- **Backward Compatible**: Existing queries continue to work
- **Storage**: Minimal increase (~16 bytes per row)
- **Performance**: No impact on query insertion or retrieval
- **Default Values**: Old rows will show 0 for new columns (breakdown not available)
