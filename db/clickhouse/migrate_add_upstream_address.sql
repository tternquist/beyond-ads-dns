-- Migration: Add upstream_address column to dns_queries table
-- Tracks which upstream server was used for forwarded queries (outcome=upstream, servfail)

ALTER TABLE beyond_ads.dns_queries 
ADD COLUMN IF NOT EXISTS upstream_address LowCardinality(String) DEFAULT '';
