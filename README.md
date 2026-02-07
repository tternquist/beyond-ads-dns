# beyond-ads-dns

Ad-blocking DNS resolver that uses public blocklists (e.g. Hagezi)
and Redis caching to reduce upstream traffic.

## Recommendation (language + stack)

**Primary choice: Go**

Why Go is the best fit for a DNS resolver:

- Low-latency UDP/TCP networking and easy concurrency (goroutines).
- Small, static binaries with straightforward deployment.
- Strong, mature DNS libraries (notably `miekg/dns`).
- Great performance without the complexity of manual memory management.

Proposed stack:

- **Language**: Go
- **DNS library**: `miekg/dns`
- **Cache**: Redis (go-redis client)
- **Blocklist ingestion**: configurable list sources (Hagezi by default)
- **Observability**: structured logs + Prometheus metrics
- **Packaging**: Docker image + systemd service option
- **Config**: YAML (file-based)

For the full evaluation and architecture notes, see
[`docs/stack-evaluation.md`](docs/stack-evaluation.md).

## High-level behavior

- Incoming queries (UDP + TCP) are checked against blocklists.
- If blocked, return NXDOMAIN (configurable).
- Otherwise:
  - Check Redis cache by qname/qtype.
  - If cached, return cached answer (respecting TTL).
  - If not cached, forward to upstream(s) (Cloudflare by default),
    cache response, return.

## Next steps

1. Implement a minimal Go resolver with UDP/TCP listeners.
2. Add Redis caching with TTL + negative caching (RFC 2308).
3. Build blocklist ingestion + hot reload.
4. Add metrics, config file, and docker packaging.