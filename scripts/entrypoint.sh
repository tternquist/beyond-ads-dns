#!/bin/sh
set -e

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
