# Unbound DNS Docker Compose

Deploy beyond-ads-dns with **Unbound** as the recursive upstream resolver. This setup uses full recursive resolution instead of forwarding to Cloudflare or Google.

## Architecture

```
Client → beyond-ads-dns (blocklist, cache) → Unbound (recursive) → root/TLD servers
```

- **beyond-ads-dns**: Handles blocklist filtering, L0/L1 cache, and query analytics. Forwards cache misses to Unbound.
- **Unbound**: Performs recursive DNS resolution with DNSSEC validation. No dependency on external DNS providers.

## Benefits

| Benefit | Description |
|---------|-------------|
| **Privacy** | No queries sent to Cloudflare, Google, or other third-party resolvers |
| **DNSSEC** | Unbound validates DNSSEC for recursive responses |
| **Independence** | No reliance on upstream provider availability |
| **Control** | Full control over recursive resolution and caching |

## Quick Start

```bash
cd examples/unbound-docker-compose
docker compose up -d
```

- **DNS**: port 53 (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Configuration

- **Unbound**: `./unbound.conf` — recursive resolver config (port 5353, cache sizes, DNSSEC)
- **beyond-ads-dns**: `./config/config.yaml` — upstreams point to `unbound:5353`

Unbound is not exposed to the host; only the app container can reach it. Edit blocklists or Unbound settings as needed.

The example config enables:
- **SERVFAIL backoff** (60s): When Unbound returns SERVFAIL (e.g. DNSSEC validation failure), the app backs off rather than aggressively retrying, since SERVFAIL typically indicates upstream security issues or misconfiguration.
- **Respect source TTL**: Uses the TTL returned by Unbound without extending it, so stale refresh triggers just before expiry and avoids serving "ghost" data that has changed upstream.

## Unbound Config

The included `unbound.conf` provides:

- Recursive resolution (no forward zones)
- DNSSEC validation
- 128MB msg-cache, 256MB rrset-cache
- Prefetch for popular domains
- Access limited to private networks (Docker)
- **edns-client-subnet (ECS)**: Enabled for GeoDNS/CDN optimization—passes client subnet to authoritative servers

## Unbound Image (with edns-client-subnet)

The `mvance/unbound` image does not include the edns-client-subnet module. This example uses a **custom Unbound build** (`Dockerfile.unbound`) compiled with `--enable-ecs` to support ECS for better GeoDNS/CDN routing.

- **beyond-ads-dns**: `ghcr.io/tternquist/beyond-ads-dns:main`
- **Unbound**: Built from `Dockerfile.unbound` (Unbound 1.22.0 from source with ECS support)

## Data Persistence

Uses Docker named volumes for logs, Redis, and ClickHouse. Unbound cache is in-memory (lost on restart).

## Building Unbound

The first `docker compose up` will build the custom Unbound image (a few minutes). To disable edns-client-subnet and use the stock `mvance/unbound:1.22.0` image instead, change the unbound service in `docker-compose.yml` to use `image: mvance/unbound:1.22.0` and remove the `build:` block, then comment out the `module-config: "validator iterator edns-client-subnet"` line in `unbound.conf`.
