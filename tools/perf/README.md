# Performance test harness

This harness sends high-volume DNS queries to the resolver and can
flush Redis before running to enable easy regressions.

## Quick start

### Run comprehensive benchmark suite

The benchmark script runs multiple tests to measure performance across different caching levels:

```bash
cd tools/perf
./benchmark.sh
```

This will run:
1. Cold cache test (everything from upstream)
2. Warm cache test (L1 Redis only)
3. Hot cache test (L0 + L1)
4. High concurrency stress test
5. Large dataset scalability test

### Run individual tests

Run 10k queries against the local resolver, flush Redis first:

```bash
go run ./cmd/perf-tester \
  -resolver 127.0.0.1:53 \
  -flush-redis \
  -redis-addr localhost:6379 \
  -queries 10000 \
  -concurrency 50
```

## Use a generated list of names

By default, the harness generates 10k synthetic DNS names. You can
write the generated list to a file:

```
go run ./cmd/perf-tester -generate 20000 -write-names tools/perf/names.txt
```

Then reuse the list:

```
go run ./cmd/perf-tester -names tools/perf/names.txt -queries 20000
```

## Notes

- Use `-warmup` to pre-fill caches before measurement.
- Set `-protocol tcp` to force TCP queries.
- Use `-qtype AAAA` to test different query types.
