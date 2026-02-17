# Redis Cluster - Learning Example

Docker Compose setup to learn how **Redis Cluster** shards data across multiple nodes with automatic failover. Includes beyond-ads-dns app and ClickHouse for a fully functional deployment. For learning only—not production.

## Architecture

- **6 nodes**: 3 masters + 3 replicas (1 replica per master)
- **16384 hash slots** split across the 3 masters
- Keys are assigned to slots by hash; each master owns a range of slots
- If a master fails, its replica is promoted automatically
- **beyond-ads-dns** (`app`): DNS resolver with cache using Cluster mode
- **ClickHouse**: Query analytics storage

## Quick Start

```bash
cd examples/redis-cluster-docker-compose
docker compose up -d
```

- **Metrics UI**: http://localhost
- **DNS**: port 53 (UDP/TCP)
- **Control API**: http://localhost:8081

The `redis-cluster-init` service forms the cluster on first run. If you bring the stack down and up again, the cluster state is in volumes—you may need to remove volumes to re-init: `docker compose down -v` then `docker compose up -d`.

**Note:** Run `docker compose up` from this directory so `./config` mounts correctly. If you see "lookup redis ... no such host", the config override may not be loading—ensure `config/config.yaml` exists.

## Testing

### 1. Check cluster status

```bash
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 CLUSTER INFO
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 CLUSTER NODES
```

### 2. Write and read (cluster redirects automatically)

```bash
# -c enables cluster mode (follows MOVED/ASK redirects)
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 SET foo bar
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 GET foo
```

### 3. See which node owns a key

```bash
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 CLUSTER KEYSLOT foo
```

### 4. Multi-key operations (same hash tag)

Keys in the same hash tag `{...}` go to the same slot:

```bash
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 MSET "{user:1}:name" alice "{user:1}:email" alice@example.com
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-1 -p 6379 MGET "{user:1}:name" "{user:1}:email"
```

### 5. Simulate failover (optional)

Stop a master; its replica will be promoted:

```bash
docker compose stop redis-node-1
# Wait ~10 seconds, then check:
docker exec -it redis-cluster-cli redis-cli -c -h redis-node-2 -p 6379 CLUSTER NODES
# Restore:
docker compose start redis-node-1
```

## Ports

| Node  | Redis | Cluster bus |
|-------|-------|-------------|
| node-1| 6379  | 16379       |
| node-2| 6380  | 16380       |
| node-3| 6381  | 16381       |
| node-4| 6382  | 16382       |
| node-5| 6383  | 16383       |
| node-6| 6384  | 16384       |

From the host, connect to `localhost:6379` (or any node port) with `-c` for cluster mode.

## Redis Cluster Configuration

The app is configured via environment variables (config file optional):

- **REDIS_MODE**: `cluster`
- **REDIS_CLUSTER_ADDRS**: `redis-node-1:6379,redis-node-2:6379,redis-node-3:6379` (any subset of nodes is fine; the client discovers the rest)

Alternatively, use **REDIS_ADDRESS** with comma-separated nodes when `REDIS_MODE=cluster`.

You can override these in `docker-compose.yml` or pass them when running the image. Both the DNS cache and the web UI (sessions, Redis summary) use the Redis Cluster client and automatically handle slot routing and failover. The Settings UI displays the effective Redis mode and addresses, including when configured via env vars only.
