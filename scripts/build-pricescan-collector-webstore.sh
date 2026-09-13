#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extensions/pricescan-collector"
OUT_DIR="$ROOT_DIR/artifacts/chrome-webstore"
VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$EXT_DIR/manifest.webstore.json")"
ZIP_PATH="$OUT_DIR/pricescan-collector-${VERSION}-webstore.zip"

mkdir -p "$OUT_DIR"
BUILD_DIR="$(mktemp -d "$OUT_DIR/pricescan-collector-webstore.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
mkdir -p "$BUILD_DIR/icons"

cp "$EXT_DIR/extension-runtime.js" "$BUILD_DIR/extension-runtime.js"
cp "$EXT_DIR/pricescan-page.js" "$BUILD_DIR/pricescan-page.js"
cp "$EXT_DIR/popup.html" "$BUILD_DIR/popup.html"
cp "$EXT_DIR/popup.css" "$BUILD_DIR/popup.css"
cp "$EXT_DIR/popup.js" "$BUILD_DIR/popup.js"
for file in approval-flow.js approval-runtime.js agent-observer.js approval-panel.html approval-panel.css approval-panel.js; do
  cp "$EXT_DIR/$file" "$BUILD_DIR/$file"
done
cp "$EXT_DIR/manifest.webstore.json" "$BUILD_DIR/manifest.json"
cp "$EXT_DIR"/icons/*.png "$BUILD_DIR/icons/"

python3 -m json.tool "$BUILD_DIR/manifest.json" >/dev/null
node --check "$BUILD_DIR/extension-runtime.js"
node --check "$BUILD_DIR/pricescan-page.js"
node --check "$BUILD_DIR/popup.js"
for file in approval-flow.js approval-runtime.js agent-observer.js approval-panel.js; do
  node --check "$BUILD_DIR/$file"
done

if [[ -e "$ZIP_PATH" ]]; then
  ZIP_PATH="$OUT_DIR/pricescan-collector-${VERSION}-webstore-$(date +%Y%m%d%H%M%S).zip"
fi
(
  cd "$BUILD_DIR"
  zip -qr "$ZIP_PATH" .
)

echo "$ZIP_PATH"
