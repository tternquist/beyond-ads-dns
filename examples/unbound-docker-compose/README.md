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

## Unbound Config

The included `unbound.conf` provides:

- Recursive resolution (no forward zones)
- DNSSEC validation
- 128MB msg-cache, 256MB rrset-cache
- Prefetch for popular domains
- Access limited to private networks (Docker)

## Image

- **beyond-ads-dns**: `ghcr.io/tternquist/beyond-ads-dns:main`
- **Unbound**: `mvance/unbound:1.22.0` from [Docker Hub](https://hub.docker.com/r/mvance/unbound)

## Data Persistence

Uses Docker named volumes for logs, Redis, and ClickHouse. Unbound cache is in-memory (lost on restart).
