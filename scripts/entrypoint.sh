#!/bin/sh
set -e

# Ensure host-mounted config-overrides is writable (Docker Desktop, rootless, etc.)
if [ -d /app/config-overrides ]; then
  chmod -R 777 /app/config-overrides 2>/dev/null || true
fi

# DoH/DoT: derive cert paths from LETSENCRYPT_DOMAIN when using Let's Encrypt
if [ -n "$DOH_DOT_ENABLED" ] && [ "$DOH_DOT_ENABLED" = "true" ] && [ -z "$DOH_DOT_CERT_FILE" ] && [ -n "$LETSENCRYPT_DOMAIN" ]; then
  primary_domain="${LETSENCRYPT_DOMAIN%%,*}"
  primary_domain="${primary_domain%% *}"
  export DOH_DOT_CERT_FILE="/app/letsencrypt/${primary_domain}-fullchain.pem"
  export DOH_DOT_KEY_FILE="/app/letsencrypt/${primary_domain}-key.pem"
fi

# Run DNS resolver and metrics API. Start web server only after DNS backend is ready
# to avoid query store timing issues (e.g. on Raspberry Pi, schema may not exist yet).
# Forward SIGTERM/SIGINT to both processes for graceful shutdown.

dns_pid=""
api_pid=""

cleanup() {
  if [ -n "$dns_pid" ]; then kill -TERM "$dns_pid" 2>/dev/null || true; fi
  if [ -n "$api_pid" ]; then kill -TERM "$api_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  exit 0
}

trap cleanup TERM INT

/app/beyond-ads-dns &
dns_pid=$!

# Wait for DNS backend control API before starting web server.
# Prevents race where Overview shows "Query store disabled" because the web server
# queries ClickHouse before the Go backend has created the table (slower on Pi).
if [ -n "$DNS_CONTROL_URL" ]; then
  health_url="${DNS_CONTROL_URL%/}/health"
  max_wait=30
  waited=0
  while [ $waited -lt $max_wait ]; do
    if wget -q -O /dev/null --spider "$health_url" 2>/dev/null; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ $waited -ge $max_wait ]; then
    echo "Warning: DNS control API not ready after ${max_wait}s, starting web server anyway"
  fi
fi

node /app/src/index.js &
api_pid=$!

wait -n
exit $?
