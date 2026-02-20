# ClickHouse Disk Writes

When running ClickHouse for query analytics, `iotop` may show consistent disk writes from several ClickHouse threads. This document explains what causes them and how to reduce them.

## Write Sources

| Thread | Cause | Can Reduce? |
|--------|-------|-------------|
| **SystemLogFlush** | Flushes internal system tables (query_log, part_log, metric_log, etc.) to disk | Yes – disable system logs in config |
| **MergeMutate** | MergeTree background merges + TTL mutations (dropping expired rows) | Partially – merges are essential; TTL mutations required for retention |

## Application Settings (beyond-ads-dns)

These settings control *when* the app's query data is written:

- **`flush_to_store_interval`** (default `5s`): How often the app sends buffered events to ClickHouse
- **`flush_to_disk_interval`** (default `5s`): How often ClickHouse flushes async inserts to disk (`async_insert_busy_timeout_ms`)

These do **not** control SystemLogFlush or MergeMutate writes.

## Reducing SystemLogFlush Writes

The Docker Compose examples use a config that disables internal system tables:

```xml
<clickhouse>
  <trace_log remove="1"/>
  <query_log remove="1"/>
  <part_log remove="1"/>
  <metric_log remove="1"/>
  <asynchronous_metric_log remove="1"/>
  <logger>
    <level>information</level>
  </logger>
</clickhouse>
```

This config is in `db/clickhouse/config.d/disable-trace-log.xml` and is mounted as `minimal-disk-writes.xml` in the Docker examples. Disabling these tables should significantly reduce or eliminate SystemLogFlush writes.

**Trade-off:** You lose access to `system.query_log`, `system.part_log`, etc. for debugging. For query analytics, the app's `dns_queries` table is sufficient.

**Applying the config:** Restart ClickHouse for config changes to take effect (`docker compose restart clickhouse`).

## MergeMutate Writes

MergeMutate writes come from:

1. **Merges** – MergeTree compacts parts (required for the engine)
2. **Mutations** – TTL drops expired rows

The schema uses **partition-level TTL** with hourly partitions (`PARTITION BY toStartOfHour(ts)` + `TTL toStartOfHour(ts) + INTERVAL N HOUR`). Expired partitions are dropped as a whole—no row-level mutations. Hourly partitions enable sub-day retention (e.g. `retention_hours: 12`) for resource-constrained setups.

If you have an existing table from before this change, run the migration: see [`db/clickhouse/PARTITION_TTL_MIGRATION.md`](../db/clickhouse/PARTITION_TTL_MIGRATION.md).

**For minimal writes (e.g. Raspberry Pi on microSD):** Use the [Raspberry Pi example](../examples/raspberry-pi-docker-compose/), which runs ClickHouse entirely in memory (tmpfs for `/var/lib/clickhouse`). Analytics work but are lost on restart; no disk writes occur.

**Max table size (tmpfs):** ClickHouse has no built-in max database size. Default is unlimited. When using tmpfs, set `query_store.max_size_mb` (e.g. 200 for a 256MB tmpfs) or the `QUERY_STORE_MAX_SIZE_MB` env variable so the app drops oldest partitions when over the limit—preventing OOM.
