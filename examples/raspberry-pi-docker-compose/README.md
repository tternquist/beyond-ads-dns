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

## Raspberry Pi Detection & Troubleshooting

The app detects Pi 4/5 for resource-aware tuning. If your Pi 4 is not detected:

### Debug endpoint

Call the debug API (requires auth if enabled):

```bash
curl -s http://localhost/api/system/debug/raspberry-pi | jq
```

Response includes:
- **detectedModel**: `"pi4"`, `"pi5"`, `"pi_other"`, or `null` (not detected)
- **deviceTree.model**: raw model string from `/proc/device-tree/model` (e.g. `Raspberry Pi 4 Model B Rev 1.4`)
- **deviceTree.error**: why device-tree detection failed (e.g. `ENOENT` if file missing)
- **cpuinfo.hardware**: Hardware line from `/proc/cpuinfo` (e.g. `BCM2711` for Pi 4)
- **cpuinfo.error**: why cpuinfo fallback failed

### Manual checks (on the Pi host or inside container)

```bash
# Device tree model (may have trailing nulls)
cat /proc/device-tree/model | tr -d '\0'

# Alternative path
cat /sys/firmware/devicetree/base/model | tr -d '\0'

# CPU hardware (BCM2711 = Pi 4, BCM2712 = Pi 5)
grep Hardware /proc/cpuinfo
```

### Common causes of failed detection

1. **Docker/containers**: Ensure `/proc` is available. Some minimal containers don't mount host `/proc`; the device tree and cpuinfo come from the host.
2. **Architecture mismatch**: Running an `arm64` container on Pi 4 works; x86 emulation (e.g. `linux/amd64` image) can hide the real hardware.
3. **Device tree missing**: Some virtualized or minimal environments don't provide `/proc/device-tree/model`. The fallback uses `/proc/cpuinfo` Hardware (BCM2711 for Pi 4).
4. **Permissions**: The process must be able to read `/proc/device-tree/model` or `/proc/cpuinfo`.

## Image

Uses `ghcr.io/tternquist/beyond-ads-dns:latest` from [GitHub Container Registry](https://github.com/tternquist/beyond-ads-dns/pkgs/container/beyond-ads-dns).
