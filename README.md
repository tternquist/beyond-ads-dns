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

The resolver loads a default config from `config/default.yaml` and then
applies any overrides found in `config/config.yaml` (gitignored). You can
override the user config path with `-config` or `CONFIG_PATH`, and the
default path with `DEFAULT_CONFIG_PATH`.

Run locally:

```
go run ./cmd/beyond-ads-dns -config config/config.yaml
```

Create a user override config to customize blocklists and upstreams:

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
  min_ttl: "300s"
  max_ttl: "1h"
  negative_ttl: "5m"
  refresh:
    enabled: true
    hit_window: "1m"
    hot_threshold: 20
    min_ttl: "30s"
    hot_ttl: "2m"
    serve_stale: true
    stale_ttl: "5m"
    lock_ttl: "10s"
    max_inflight: 50
    sweep_interval: "15s"
    sweep_window: "2m"
    batch_size: 200

response:
  blocked: "nxdomain"
  blocked_ttl: "1h"

request_log:
  enabled: false
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

Request logging is disabled by default. Set
`request_log.enabled: true` to enable daily rotation.

Cache refresh-ahead is enabled by default. The resolver will
preemptively refresh hot entries when they are close to expiring. Tune
`cache.refresh.*` to adjust how aggressive the refresh should be.
The sweeper periodically scans for keys nearing expiration and refreshes
them, even if they are not actively requested.
Stale serving keeps expired entries available for `cache.refresh.stale_ttl`
while background refreshes keep them up to date.
Cache entries are stored without Redis TTLs; soft expiry is tracked
internally so keys persist until Redis evicts them.
Metadata keys (hit counters, locks, sweep index) use the `dnsmeta:`
prefix and may have TTLs; cache entries keep the `dns:` prefix and do
not expire.

### Cache refresh details

The cache keeps two notions of expiry:

- **Soft expiry**: the original DNS TTL (after clamping). This decides
  whether a response is "fresh" or "stale".
- **Redis eviction**: keys do not have Redis TTLs. They remain until
  Redis evicts them based on its configured policy/memory limits.

#### Refresh paths

There are two refresh mechanisms that can run together:

1. **Request‑driven refresh (refresh‑ahead)**  
   When a cached entry is served and its soft TTL is low, the resolver
   refreshes it in the background. The threshold is based on recent
   request frequency:
   - If the entry has been requested **at least `hot_threshold` times**
     within `hit_window`, it is treated as "hot" and refreshed once its
     soft TTL is below `hot_ttl`.
   - Otherwise, it refreshes once soft TTL is below `min_ttl`.

2. **Periodic sweeper**  
   The sweeper runs every `sweep_interval`, scanning the internal
   soft‑expiry index for keys expiring within `sweep_window`. It schedules
   refreshes for keys that are close to expiry **and** that have seen at
   least `sweep_min_hits` within `sweep_hit_window`. Hits are recorded on
   cache serves and on successful cache writes after upstream responses.

Both refresh paths are protected by a **distributed lock** (per key) and
a **local inflight limit**, so a single hot key won’t trigger stampedes.

#### Stale serving

If `serve_stale` is enabled, the resolver will serve expired entries for
up to `stale_ttl` **after soft expiry**, while a refresh is scheduled in
the background. This avoids a hard cache miss for clients when the entry
has just gone stale.

#### Configuration reference

```
cache:
  refresh:
    enabled: true          # Master switch for refresh-ahead + sweeper
    hit_window: "1m"       # Window for counting request frequency
    hot_threshold: 20      # Requests in hit_window to mark as "hot"
    min_ttl: "30s"         # Refresh threshold for non-hot entries
    hot_ttl: "2m"          # Refresh threshold for hot entries
    serve_stale: true      # Serve expired entries within stale_ttl
    stale_ttl: "5m"        # Max time to serve stale entries
    lock_ttl: "10s"        # Per-key refresh lock in Redis
    max_inflight: 50       # Max concurrent refreshes per instance
    sweep_interval: "15s"  # How often the sweeper runs
    sweep_window: "2m"     # How far ahead the sweeper scans
    batch_size: 200        # Max keys processed per sweep
    sweep_min_hits: 1      # Min hits in sweep_hit_window to refresh
    sweep_hit_window: "168h" # Time window for sweep_min_hits
```

#### Tuning guidance

- **More aggressive refresh**: increase `hot_ttl`/`min_ttl`, shorten
  `sweep_interval`, or increase `sweep_window`.
- **Less upstream load**: decrease `hot_ttl`/`min_ttl` and increase
  `hit_window` or `hot_threshold`.
- **Avoid stampedes**: keep `lock_ttl` >= expected upstream latency and
  set `max_inflight` to a reasonable limit for your instance.

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
http://localhost
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