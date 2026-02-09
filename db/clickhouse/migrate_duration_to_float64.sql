-- Migration script to update duration_ms column from UInt32 to Float64
-- This is needed for existing tables to support sub-millisecond precision

-- Step 1: Alter the table to change the column type
ALTER TABLE beyond_ads.dns_queries 
MODIFY COLUMN duration_ms Float64;

-- Note: ClickHouse will automatically handle the type conversion
-- Existing integer values (0, 1, 2, etc.) will become 0.0, 1.0, 2.0, etc.
-- New values with decimal precision will be stored correctly
