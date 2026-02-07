CREATE DATABASE IF NOT EXISTS beyond_ads;

CREATE TABLE IF NOT EXISTS beyond_ads.dns_queries
(
    ts DateTime,
    client_ip String,
    protocol LowCardinality(String),
    qname String,
    qtype LowCardinality(String),
    qclass LowCardinality(String),
    outcome LowCardinality(String),
    rcode LowCardinality(String),
    duration_ms UInt32
)
ENGINE = MergeTree
ORDER BY (ts, qname)
TTL ts + INTERVAL 30 DAY;
