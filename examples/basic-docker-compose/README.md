# Basic Docker Compose Deployment

Deploy beyond-ads-dns using the published image from GitHub Container Registry. Includes `config/default.yaml` with sensible defaults (Hagezi blocklist, Cloudflare upstreams). The app creates the ClickHouse database and table on startup—no init containers or SQL files needed.

## Quick Start

```bash
docker compose up -d
```

- **DNS**: `localhost:53` (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Config and UI Updates

Default config is in the image. Overrides go in `./config/config.yaml` on the host (created when you save from the UI). No need for default.yaml—the image provides it.

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:latest` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).

**Image tags:**
- `stable` — promoted release (recommended for production); use the [Promote to Stable Tag](../../.github/workflows/stable-tag.yml) workflow to selectively promote a validated release
- `appliance` — for Watchtower-monitored deployments (devices outside your control); use [Promote to Appliance Tag](../../.github/workflows/appliance-tag.yml) for periodic stable updates
- `latest` — most recent release (auto-updates with every new release)
- `v1.2.3` — pinned release version
- `edge` — bleeding-edge build from main (development/testing)

## Data Persistence

This example uses Docker named volumes for logs, Redis, and ClickHouse data. Data persists across restarts.
