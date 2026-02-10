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

Config is on the host at `./config` for persistence and portability. The default is in the image; overrides go in `config/config.yaml` (created when you save from the UI).

**Permissions:** Set `PUID` and `PGID` to match your host user so the app can write. Run `id` to get your UID/GID, then:

```bash
export PUID=$(id -u)
export PGID=$(id -g)
docker compose up -d
```

Or add to `.env`: `PUID=1000` and `PGID=1000` (common default).

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:main` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).

## Data Persistence

This example uses Docker named volumes for logs, Redis, and ClickHouse data. Data persists across restarts.
