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

Set `cache.redis.password` in your config so the resolver (and any other component using the same Redis) can authenticate.

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

Leave `password` empty or omit it when Redis has no `requirepass`.

### Keeping the password out of config files

To avoid storing the password in plain text in the repo:

1. **Separate override file:** Put Redis (and other secrets) in a local file that is not committed (e.g. `config/config-overrides.yaml` or a file under `config-overrides/`). Merge or load it after the main config according to your deployment.
2. **Environment substitution:** Use a template and substitute env vars at deploy time (e.g. `envsubst < config/config.template.yaml > config/config.yaml` with `password: "${REDIS_PASSWORD}"` in the template).
3. **Secrets manager:** Generate the final config from a secrets manager (e.g. HashiCorp Vault, cloud provider secrets) so the password is never written into a committed file.

The application does not read Redis password from an environment variable by default; use one of the approaches above to inject it into the YAML.

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
