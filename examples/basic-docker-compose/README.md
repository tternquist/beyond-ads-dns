# Basic Docker Compose Deployment

Deploy beyond-ads-dns using the published image from GitHub Container Registry. Includes `config/default.yaml` with sensible defaults (Hagezi blocklist, Cloudflare upstreams).

## Quick Start

```bash
docker compose up -d
```

- **DNS**: `localhost:53` (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Customization

To override blocklists, upstreams, or other settings:

1. Copy the example config and edit:

   ```bash
   cp config/config.example.yaml config/config.yaml
   # Edit config/config.yaml with your overrides
   ```

2. Uncomment the config volume in `docker-compose.yml` under the `app` service:

   ```yaml
   volumes:
     - beyond-ads-logs:/app/logs
     - ./config:/etc/beyond-ads-dns:ro
   ```

   `CONFIG_PATH` is already set; the app will use your overrides when the volume is mounted.

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:main` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).

## Data Persistence

This example uses Docker named volumes for logs, Redis, and ClickHouse data. Data persists across restarts.
