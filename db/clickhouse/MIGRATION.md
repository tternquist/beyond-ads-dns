# ClickHouse Schema Migration

## Duration Precision Update

### Problem
If you're seeing all query durations as `0.00 ms` after upgrading, it's because the existing ClickHouse table still has the old `UInt32` column type for `duration_ms`. The backend is now sending Float64 values with decimal precision, but they're being truncated to integers.

### Solution

Run the migration script to update the column type:

```bash
# Option 1: Using clickhouse-client
clickhouse-client --query="$(cat db/clickhouse/migrate_duration_to_float64.sql)"

# Option 2: Using docker exec (if running in Docker)
docker exec -i clickhouse-server clickhouse-client < db/clickhouse/migrate_duration_to_float64.sql

# Option 3: Using HTTP API
curl 'http://localhost:8123/' --data-binary @db/clickhouse/migrate_duration_to_float64.sql
```

### Verification

After running the migration, verify the column type:

```sql
DESCRIBE beyond_ads.dns_queries;
```

You should see `duration_ms Float64` instead of `duration_ms UInt32`.

### About Precision

**2 decimal places = 0.01ms = 10 microseconds**

This precision level is sufficient for DNS queries because:
- **Cache hits**: Typically 0.10-0.50 ms (will show as 0.10-0.50 ms)
- **Upstream queries**: Typically 5-50 ms (will show full precision)
- **Very fast queries**: Even sub-0.01ms queries will show as 0.00 ms, which is acceptable

### Alternative: Recreate Table

If you don't have important historical data, you can drop and recreate the table:

```sql
DROP TABLE IF EXISTS beyond_ads.dns_queries;
```

Then restart the application - the `init.sql` will create the table with the correct schema.

**⚠️ Warning**: This will delete all existing query history!
