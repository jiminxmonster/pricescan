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

curl --fail --silent --show-error "$health_url"
printf '\nDeployment health check passed: %s\n' "$health_url"
