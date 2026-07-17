#!/usr/bin/env bash
set -euo pipefail

server="${PRICESCAN_DEPLOY_SERVER:-root@141.164.35.141}"
key="${PRICESCAN_DEPLOY_KEY:-$HOME/.ssh/amado_vultr}"
remote_dir="${PRICESCAN_REMOTE_DIR:-/opt/pricescan}"
health_url="${PRICESCAN_HEALTH_URL:-https://pricescan.d2blue.com/api/health}"

if [[ ! -f "$key" ]]; then
  echo "Deploy key not found: $key" >&2
  exit 1
fi

ssh -i "$key" -o IdentitiesOnly=yes -o ConnectTimeout=10 "$server" \
  "set -e; cd '$remote_dir'; git pull --ff-only; docker compose up -d --build; docker compose ps"

for attempt in {1..20}; do
  if response="$(curl --fail --silent --show-error "$health_url" 2>/dev/null)"; then
    printf '%s\n' "$response"
    printf 'Deployment health check passed: %s\n' "$health_url"
    exit 0
  fi
  sleep 2
done

echo "Deployment health check failed after 40 seconds: $health_url" >&2
exit 1
