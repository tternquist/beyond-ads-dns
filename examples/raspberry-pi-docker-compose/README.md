# Raspberry Pi Docker Compose (microSD-Friendly)

Deploy beyond-ads-dns on Raspberry Pi with minimal writes to microSD storage. Designed for Pi 4/5 (64-bit).

## Quick Start

```bash
cd examples/raspberry-pi-docker-compose
docker compose up -d
```

- **DNS**: port 53 (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Disk Write Optimizations

| Component | Optimization | Trade-off |
|-----------|-------------|-----------|
| **ClickHouse** | tmpfs for `/var/lib/clickhouse` (in-memory only) | Query analytics work; data lost on restart |
| **Redis** | No persistence (`--save "" --appendonly no`), tmpfs for `/data` | Cache lost on restart; repopulates quickly |
| **Logs** | tmpfs (RAM) for `/app/logs` | Logs lost on restart |
| **Config** | Host mount (minimal writes; only when saving from UI) | Persists across restarts |

## Memory Usage

- **Redis**: 128MB max, LRU eviction
- **Redis tmpfs**: 64MB
- **Logs tmpfs**: 32MB
- **ClickHouse tmpfs**: 256MB

Total extra RAM use is ~350–400MB. Suitable for Pi 4 (2GB+) and Pi 5.

## 32-bit Raspberry Pi (Pi 3)

The image is built for `linux/arm64`. For 32-bit Pi 3, remove the `platform: linux/arm64` lines from `docker-compose.yml` if you want to run under emulation (slower), or use a 64-bit OS on the Pi 3.

This example runs ClickHouse entirely in memory (tmpfs). Analytics are available in the UI but are lost on container restart. No disk writes occur.

To persist analytics instead, use an external ClickHouse instance on a machine with SSD storage, or the basic example with a USB SSD for Docker data instead of microSD.

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:latest` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).
