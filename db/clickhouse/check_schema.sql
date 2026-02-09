-- Check if the duration_ms column needs migration
-- If this shows UInt32, you need to run the migration
-- If this shows Float64, the migration is complete

SELECT 
    name,
    type,
    comment
FROM system.columns
WHERE 
    database = 'beyond_ads' 
    AND table = 'dns_queries' 
    AND name = 'duration_ms';
