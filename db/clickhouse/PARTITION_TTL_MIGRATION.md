# Partition-Level TTL Migration

## Why

The table previously used row-level TTL (`TTL ts + INTERVAL N DAY`), which causes ClickHouse to **mutate** (rewrite) parts to delete expired rows. That produces significant MergeMutate disk writes.

With **partition-level TTL** (`PARTITION BY toDate(ts)` + `TTL toDate(ts) + INTERVAL N DAY`), expired partitions are dropped as a whole. No mutations—just metadata updates and file removal. This greatly reduces MergeMutate writes.

## When to Run

- **Existing installations** with data in `beyond_ads.dns_queries`: run the migration
- **New installations**: the app creates the table with the correct schema automatically

## How to Run

1. **Stop the application** (or disable the query store) to avoid insert conflicts during migration.

2. Run the migration:

```bash
# Option 1: clickhouse-client
clickhouse-client --query="$(cat db/clickhouse/migrate_partition_ttl.sql)"

# Option 2: Docker
docker exec -i beyond-ads-clickhouse clickhouse-client < db/clickhouse/migrate_partition_ttl.sql

# Option 3: HTTP
curl 'http://localhost:8123/' --data-binary @db/clickhouse/migrate_partition_ttl.sql
```

3. **Restart the application.**

## Retention

The migration uses 7-day retention. To change it:

- Use the app's query store settings (`retention_hours`), or
- Run: `ALTER TABLE beyond_ads.dns_queries MODIFY TTL toDate(ts) + INTERVAL N DAY` (daily partitions) or `toStartOfHour(ts) + INTERVAL N HOUR` (hourly)

**Note:** New installs and tables created by the app now use hourly partitions (`PARTITION BY toStartOfHour(ts)`) for finer retention control. Existing daily-partition tables are automatically migrated to hourly on startup (data is dropped).

## Custom Database/Table

If you use a different database or table name, edit `migrate_partition_ttl.sql` and replace `beyond_ads` and `dns_queries` accordingly.
