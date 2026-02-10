#!/bin/sh
set -e

# When running as root, ensure mounted config dir is writable by app user
if [ "$(id -u)" = "0" ]; then
  if [ -d /etc/beyond-ads-dns ]; then
    chown -R app:app /etc/beyond-ads-dns 2>/dev/null || true
  fi
  exec su-exec app /entrypoint-app.sh
fi

# Already non-root (e.g. OpenShift)
exec /entrypoint-app.sh
