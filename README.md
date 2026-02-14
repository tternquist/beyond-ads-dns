# beyond-ads-dns

Ad-blocking DNS resolver that uses public blocklists (e.g. Hagezi)
and Redis caching to reduce upstream traffic.

## Running the application

**Recommended: Docker Compose.** The easiest way to run beyond-ads-dns is with one of the Docker Compose examples. They include Redis, ClickHouse, and the Metrics UI—no manual setup required.

| Example | Summary | Link |
|---------|---------|------|
| **Basic** | Minimal deployment using the published GHCR image (no build). Redis, ClickHouse, Metrics UI. | [`examples/basic-docker-compose/`](examples/basic-docker-compose/) |
| **Let's Encrypt** | Automatic HTTPS for the Metrics UI via Let's Encrypt. | [`examples/letsencrypt-docker-compose/`](examples/letsencrypt-docker-compose/) |
| **Grafana** | Adds Prometheus and Grafana for monitoring, dashboards, and query analytics. | [`examples/grafana-integration/`](examples/grafana-integration/) |
| **Max Performance** | Tuned for high throughput (2GB Redis, 100K L0 cache, higher batch sizes). | [`examples/max-performance-docker-compose/`](examples/max-performance-docker-compose/) |
| **Raspberry Pi** | MicroSD-friendly: No ClickHouse, tmpfs for Redis and logs. | [`examples/raspberry-pi-docker-compose/`](examples/raspberry-pi-docker-compose/) |
| **Unbound** | Unbound as recursive upstream—no third-party DNS, full DNSSEC validation. | [`examples/unbound-docker-compose/`](examples/unbound-docker-compose/) |

**Quick start (Basic example):**

```bash
cd examples/basic-docker-compose
docker compose up -d
```

- **DNS**: `localhost:53` (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

### Alternative: Non-Docker installation

If you cannot use Docker, you can run the resolver and its dependencies manually.

**Prerequisites:**

- **Go 1.24+** (to build the binary)
- **Redis** (required for DNS cache)
- **ClickHouse** (optional; disable with `query_store.enabled: false` in config)

**1. Build the binary:**

```bash
go build -o beyond-ads-dns ./cmd/beyond-ads-dns
```

**2. Create and edit config:**

```bash
cp config/config.example.yaml config/config.yaml
```

Edit `config/config.yaml` and set addresses for your local services:

- `cache.redis.address`: Redis address (e.g. `localhost:6379`)
- `query_store.address`: ClickHouse HTTP address (e.g. `http://localhost:8123`) if using query store
- `query_store.username` / `query_store.password`: ClickHouse credentials

If you disable the query store, set `query_store.enabled: false` and omit ClickHouse setup.

**3. Set up Redis and ClickHouse (if needed):**

- **Redis**: Install Redis (e.g. `apt install redis-server` on Debian/Ubuntu) and ensure it is running.
- **ClickHouse**: Install ClickHouse and create the schema from `db/clickhouse/init.sql`. Default credentials in the example config are `beyondads`/`beyondads`.

**4. Run the resolver:**

```bash
./beyond-ads-dns -config config/config.yaml
```

The Metrics UI (React app + Node.js API) is bundled in the Docker image. For non-Docker setups, run it separately—see the [Metrics UI](#metrics-ui) section.

## Architecture (data structures + algorithms)

### Blocklist compilation and matching

- **Sources**: blocklists are fetched on a schedule and parsed line‑by‑line.
- **Normalization**: each line is trimmed, comments removed, and common
  list formats are supported (hosts file lines, `||domain^` rules,
  AdBlock-style with `$important`, `$script`, `|https://domain^`, etc).
  Domains are lower‑cased, trailing dots removed, and `*.` stripped.
- **Storage**: entries are stored in an in‑memory hash set
  `map[string]struct{}` for O(1) lookups.
- **Overrides**:
  - `allowlist` entries are stored in a separate set and always win.
  - `denylist` entries are always blocked, even if not in blocklists.
- **Matching algorithm**: the query name is normalized and checked for
  suffix matches by progressively stripping left‑most labels
  (`ads.example.com` → `example.com` → `com`). This allows a single
  list entry to match subdomains efficiently.

### Cache layout and refresh

- **Cache key**: `dns:<qname>:<qtype>:<qclass>`
- **Value**: a Redis hash containing:
  - `msg`: wire‑encoded DNS response
  - `soft_expiry`: UNIX epoch for the soft TTL
- **Expiry index**: a sorted set `dnsmeta:expiry:index` keyed by
  `soft_expiry` to enable sweep scans.
- **Metadata**: hit counters and refresh locks use the `dnsmeta:` prefix
  and may expire; cache entries do not.
- **Redis eviction policy**: By default, Redis uses `allkeys-lru` (Least
  Recently Used) to evict keys when maxmemory is reached. This ensures
  that less-frequently accessed DNS entries are removed first when memory
  pressure occurs. Cache entries persist without Redis TTLs, so eviction
  is the only way they are removed from Redis (besides explicit deletes).
  Redis is configured via `config/redis.conf` (see below for details).
- **Refresh algorithms**:
  - **Refresh‑ahead**: on cache hit, refresh if soft TTL is below
    `min_ttl` or `hot_ttl` (for hot keys).
  - **Sweeper**: periodically scans the expiry index and refreshes keys
    close to expiry and with at least `sweep_min_hits` within
    `sweep_hit_window`.
- **Stale serving**: expired entries can be served for `stale_ttl`
  while refresh runs in the background.

### Query store and metrics

- **ClickHouse storage**: each query is inserted as a row with timestamp,
  client, qname, outcome, and latency. This powers query dashboards.
- **Response time measurement**: The `duration_ms` metric measures the
  **complete end-to-end response time** from when the query is received
  until the response is written back to the client. This includes:
  - Blocklist checking (if enabled)
  - Cache lookup time (Redis query)
  - Upstream DNS query time (if cache miss)
  - Cache write time (for new entries)
  - Network time to send the response to the client
  
  This is *not* just the upstream DNS response time—it captures the full
  request processing latency, giving you a complete picture of client
  experience.
- **Metrics API**: the Node.js API exposes Redis stats, query summaries,
  and refresh sweep stats to the UI.

### Control plane

- **Control server**: `/blocklists/reload` applies config changes by
  reloading blocklists without restarting the DNS service.

## Usage and configuration

The resolver loads a default config from `config/default.yaml` and then
applies any overrides found in `config/config.yaml` (gitignored). You can
override the user config path with `-config` or `CONFIG_PATH`, and the
default path with `DEFAULT_CONFIG_PATH`.

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

# Upstreams: plain DNS (host:port), DoT (tls://host:853), or DoH (https://host/dns-query)
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
    max_batch_size: 2000
    sweep_min_hits: 1
    sweep_hit_window: "168h"

response:
  blocked: "nxdomain"   # or IP (e.g. resolver IP) for block page; set to server IP to serve block page for blocked domains
  blocked_ttl: "1h"

request_log:
  enabled: false
  directory: "logs"
  filename_prefix: "dns-requests"
  format: "text"  # or "json" for structured logs with query_id

query_store:
  enabled: true
  address: "http://clickhouse:8123"
  database: "beyond_ads"
  table: "dns_queries"
  username: "beyondads"
  password: "beyondads"
  flush_interval: "5s"
  batch_size: 500
  sample_rate: 1.0  # Fraction to record (0.0-1.0). Use <1.0 to reduce load at scale.

control:
  enabled: true
  listen: "0.0.0.0:8081"
  token: ""

# Multi-instance sync (optional). Configure via Metrics UI Sync tab or manually:
# sync:
#   enabled: true
#   role: primary   # or replica
#   # Primary: tokens for replicas (created via UI)
#   tokens: []
#   # Replica only:
#   primary_url: "http://primary-host:8081"
#   sync_token: "token-from-primary"
#   sync_interval: "60s"
```

Request logging is disabled by default. Set
`request_log.enabled: true` to enable daily rotation.
Use `request_log.format: "json"` for structured JSON logs with `query_id`, `qname`, `outcome`, and `duration_ms`.
Query store supports `query_store.sample_rate` (0.0–1.0) to record a fraction of queries, reducing load at scale.

Cache refresh-ahead is enabled by default. The resolver will
preemptively refresh hot entries when they are close to expiring. Tune
`cache.refresh.*` to adjust how aggressive the refresh should be.
The sweeper periodically scans for keys nearing expiration and refreshes
them, even if they are not actively requested.
Stale serving keeps expired entries available for `cache.refresh.stale_ttl`
while background refreshes keep them up to date.
Cache entries are stored without Redis TTLs; soft expiry is tracked
internally so keys persist until Redis evicts them based on the
configured eviction policy (default: `allkeys-lru`).
Metadata keys (hit counters, locks, sweep index) use the `dnsmeta:`
prefix and may have TTLs; cache entries keep the `dns:` prefix and do
not expire.

#### Redis configuration

Redis is configured via `config/redis.conf`, which is mounted into the
Redis container. The default configuration sets:

- **`maxmemory 512mb`**: Memory limit before eviction
- **`maxmemory-policy allkeys-lru`**: Eviction policy

Available eviction policies:

- **`allkeys-lru`** (default): Evict least recently used keys from all keys
- **`allkeys-lfu`**: Evict least frequently used keys from all keys
- **`allkeys-random`**: Evict random keys from all keys
- **`volatile-lru`**: Evict least recently used keys with TTL set
- **`volatile-lfu`**: Evict least frequently used keys with TTL set
- **`volatile-random`**: Evict random keys with TTL set
- **`volatile-ttl`**: Evict keys with TTL set, shortest TTL first
- **`noeviction`**: Return errors when memory limit is reached

Since DNS cache entries do not have Redis TTLs, `volatile-*` policies will
only evict metadata keys (hit counters, locks). For typical DNS caching,
**`allkeys-lru` or `allkeys-lfu` are recommended** to ensure cache entries
can be evicted under memory pressure.

To customize Redis settings, edit `config/redis.conf` before starting the
containers.

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
   
   **What happens to entries that don't meet the threshold?**  
   Entries with fewer than `sweep_min_hits` are **skipped by the sweeper**
   and are not proactively refreshed. They remain in cache and will:
   - Continue to be served if still fresh (before soft expiry)
   - Be served as stale if `serve_stale` is enabled (within `stale_ttl`
     after soft expiry)
   - Become unservable after `stale_ttl` expires (hard cache miss)
   - Persist in Redis until evicted by Redis's memory policy, since cache
     entries do not have Redis TTLs
   - Still be eligible for request‑driven refresh if accessed by a client

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
    max_batch_size: 2000    # Max keys processed per sweep
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

#### DoH/DoT server (encrypted client connections)

To accept DNS-over-HTTPS and DNS-over-TLS from clients, enable the DoH/DoT server with TLS certificates:

```yaml
doh_dot_server:
  enabled: true
  cert_file: "/path/to/fullchain.pem"
  key_file: "/path/to/privkey.pem"
  dot_listen: "0.0.0.0:853"   # DoT (DNS over TLS)
  doh_listen: "0.0.0.0:8443"  # DoH (DNS over HTTPS); use 443 if not sharing with web UI
  doh_path: "/dns-query"
```

Clients can then use `tls://your-host:853` for DoT or `https://your-host:8443/dns-query` for DoH.

#### Block page

When `response.blocked` is set to your resolver's IP (e.g. the host running the Metrics UI), blocked domains resolve to that IP. The Metrics UI serves a simple HTML block page when a browser requests a blocked domain. Configure `response.blocked` to your server's IP and ensure DNS points clients to your resolver.

## Performance

The resolver uses a multi-tier caching architecture for maximum performance:

- **L0 Cache**: In-memory LRU cache (~10-50μs latency)
- **L1 Cache**: Redis distributed cache (~0.5-2ms latency)
- **Bloom Filter**: Fast negative lookups for blocklists
- **Refresh-Ahead**: Proactive cache refresh to avoid expiry
- **Optimized Connection Pools**: Redis pool with 50 connections

Expected performance with default configuration:
- **Hot queries**: <0.1ms latency, 500K-1M QPS per instance
- **Cached queries**: 0.5-2ms latency, 50K-100K QPS per instance
- **Cache hit rate**: 95-99% in production

See [`docs/performance.md`](docs/performance.md) for detailed performance documentation and tuning guide.

## Next steps

1. ~~Add DoT/DoH upstream options.~~ ✅ Implemented: use `tls://host:853` for DoT, `https://host/dns-query` for DoH.
2. ~~Add structured logging and query sampling.~~ ✅ Implemented: set `request_log.format: "json"` for JSON logs; `query_store.sample_rate` for sampling.
3. ~~Add DoH/DoT server and block page.~~ ✅ Implemented: see DoH/DoT server and Block page sections above.
4. Create Grafana dashboards (see [`docs/grafana-integration-plan.md`](docs/grafana-integration-plan.md)).

## Docker

The Docker image combines the DNS resolver and metrics API in a single
container. Redis and ClickHouse run as separate services. **No config files
are required**—the image includes sensible defaults (Hagezi blocklist,
Cloudflare upstreams).

To build the image from source (e.g. for custom deployments):

```
docker build -t beyond-ads-dns .
```

For most users, use one of the [Docker Compose examples](#running-the-application) above—they use the published image from GitHub Container Registry and require no build.

To customize blocklists or upstreams, use the Metrics UI—changes save to
`./config/config.yaml` on the host. Default config is in the image; no default.yaml required.
Set `HOSTNAME` in `.env` to customize the hostname shown in the UI.

## Metrics UI

The metrics UI is a React app backed by a Node.js API, bundled in the
same Docker image as the DNS resolver. It surfaces Redis cache
statistics, recent query rows, blocklist management, instance sync
configuration, and the active configuration (when the control server is enabled). The query table
supports filtering, pagination, sorting, and CSV export.

Run via one of the [Docker Compose examples](#running-the-application) (recommended; e.g. `examples/basic-docker-compose`). Visit http://localhost for the Metrics UI.

For non-Docker setups, run the web server and client separately:

```bash
cd web/server && npm install && npm run dev
cd web/client && npm install && npm run dev
```

### Instance Sync

The Metrics UI includes a **Sync** tab to configure multi-instance sync. You can enable sync, choose a role (primary or replica), and manage settings entirely from the UI—no manual config editing required.

**Primary instance** (source of truth):

- Create sync tokens for replicas to authenticate
- Revoke tokens when replicas are decommissioned
- Blocklists, upstreams, and local records are managed here and pushed to replicas

**Replica instance**:

- Set the primary URL (e.g. `http://primary-host:8081`)
- Enter the sync token from the primary
- Configure sync interval (e.g. `60s`, `5m`)
- DNS-affecting config (blocklists, upstreams, local records) is read-only; it is synced from the primary

To get started: open the Sync tab, choose **Primary** or **Replica**, and follow the prompts. Restart the application after saving to apply changes.

## Grafana Integration

The resolver exposes Prometheus metrics at `http://localhost:8081/metrics` when the control server is enabled. To run with Grafana and Prometheus, use the [Grafana integration example](examples/grafana-integration/):

```bash
cd examples/grafana-integration
docker compose up --build
```

Then open Grafana at http://localhost:3000 (login: `admin` / `admin`). Prometheus and ClickHouse datasources are pre-configured. See [`examples/grafana-integration/README.md`](examples/grafana-integration/README.md) for details and [`docs/grafana-integration-plan.md`](docs/grafana-integration-plan.md) for dashboard ideas.

Local development:

```
cd web/server && npm install && npm run dev
cd web/client && npm install && npm run dev
```

## Security

The metrics UI supports optional login, sessions, and HTTPS.

### User/Password login

When a password is configured, the UI requires login before accessing any data.

**Set password via environment variable:**

```yaml
# In your docker-compose.yml (e.g. examples/basic-docker-compose/docker-compose.yml)
environment:
  - UI_PASSWORD=your-secure-password
```

Or use `ADMIN_PASSWORD` (alias) or `UI_USERNAME` to customize the admin username (default: `admin`).

**Set password via command in container:**

```bash
docker exec beyond-ads-dns beyond-ads-dns set-admin-password your-secure-password
```

Or run interactively (prompts for password):

```bash
docker exec -it beyond-ads-dns beyond-ads-dns set-admin-password
```

The command writes a bcrypt hash to `/app/config-overrides/.admin-password`. Override the path with `ADMIN_PASSWORD_FILE`.

### Sessions

Sessions are stored in Redis with a configurable secret. Set `SESSION_SECRET` in production for stable session signing. Cookie is httpOnly, sameSite=lax, and secure when HTTPS is enabled.

### HTTPS

**Option 1: Let's Encrypt (automatic)**

For automatic HTTPS with free certificates from Let's Encrypt:

```yaml
environment:
  - LETSENCRYPT_ENABLED=true
  - LETSENCRYPT_DOMAIN=your-domain.com
  - LETSENCRYPT_EMAIL=admin@your-domain.com
```

**HTTP challenge** (default): Port 80 must be publicly reachable. **DNS challenge** (alternative): Set `LETSENCRYPT_CHALLENGE_TYPE=dns` when port 80 is not available—add TXT records manually when prompted. Certificates are stored in a volume and auto-renew on startup when expiring. See [`examples/letsencrypt-docker-compose/`](examples/letsencrypt-docker-compose/) for a full example.

**Option 2: Manual certificates**

```yaml
environment:
  - HTTPS_ENABLED=true
  - SSL_CERT_FILE=/path/to/cert.pem
  - SSL_KEY_FILE=/path/to/key.pem
  - HTTPS_PORT=443
```

Mount the certificate files into the container. Alternatively, use a reverse proxy (nginx, Traefik) for TLS termination.

## Performance testing

Use the built-in harness to run large query bursts and optionally flush
Redis between runs:

```
go run ./cmd/perf-tester -resolver 127.0.0.1:53 -flush-redis
```

See `tools/perf/README.md` for more options (warmup, TCP, custom name
lists, etc).

**Note on latency measurements**: The performance tester measures
**client-side round-trip time** (from sending query to receiving
response, including network latency). This differs from the
server-side `duration_ms` stored in ClickHouse, which measures
end-to-end processing time within the resolver (see "Query store and
metrics" section above for details).
