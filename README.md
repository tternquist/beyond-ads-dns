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

## Usage

The resolver reads a YAML config file. By default it looks for
`config/config.yaml`. You can override this with `-config` or
`CONFIG_PATH`.

Run locally:

```
go run ./cmd/beyond-ads-dns -config config/config.yaml
```

Copy and edit the example config to customize blocklists and upstreams:

```
cp config/config.example.yaml config/config.yaml
```

### Config overview

```
server:
  listen: ["0.0.0.0:53"]
  protocols: ["udp", "tcp"]
  read_timeout: "5s"
  write_timeout: "5s"

upstreams:
  - name: cloudflare
    address: "1.1.1.1:53"

blocklists:
  refresh_interval: "6h"
  sources:
    - name: hagezi-pro
      url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt"
  allowlist: []
  denylist: []

cache:
  redis:
    address: "redis:6379"
    db: 0
    password: ""
  min_ttl: "30s"
  max_ttl: "1h"
  negative_ttl: "5m"

response:
  blocked: "nxdomain"
  blocked_ttl: "5m"
```

## Next steps

1. Add metrics and health endpoints.
2. Add DoT/DoH upstream options.
3. Add structured logging and query sampling.

## Docker

Build the image:

```
docker build -t beyond-ads-dns .
```

Run with the sample compose file:

```
docker compose up --build
```

The compose file mounts the YAML config at
`/etc/beyond-ads-dns/config.yaml` and sets `CONFIG_PATH` accordingly.
Edit `config/config.yaml` to customize blocklists and upstreams.