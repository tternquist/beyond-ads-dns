# Redis Sentinel - Learning Example

Docker Compose setup to learn how **Redis Sentinel** provides high availability with automatic failover. Includes beyond-ads-dns app and ClickHouse for a fully functional deployment. For learning only—not production.

## Architecture

- **1 master** (`redis-master`): Primary node, accepts reads and writes
- **2 replicas** (`redis-replica-1`, `redis-replica-2`): Replicate from master; one can be promoted if the master fails
- **3 sentinels** (`redis-sentinel-1`–`3`): Monitor the master and orchestrate failover when it goes down
- **beyond-ads-dns** (`app`): DNS resolver with cache using Sentinel for HA
- **ClickHouse**: Query analytics storage

Clients connect to Sentinel (port 26379) to discover the current master; Sentinel redirects to the correct node.

## Quick Start

```bash
cd examples/redis-sentinel-docker-compose
docker compose up -d
```

- **Metrics UI**: http://localhost
- **DNS**: port 53 (UDP/TCP)
- **Control API**: http://localhost:8081

## Testing

### 1. Connect via Sentinel and get the current master

```bash
docker exec -it redis-sentinel-cli redis-cli -h redis-sentinel-1 -p 26379 SENTINEL get-master-addr-by-name mymaster
```

You should see the master address (e.g. `redis-master` and `6379`).

### 2. Write and read from the master

```bash
# Connect to master (or use Sentinel in your app)
docker exec -it redis-sentinel-cli redis-cli -h redis-master -p 6379 SET hello "world"
docker exec -it redis-sentinel-cli redis-cli -h redis-master -p 6379 GET hello
```

### 3. Read from a replica

```bash
docker exec -it redis-sentinel-cli redis-cli -h redis-replica-1 -p 6379 GET hello
```

### 4. Simulate failover (optional)

Stop the master; Sentinel will promote a replica within ~5–10 seconds:

```bash
docker compose stop redis-master
# Wait ~10 seconds, then check who is master:
docker exec -it redis-sentinel-cli redis-cli -h redis-sentinel-1 -p 26379 SENTINEL get-master-addr-by-name mymaster
# Restore the old master as a replica:
docker compose start redis-master
```

## Ports

| Service   | Port  | Purpose                    |
|-----------|-------|----------------------------|
| Sentinel 1| 26379 | Sentinel (connect here)    |
| Sentinel 2| 26380 | Sentinel                   |
| Sentinel 3| 26381 | Sentinel                   |

Redis (6379) is internal; use `docker exec` into `redis-sentinel-cli` to reach it.

## Redis Sentinel Configuration

The app is preconfigured in `config/config.yaml` for Sentinel mode:

- **Redis mode**: `sentinel`
- **Master name**: `mymaster`
- **Sentinel addresses**: `redis-sentinel-1:26379, redis-sentinel-2:26379, redis-sentinel-3:26379`

The DNS cache uses Sentinel to discover the current master and automatically reconnects on failover. The web UI session store connects to `redis-master` directly; during failover, sessions may be briefly unavailable until the old master rejoins as a replica.
