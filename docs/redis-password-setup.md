# Redis password setup

This document describes how to enable authentication on Redis and how to configure beyond-ads-dns to connect using a password.

---

## 1. Setting a password on Redis

### Option A: Configuration file (persistent)

Edit your Redis config file (e.g. `/etc/redis/redis.conf` on Linux, or your container’s config):

```conf
requirepass your-secure-password
```

Restart Redis so the change takes effect.

### Option B: Runtime (temporary until restart)

From the Redis CLI or via `CONFIG SET`:

```bash
redis-cli CONFIG SET requirepass "your-secure-password"
```

This is lost on Redis restart unless you also run `CONFIG REWRITE` (when `redis.conf` is writable) or persist the setting in your deployment.

### Option C: Docker / Docker Compose

If you run Redis in a container, you can pass the password via command or env:

**Command:**

```yaml
services:
  redis:
    image: redis:7-alpine
    command: redis-server --requirepass your-secure-password
```

**Or via env (Redis 6+):**

```yaml
services:
  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    # Set REDIS_PASSWORD in .env or your shell
```

---

## 2. Configuring beyond-ads-dns to use the password

Set the password via **environment variable** (recommended for env files / Docker) or **YAML** so the resolver can authenticate.

### Environment variable (e.g. .env / env file)

You can pass the Redis password via environment variables. This works well with Docker Compose `env_file`, a `.env` file, or any environment:

- **`REDIS_PASSWORD`** — sets `cache.redis.password`. Example: `REDIS_PASSWORD=your-secure-password`
- **`REDIS_URL`** — if the URL contains a password, it is used when `REDIS_PASSWORD` is not set. Example: `REDIS_URL=redis://:your-secure-password@redis:6379`

`REDIS_PASSWORD` overrides any password in `REDIS_URL`. Other Redis env overrides (e.g. `REDIS_ADDRESS`, `REDIS_MODE`) continue to work as before.

**Docker Compose example:**

```yaml
services:
  beyond-ads-dns:
    image: ghcr.io/your-org/beyond-ads-dns:latest
    env_file: .env
    # .env contains: REDIS_PASSWORD=your-secure-password
```

Or inline:

```yaml
    environment:
      REDIS_ADDRESS: redis:6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
```

### YAML config

In `config/config.yaml` (or your merged config):

```yaml
cache:
  redis:
    address: "redis:6379"   # or your Redis host:port
    db: 0
    password: "your-secure-password"
```

- **Standalone:** `address` and `password` are used.
- **Sentinel:** `password` is used for both Sentinel and the master; set `master_name` and `sentinel_addrs` as usual.
- **Cluster:** `password` is used for cluster nodes; set `cluster_addrs` or `address` (comma-separated) as usual.

Leave `password` empty or omit it when Redis has no `requirepass`. Env overrides (e.g. `REDIS_PASSWORD`) override the value from the config file.

### Viewing and export: password is never exposed

- **UI (Settings / config):** Redis password is never shown. When a password is set (from config or `REDIS_PASSWORD`), the UI shows a placeholder (`***`) only.
- **Config export:** Exported YAML does not include `cache.redis.password` (or other secret fields). Use env for the password on the target system.
- **Config save from UI:** The application does not write `cache.redis.password` (or other secrets) to the override config file. So the config file stays free of secrets; set the password via `REDIS_PASSWORD` or `REDIS_URL` and leave it out of the file.

### Keeping the password out of config files (recommended)

Best practice is to **not store the Redis password in the config file** and use environment variables only:

1. **Env file:** Set `REDIS_PASSWORD` (or use `REDIS_URL` with embedded password) in a `.env` or env file that is not committed. Use Docker Compose `env_file` or export before running the binary.
2. **Secrets manager:** Inject `REDIS_PASSWORD` at deploy time from a secrets manager.
3. **Separate override file:** If you must use a file, put only non-secret overrides in the committed config and keep Redis (and other secrets) in a local override that is not committed.

If the password is present in the config file, it is still used at runtime, but the UI and export will never display or re-persist it.

---

## 3. Verifying

1. **Redis:** With auth enabled, unauthenticated commands should fail:
   ```bash
   redis-cli PING
   # (error) NOAUTH Authentication required
   redis-cli -a your-secure-password PING
   # PONG
   ```

2. **beyond-ads-dns:** Start the resolver with your config. If the password is wrong, the resolver will fail to connect to Redis at startup (e.g. `NOAUTH` or connection error in logs). Successful startup and normal DNS resolution indicate Redis auth is working.

---

## 4. References

- Redis key layout and usage: [redis-key-schema.md](redis-key-schema.md)
- Cache and Redis configuration: [performance.md](performance.md) (L1 cache section)
- Example config: `config/config.example.yaml` (`cache.redis`)
- ClickHouse (query store) uses the same approach: [clickhouse-password-setup.md](clickhouse-password-setup.md)
