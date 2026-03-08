#!/usr/bin/env bash
# Migrate config to add warm_ttl_fraction for upgraded instances.
# Adds warm_ttl_fraction: 0.25 to cache.refresh when warm_threshold > 0 and not already set.
#
# Usage: ./scripts/migrate-warm-ttl-fraction.sh [CONFIG_PATH]
#   CONFIG_PATH defaults to ${CONFIG_PATH:-/app/config-overrides/config.yaml}
#
# Dry run (check only): CONFIG_DRY_RUN=1 ./scripts/migrate-warm-ttl-fraction.sh

set -e

CONFIG_PATH="${1:-${CONFIG_PATH:-/app/config-overrides/config.yaml}}"
DRY_RUN="${CONFIG_DRY_RUN:-0}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

# Use Python for YAML (available in most environments; avoid extra deps)
# Pass path and dry-run via env for heredoc
CONFIG_PATH="$CONFIG_PATH" CONFIG_DRY_RUN="$DRY_RUN" python3 - <<'PY'
import sys
import os

config_path = os.environ.get("CONFIG_PATH", "/app/config-overrides/config.yaml")
dry_run = os.environ.get("CONFIG_DRY_RUN", "0") == "1"

try:
    import yaml
except ImportError:
    print("Error: PyYAML required. Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

with open(config_path, "r") as f:
    data = yaml.safe_load(f) or {}

refresh = data.get("cache", {}).get("refresh")
if not refresh:
    print("No cache.refresh section; nothing to migrate.")
    sys.exit(0)

warm_threshold = refresh.get("warm_threshold", 0)
if warm_threshold <= 0:
    print("warm_threshold is 0 or unset; warm_ttl_fraction not applicable.")
    sys.exit(0)

if "warm_ttl_fraction" in refresh:
    print(f"warm_ttl_fraction already set to {refresh['warm_ttl_fraction']}; no change.")
    sys.exit(0)

refresh["warm_ttl_fraction"] = 0.25
print("Would add warm_ttl_fraction: 0.25 to cache.refresh")

if dry_run:
    print("(Dry run; no file written)")
    sys.exit(0)

with open(config_path, "w") as f:
    yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

print(f"Updated {config_path}")
PY
