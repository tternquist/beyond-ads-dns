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

Config is on the host at `./config` for persistence and portability. You need `config/default.yaml` (included); `config/config.yaml` is created when you save from the UI. The app runs as root so it can write to the host mount.

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:main` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).

## Data Persistence

This example uses Docker named volumes for logs, Redis, and ClickHouse data. Data persists across restarts.
