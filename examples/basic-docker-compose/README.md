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

The config directory is mounted **writable** so blocklist changes from the Metrics UI persist across restarts. When you edit blocklists in the UI and click Apply, the changes are saved to `config/config.yaml` (created on first edit).

To pre-set overrides before starting, copy the example:

```bash
cp config/config.example.yaml config/config.yaml
# Edit config/config.yaml
```

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:main` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).

## Data Persistence

This example uses Docker named volumes for logs, Redis, and ClickHouse data. Data persists across restarts.
