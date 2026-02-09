-- Migration: Add performance breakdown columns to dns_queries table
-- This allows tracking cache lookup time vs network write time vs total time

ALTER TABLE beyond_ads.dns_queries 
ADD COLUMN IF NOT EXISTS cache_lookup_ms Float64 DEFAULT 0;

ALTER TABLE beyond_ads.dns_queries 
ADD COLUMN IF NOT EXISTS network_write_ms Float64 DEFAULT 0;
