#!/usr/bin/env bash
set -euo pipefail

: "${CHROME_WEBSTORE_ACCESS_TOKEN:?CHROME_WEBSTORE_ACCESS_TOKEN is required}"
: "${CHROME_WEBSTORE_PUBLISHER_ID:?CHROME_WEBSTORE_PUBLISHER_ID is required}"
: "${CHROME_WEBSTORE_EXTENSION_ID:?CHROME_WEBSTORE_EXTENSION_ID is required}"

zip_path="${1:?Usage: publish-chrome-webstore-v2.sh <extension.zip>}"
if [[ ! -f "$zip_path" ]]; then
  echo "Extension package not found: $zip_path" >&2
  exit 1
fi

item_name="publishers/${CHROME_WEBSTORE_PUBLISHER_ID}/items/${CHROME_WEBSTORE_EXTENSION_ID}"
upload_url="https://chromewebstore.googleapis.com/upload/v2/${item_name}:upload"
status_url="https://chromewebstore.googleapis.com/v2/${item_name}:fetchStatus"
publish_url="https://chromewebstore.googleapis.com/v2/${item_name}:publish"
auth_header="Authorization: Bearer ${CHROME_WEBSTORE_ACCESS_TOKEN}"

echo "Uploading ${zip_path}"
curl --fail-with-body --silent --show-error \
  -H "$auth_header" \
  -H "Content-Type: application/zip" \
  -X POST \
  -T "$zip_path" \
  "$upload_url"
echo

for attempt in {1..30}; do
  status_json="$(curl --fail-with-body --silent --show-error -H "$auth_header" "$status_url")"
  upload_state="$(printf '%s' "$status_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("uploadState", ""))')"
  echo "Upload state: ${upload_state:-unknown}"

  if [[ "$upload_state" == "UPLOAD_SUCCEEDED" || "$upload_state" == "SUCCEEDED" ]]; then
    break
  fi
  if [[ "$upload_state" == *"FAILED" || "$upload_state" == *"ERROR" ]]; then
    printf '%s\n' "$status_json" >&2
    exit 1
  fi
  if [[ "$attempt" -eq 30 ]]; then
    printf '%s\n' "$status_json" >&2
    echo "Timed out waiting for Chrome Web Store upload processing." >&2
    exit 1
  fi
  sleep 10
done

echo "Submitting the uploaded version for review"
curl --fail-with-body --silent --show-error \
  -H "$auth_header" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"publishType":"DEFAULT_PUBLISH","blockOnWarnings":true}' \
  "$publish_url"
echo
