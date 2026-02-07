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

request_log:
  enabled: true
  directory: "logs"
  filename_prefix: "dns-requests"

query_store:
  enabled: true
  address: "http://clickhouse:8123"
  database: "beyond_ads"
  table: "dns_queries"
  username: "beyondads"
  password: "beyondads"
  flush_interval: "5s"
  batch_size: 500

control:
  enabled: true
  listen: "0.0.0.0:8081"
  token: ""
```

Request logging is enabled by default and rotates daily. Set
`request_log.enabled: false` to disable it.

Query storage uses ClickHouse and is enabled by default. Set
`query_store.enabled: false` to disable it.
The ClickHouse schema lives in `db/clickhouse/init.sql`.
The default Docker Compose credentials are `beyondads`/`beyondads`.

The control server is used by the UI to apply blocklist changes. If you
set `control.token`, the UI must send the same token via
`DNS_CONTROL_TOKEN` in the metrics API.

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

The request log is written to `./logs` on the host (mounted at
`/app/logs` in the container). Ensure the `logs` directory exists or let
Docker create it on first run.

## Metrics UI

The metrics UI is a React app backed by a Node.js API. It currently
surfaces Redis cache statistics, recent query rows, and blocklist
management (when the control server is enabled).

Run via Docker Compose (recommended):

```
docker compose up --build
```

Visit:

```
http://localhost:3001
```

Local development:

```
cd web/server && npm install && npm run dev
cd web/client && npm install && npm run dev
```

## Performance testing

Use the built-in harness to run large query bursts and optionally flush
Redis between runs:

```
go run ./cmd/perf-tester -resolver 127.0.0.1:53 -flush-redis
```

See `tools/perf/README.md` for more options (warmup, TCP, custom name
lists, etc).