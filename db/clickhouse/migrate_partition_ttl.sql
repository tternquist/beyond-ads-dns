-- Migration: Switch from row-level TTL to partition-level TTL
-- Reduces MergeMutate disk writes by dropping entire partitions instead of mutating rows.
--
-- Run this ONLY if you have an existing dns_queries table from before this change.
-- New installations get the correct schema automatically.
--
-- Prerequisites: Stop the application during migration to avoid insert conflicts.
-- For large tables, the INSERT may take several minutes.

-- Ensure client_name exists (for tables created from older init.sql)
ALTER TABLE beyond_ads.dns_queries ADD COLUMN IF NOT EXISTS client_name String DEFAULT '';

-- Create new table with partition-level TTL
CREATE TABLE beyond_ads.dns_queries_new
(
    ts DateTime,
    client_ip String,
    client_name String DEFAULT '',
    protocol LowCardinality(String),
    qname String,
    qtype LowCardinality(String),
    qclass LowCardinality(String),
    outcome LowCardinality(String),
    rcode LowCardinality(String),
    duration_ms Float64,
    cache_lookup_ms Float64 DEFAULT 0,
    network_write_ms Float64 DEFAULT 0,
    upstream_address LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (ts, qname)
TTL toDate(ts) + INTERVAL 7 DAY;

-- Migrate data
INSERT INTO beyond_ads.dns_queries_new
SELECT ts, client_ip, client_name, protocol, qname, qtype, qclass, outcome, rcode,
       duration_ms, cache_lookup_ms, network_write_ms, upstream_address
FROM beyond_ads.dns_queries;

-- Swap tables
DROP TABLE beyond_ads.dns_queries;
RENAME TABLE beyond_ads.dns_queries_new TO beyond_ads.dns_queries;
