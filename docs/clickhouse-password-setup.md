# ClickHouse (query store) password setup

This document describes how to configure beyond-ads-dns to connect to ClickHouse with a password, and how to keep the password out of the config file (aligned with [Redis password setup](redis-password-setup.md)).

---

## 1. Configuring the application to use a password

Set the password via **environment variable** (recommended) or **YAML** so the query store can authenticate.

### Environment variable (e.g. .env / env file)

You can pass the ClickHouse password via an environment variable. This works well with Docker Compose `env_file`, a `.env` file, or any environment:

- **`QUERY_STORE_PASSWORD`** — sets `query_store.password`. Example: `QUERY_STORE_PASSWORD=your-secure-password`

**Docker Compose example:**

```yaml
services:
  beyond-ads-dns:
    image: ghcr.io/your-org/beyond-ads-dns:latest
    env_file: .env
    # .env contains: QUERY_STORE_PASSWORD=your-secure-password
```

Or inline:

```yaml
    environment:
      QUERY_STORE_PASSWORD: ${QUERY_STORE_PASSWORD}
```

### YAML config

In `config/config.yaml` (or your merged config):

```yaml
query_store:
  enabled: true
  address: "http://clickhouse:8123"
  database: "beyond_ads"
  table: "dns_queries"
  username: "beyondads"
  password: "your-secure-password"
```

Leave `password` empty or omit it when ClickHouse does not require authentication. Env override: if `QUERY_STORE_PASSWORD` is set, it overrides the value from the config file.

---

## 2. Viewing and export: password is never exposed

- **UI (Settings / config):** Query store password is never shown. When a password is set (from config or `QUERY_STORE_PASSWORD`), the UI shows a placeholder (`***`) only.
- **Config export:** Exported YAML does not include `query_store.password` (or other secret fields). Use env for the password on the target system.
- **Config save from UI:** The application does not write `query_store.password` (or other secrets) to the override config file. So the config file stays free of secrets; set the password via `QUERY_STORE_PASSWORD` and leave it out of the file.

---

## 3. Keeping the password out of config files (recommended)

Best practice is to **not store the ClickHouse password in the config file** and use the environment variable only:

1. **Env file:** Set `QUERY_STORE_PASSWORD` in a `.env` or env file that is not committed. Use Docker Compose `env_file` or export before running the binary.
2. **Secrets manager:** Inject `QUERY_STORE_PASSWORD` at deploy time from a secrets manager.
3. **Separate override file:** If you must use a file, put only non-secret overrides in the committed config and keep the password in env or a local override that is not committed.

If the password is present in the config file, it is still used at runtime, but the UI and export will never display or re-persist it.

---

## 4. References

- Example config: `config/config.example.yaml` (`query_store`)
- Redis (same approach): [redis-password-setup.md](redis-password-setup.md)
