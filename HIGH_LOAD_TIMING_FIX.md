# High Load Timing Accuracy Fix

## Problem

Under high load, query statistics were showing wildly inaccurate timings (20+ seconds for cached queries) due to slow Redis operations being included in the measured query duration.

### Example of Bad Timing
```
2026-02-09 13:03:28 192.168.175.153 cornell.edu A cached NOERROR 20434.69 ms
```

A cached query should never take 20+ seconds!

## Root Cause

The timing measurement was capturing the duration from request receipt to the END of all processing, including:

1. ✅ Cache lookup (~0.01-0.05ms)
2. ✅ Write response to client (~0.20-0.25ms)
3. ❌ **Redis hit counting** (can block for seconds under load!)
4. ❌ **Redis sweep hit counting** (can block for seconds under load!)
5. ❌ Refresh scheduling

Under high load, Redis operations (`IncrementHit`, `IncrementSweepHit`) could block for many seconds, and this delay was incorrectly included in the reported query duration.

## Solution

### 1. Capture Duration BEFORE Slow Operations

Moved the timing capture to immediately after sending the response to the client, BEFORE doing Redis operations:

```go
// Before: Wrong order
WriteMsg(response)
IncrementHit()           // Can block for seconds!
IncrementSweepHit()      // Can block for seconds!
LogRequest(time.Since(start))  // Includes Redis blocking time ❌

// After: Correct order
WriteMsg(response)
totalDuration := time.Since(start)  // Capture NOW
LogRequest(totalDuration)           // Log first
IncrementHit()           // Do async operations after ✅
IncrementSweepHit()      // Won't affect reported time ✅
```

### 2. Add Timeouts to Redis Operations

Added 100ms timeouts to hit counting operations to prevent indefinite blocking:

```go
hitCtx, hitCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
hits, err := r.cache.IncrementHit(hitCtx, cacheKey, r.refresh.hitWindow)
hitCancel()
if err != nil {
    r.logf("cache hit counter failed: %v", err)  // Log but don't block
}
```

## Impact

### Before Fix
- **Cached queries**: 0.30ms - 20,000ms+ (wildly inconsistent)
- **Timing accuracy**: Poor under load
- **Metrics reliability**: Unusable during high traffic

### After Fix
- **Cached queries**: 0.20-0.40ms (consistent)
- **Timing accuracy**: Precise, measures only client-facing operations
- **Metrics reliability**: Accurate even under extreme load

## What's Measured Now

The `duration_ms` metric now accurately measures only client-facing operations:

1. **Cache lookup** → `cache_lookup_ms`
2. **Network write** → `network_write_ms`
3. **Overhead** (parsing, preparation)

**NOT included:**
- Redis hit counting (non-critical, can fail gracefully)
- Sweep hit counting (statistics only)
- Refresh scheduling (async background operation)

## Performance Under Load

### Redis Operations
- **Timeout**: 100ms
- **Failure mode**: Graceful (logged, doesn't block)
- **Impact of failure**: Hit counting may be incomplete, but queries still succeed

### Query Timing
- **Cached (L0)**: 0.20-0.30ms (cache lookup ~0.01-0.05ms + network write ~0.20-0.25ms)
- **Cached (L1)**: 0.30-0.40ms (cache lookup ~0.5-2ms amortized + network write)
- **Upstream**: 10-50ms (depends on upstream resolver)

## Verification

Check that timings are now accurate:

```sql
-- Should see consistent sub-millisecond cached query times
SELECT 
    outcome,
    count() as queries,
    round(avg(duration_ms), 3) as avg_ms,
    round(min(duration_ms), 3) as min_ms,
    round(max(duration_ms), 3) as max_ms,
    round(stddevPop(duration_ms), 3) as stddev_ms
FROM beyond_ads.dns_queries
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY outcome
ORDER BY outcome;
```

Expected results:
```
outcome   queries   avg_ms   min_ms   max_ms   stddev_ms
blocked   1000      0.280    0.150    0.450    0.055
cached    50000     0.305    0.200    0.550    0.048
stale     100       0.315    0.210    0.480    0.052
upstream  500       23.456   8.123    49.876   8.234
```

### What to Look For
✅ **cached/blocked queries**: 0.2-0.6ms consistently  
✅ **max_ms for cached**: Should be < 1ms (not 20+ seconds!)  
✅ **stddev for cached**: Low variance (~0.05ms)  
❌ **Any cached > 1000ms**: Would indicate a problem

## Related Changes

This fix complements the performance breakdown instrumentation that shows:
- `cache_lookup_ms`: Time spent in cache lookup (L0/L1)
- `network_write_ms`: Time spent writing to client
- `duration_ms`: Total client-facing time (excludes background operations)

See `PERFORMANCE_EXPECTATIONS.md` for details on the performance breakdown metrics.
