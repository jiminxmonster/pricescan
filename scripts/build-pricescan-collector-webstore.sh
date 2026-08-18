#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extensions/pricescan-collector"
OUT_DIR="$ROOT_DIR/artifacts/chrome-webstore"
BUILD_DIR="$OUT_DIR/pricescan-collector-webstore"
VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$EXT_DIR/manifest.webstore.json")"
ZIP_PATH="$OUT_DIR/pricescan-collector-${VERSION}-webstore.zip"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/icons" "$OUT_DIR"

cp "$EXT_DIR/background.js" "$BUILD_DIR/background.js"
cp "$EXT_DIR/pricescan-page.js" "$BUILD_DIR/pricescan-page.js"
cp "$EXT_DIR/popup.html" "$BUILD_DIR/popup.html"
cp "$EXT_DIR/popup.css" "$BUILD_DIR/popup.css"
cp "$EXT_DIR/popup.js" "$BUILD_DIR/popup.js"
cp "$EXT_DIR/manifest.webstore.json" "$BUILD_DIR/manifest.json"
cp "$EXT_DIR"/icons/*.png "$BUILD_DIR/icons/"

python3 -m json.tool "$BUILD_DIR/manifest.json" >/dev/null
node --check "$BUILD_DIR/background.js"
node --check "$BUILD_DIR/pricescan-page.js"
node --check "$BUILD_DIR/popup.js"

rm -f "$ZIP_PATH"
(
  cd "$BUILD_DIR"
  zip -qr "$ZIP_PATH" .
)

echo "$ZIP_PATH"
