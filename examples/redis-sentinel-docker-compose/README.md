# Redis Sentinel - Learning Example

Docker Compose setup to learn how **Redis Sentinel** provides high availability with automatic failover. For learning only—not production.

## Architecture

- **1 master** (`redis-master`): Primary node, accepts reads and writes
- **2 replicas** (`redis-replica-1`, `redis-replica-2`): Replicate from master; one can be promoted if the master fails
- **3 sentinels** (`redis-sentinel-1`–`3`): Monitor the master and orchestrate failover when it goes down

Clients connect to Sentinel (port 26379) to discover the current master; Sentinel redirects to the correct node.

## Quick Start

```bash
cd examples/redis-sentinel-docker-compose
docker compose up -d
```

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

## Using with beyond-ads-dns

To use this Sentinel setup as the cache for beyond-ads-dns, set in the UI or config:

- **Redis mode**: `sentinel`
- **Master name**: `mymaster`
- **Sentinel addresses**: `redis-sentinel-1:26379, redis-sentinel-2:26379, redis-sentinel-3:26379`

Add the app service to this compose and ensure it uses the `redis-net` network.
