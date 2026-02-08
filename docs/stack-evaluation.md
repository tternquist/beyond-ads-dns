# Stack evaluation for ad-blocking DNS resolver

## Goals

- Fast UDP/TCP DNS handling with low tail latency.
- Efficient caching to reduce upstream queries.
- Easy deployment on small servers or containers.
- Safe, maintainable codebase and predictable performance.

## Candidate languages (summary)

### Go (recommended)

Pros:
- Excellent concurrency model for DNS workloads.
- Mature DNS libraries (e.g. `miekg/dns`).
- Low operational overhead: static binaries, simple deploy.
- Great performance without complex memory management.

Cons:
- GC pauses exist (usually negligible for DNS workloads).
- Some lower-level DNS features still require careful handling.

### Rust

Pros:
- Top-tier performance and memory safety.
- Strong ecosystem for async networking.

Cons:
- More complex build and developer experience.
- Longer time-to-ship for early iterations.

### C/C++

Pros:
- Maximum performance and control.

Cons:
- Higher risk of memory safety bugs.
- More operational and maintenance overhead.

### Node.js

Pros:
- Fast to build and iterate.
- Large ecosystem.

Cons:
- UDP performance under heavy load can be weaker.
- Higher latency variability from GC and event loop backpressure.

### Python

Pros:
- Extremely fast development.

Cons:
- Not ideal for high-QPS UDP/TCP DNS workloads.

## Decision

**Go is the best overall fit** for the first production-ready version.
It balances performance, reliability, and developer velocity, with
excellent DNS libraries and a straightforward deployment story.

## Proposed architecture

```
UDP/TCP Listener -> Request Handler
                         |
                         +-> Blocklist Check (in-memory set)
                         |
                         +-> Redis Cache
                         |
                         +-> Upstream Forwarder
```

Key components:

- **Listener**: Handles UDP and TCP with EDNS0 support.
- **Blocklist**: In-memory set, built from configurable list sources
  (Hagezi by default).
- **Cache**: Redis, keyed by qname + qtype + qclass.
- **Forwarder**: Parallel upstreams with fast fallback (Cloudflare by
  default).
- **Metrics**: QPS, cache hit rate, block rate, upstream latency.
- **Config**: YAML file for upstreams, blocklists, and cache settings.

## Caching design (Redis)

Key format:

```
dns:<qname>:<qtype>:<qclass>
```

Value:

- Wire-encoded DNS response (binary), or
- Compact JSON/MsgPack (if response mutation is required).

TTL strategy:

- Use the lowest TTL in the answer section.
- Clamp to a reasonable min/max (e.g. min 300s, max 1h).
- **Negative caching** per RFC 2308 using SOA minimum TTL.

Additional ideas:

- Optional in-process LRU to reduce Redis round-trips.
- Stale-while-revalidate for resilience if Redis or upstreams are slow.

## Blocklist ingestion

- Fetch configured blocklists on a schedule (e.g. every 6 hours).
- Normalize domains, dedupe, store in an in-memory hash set.
- Optional compressed trie or bloom filter if memory is tight.
- Support local allowlist/denylist overrides.

## Observability

- Structured logs with query ID, qname, qtype, outcome.
- Prometheus metrics for cache hit rate and upstream latency.
- Health endpoint for readiness/liveness checks.

## Next engineering steps

1. Minimal UDP/TCP resolver in Go using `miekg/dns`.
2. Redis cache with TTL and negative caching.
3. Hagezi ingestion and hot reload.
4. Config, metrics, docker image, systemd unit.
