# Warm TTL Fraction Migration

## Overview

Starting with this release, warm (low-hit) cache entries can use a **fraction-based** refresh threshold (`warm_ttl_fraction`) instead of a fixed duration (`warm_ttl`). This scales with cache `min_ttl` and stored TTL, keeping entries fresher regardless of TTL length.

**Default:** `warm_ttl_fraction: 0.25` — refresh when remaining TTL ≤ 25% of stored TTL.

- With cache `min_ttl: 1h`: warm entries refresh at 15 minutes remaining (instead of fixed 5m).
- With cache `min_ttl: 24h`: warm entries refresh at 6 hours remaining.
- Set `warm_ttl_fraction: 0` to use the fixed `warm_ttl` (previous behavior).

## Automatic Migration

**On startup**, the DNS server runs config migrations before loading. When `config_version` in your override file is older than the current version, migrations run and update the file. Migration 1 adds `warm_ttl_fraction: 0.25` to `cache.refresh` when `warm_threshold` > 0 and the setting is not present.

No manual action is required for most upgrades.

## Who Needs to Migrate?

**New installs:** No action. Default config includes `warm_ttl_fraction: 0.25`.

**Upgraded instances:** Automatic migration runs on first startup. Your override file is updated in place. The `config_version` key tracks which migrations have been applied.

**Optional:** To run migration manually (e.g., before restart), use the migration script below.

## Migration Script

The script checks your config and adds `warm_ttl_fraction: 0.25` to `cache.refresh` when:

- `cache.refresh` exists
- `warm_threshold` > 0
- `warm_ttl_fraction` is not already set

```bash
# From the project root
./scripts/migrate-warm-ttl-fraction.sh [CONFIG_PATH]
```

**Examples:**

```bash
# Default: /app/config-overrides/config.yaml (or CONFIG_PATH env)
./scripts/migrate-warm-ttl-fraction.sh

# Custom path (Docker Compose)
./scripts/migrate-warm-ttl-fraction.sh ./config/config.yaml

# Inside container
docker exec -it beyond-ads-dns ./scripts/migrate-warm-ttl-fraction.sh /app/config-overrides/config.yaml
```

**Dry run (check only, no write):**

```bash
CONFIG_DRY_RUN=1 ./scripts/migrate-warm-ttl-fraction.sh
```

## Verification

After migration (or upgrade), verify the effective config:

```bash
curl -s http://localhost:8081/cache/refresh/stats | jq '.refresh_config'
```

Expected output includes:

```json
{
  "warm_ttl_fraction": 0.25,
  "warm_ttl": "5m",
  "warm_threshold": 2
}
```

When `warm_ttl_fraction` > 0, warm entries use the fraction; `warm_ttl` is the fallback when the fraction yields 0 or when `warm_ttl_fraction` is 0.

## Sensible Defaults for Freshness

| Setting | Default | Purpose |
|---------|---------|---------|
| **hot_ttl_fraction** | 0.3 | Hot entries: refresh when remaining ≤ 30% of stored TTL. Keeps high-traffic entries fresh. |
| **warm_ttl_fraction** | 0.25 | Warm entries: refresh when remaining ≤ 25% of stored TTL. Self-correction for single-client retries; scales with cache min_ttl. |

Both fractions ensure entries are refreshed well before expiry while adapting to different TTL lengths.
See [Performance: Fraction vs Fixed TTL](performance.md#fraction-vs-fixed-ttl) for when to use fraction-based vs fixed-duration thresholds.
