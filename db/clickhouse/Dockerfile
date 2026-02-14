# Extends official ClickHouse with trace_log disabled by default.
# Build from repo root: docker build -f db/clickhouse/Dockerfile .
FROM clickhouse/clickhouse-server:24.12
COPY db/clickhouse/config.d/disable-trace-log.xml /etc/clickhouse-server/config.d/
