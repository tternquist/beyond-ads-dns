#!/bin/bash

# Performance benchmarking script for beyond-ads-dns
# This script runs various performance tests and reports results

set -e

RESOLVER="${RESOLVER:-127.0.0.1:53}"
REDIS_ADDR="${REDIS_ADDR:-localhost:6379}"
QUERIES="${QUERIES:-10000}"
CONCURRENCY="${CONCURRENCY:-50}"

echo "==================================================="
echo "Beyond-ads-dns Performance Benchmark"
echo "==================================================="
echo "Resolver: $RESOLVER"
echo "Redis: $REDIS_ADDR"
echo "Queries: $QUERIES"
echo "Concurrency: $CONCURRENCY"
echo "==================================================="
echo ""

# Test 1: Cold cache (everything from upstream)
echo "Test 1: Cold Cache (flush Redis first)"
echo "---------------------------------------------------"
go run ../../cmd/perf-tester \
  -resolver "$RESOLVER" \
  -redis-addr "$REDIS_ADDR" \
  -flush-redis \
  -queries "$QUERIES" \
  -concurrency "$CONCURRENCY" \
  2>&1 | tee cold-cache.log
echo ""
echo ""

# Wait a bit for any background refreshes
sleep 2

# Test 2: Warm cache (L1 Redis only, clear L0)
echo "Test 2: Warm Cache (L1 Redis, no warmup)"
echo "---------------------------------------------------"
go run ../../cmd/perf-tester \
  -resolver "$RESOLVER" \
  -redis-addr "$REDIS_ADDR" \
  -queries "$QUERIES" \
  -concurrency "$CONCURRENCY" \
  2>&1 | tee warm-cache.log
echo ""
echo ""

# Wait a bit
sleep 2

# Test 3: Hot cache (L0 + L1, with warmup)
echo "Test 3: Hot Cache (L0 + L1, with warmup)"
echo "---------------------------------------------------"
go run ../../cmd/perf-tester \
  -resolver "$RESOLVER" \
  -redis-addr "$REDIS_ADDR" \
  -queries "$QUERIES" \
  -concurrency "$CONCURRENCY" \
  -warmup 5000 \
  2>&1 | tee hot-cache.log
echo ""
echo ""

# Test 4: High concurrency test (stress test)
echo "Test 4: High Concurrency (200 concurrent)"
echo "---------------------------------------------------"
go run ../../cmd/perf-tester \
  -resolver "$RESOLVER" \
  -redis-addr "$REDIS_ADDR" \
  -queries "$QUERIES" \
  -concurrency 200 \
  -warmup 2000 \
  2>&1 | tee high-concurrency.log
echo ""
echo ""

# Test 5: Large dataset test
echo "Test 5: Large Dataset (50k queries)"
echo "---------------------------------------------------"
go run ../../cmd/perf-tester \
  -resolver "$RESOLVER" \
  -redis-addr "$REDIS_ADDR" \
  -queries 50000 \
  -concurrency "$CONCURRENCY" \
  -warmup 10000 \
  2>&1 | tee large-dataset.log
echo ""
echo ""

echo "==================================================="
echo "Benchmark Complete"
echo "==================================================="
echo "Results saved to:"
echo "  - cold-cache.log (cold cache performance)"
echo "  - warm-cache.log (L1 Redis performance)"
echo "  - hot-cache.log (L0+L1 performance)"
echo "  - high-concurrency.log (stress test)"
echo "  - large-dataset.log (scalability test)"
echo ""
echo "Summary:"
echo "---------------------------------------------------"
grep "latency (ms):" cold-cache.log | head -1 | sed 's/^/Cold Cache:  /'
grep "latency (ms):" warm-cache.log | head -1 | sed 's/^/Warm Cache:  /'
grep "latency (ms):" hot-cache.log | head -1 | sed 's/^/Hot Cache:   /'
grep "qps:" cold-cache.log | sed 's/^/Cold QPS:    /'
grep "qps:" warm-cache.log | sed 's/^/Warm QPS:    /'
grep "qps:" hot-cache.log | sed 's/^/Hot QPS:     /'
echo "==================================================="
