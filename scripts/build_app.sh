#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_CONFIG="${1:-release}"
APP_NAME="RecaplySense"
CLI_NAME="RecaplySenseCLI"
APP_DIR="$ROOT_DIR/dist/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
MODULE_CACHE_DIR="$ROOT_DIR/.build/clang-module-cache"

if [[ "$BUILD_CONFIG" != "debug" && "$BUILD_CONFIG" != "release" ]]; then
  echo "usage: $0 [debug|release]" >&2
  exit 1
fi

cd "$ROOT_DIR"
mkdir -p "$MODULE_CACHE_DIR"
export CLANG_MODULE_CACHE_PATH="$MODULE_CACHE_DIR"
swift build -c "$BUILD_CONFIG" --product "$CLI_NAME"

BIN_PATH="$ROOT_DIR/.build/${BUILD_CONFIG}/${CLI_NAME}"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "binary not found: $BIN_PATH" >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

cp "$BIN_PATH" "$MACOS_DIR/$APP_NAME"
chmod +x "$MACOS_DIR/$APP_NAME"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.recaply.sense</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

echo "app bundle created: $APP_DIR"
