#!/bin/sh
set -e

# When config is mounted from host, ensure it's writable by PUID:PGID
# so the app can save blocklist changes from the UI.
if [ -d /app/config-overrides ]; then
  chown -R "${PUID:-1000}:${PGID:-1000}" /app/config-overrides 2>/dev/null || true
fi

# Run as PUID:PGID (matches host user for writable config)
exec su-exec "${PUID:-1000}:${PGID:-1000}" /entrypoint-app.sh
