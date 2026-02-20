# Appliance Deployment with Watchtower

Deploy beyond-ads-dns on devices distributed outside your control (e.g. customer sites, embedded deployments) with automatic updates via [Watchtower](https://containrrr.dev/watchtower/).

## How it works

- The app uses the **`appliance`** Docker tag (not `latest` or `stable`).
- You promote validated releases to `appliance` using the [Promote to Appliance Tag](../../.github/workflows/appliance-tag.yml) workflow.
- Watchtower monitors the tag; when it changes (you promoted a new version), it pulls the new image and restarts the container.

Promote only very stable releases—typically on a periodic schedule (e.g. monthly or quarterly).

## Quick start

```bash
docker compose up -d
```

- **DNS**: `localhost:53` (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Image tags

This example uses `ghcr.io/tternquist/beyond-ads-dns:appliance`. Only the app container is watched by Watchtower (via `com.centurylinklabs.watchtower.enable=true`). Redis and ClickHouse are not auto-updated.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCHTOWER_POLL_INTERVAL` | `86400` | Poll interval in seconds (86400 = 24 hours) |

Copy `.env.example` and adjust if needed:

```bash
cp .env.example .env
```

## Data persistence

Uses Docker named volumes for logs, Redis, and ClickHouse. Data persists across restarts and updates.
