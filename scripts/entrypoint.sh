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

# Run DNS resolver and metrics API in parallel. Exit when either exits.
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

node /app/src/index.js &
api_pid=$!

wait -n
exit $?
