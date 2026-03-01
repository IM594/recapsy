#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_PROFILE="${1:-release}"
APP_NAME="RecaplySense"
CLI_NAME="RecaplySenseCLI"
APP_DIR="$ROOT_DIR/dist/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
MODULE_CACHE_DIR="$ROOT_DIR/.build/clang-module-cache"
BUNDLE_ID="${BUNDLE_ID:-com.recaply.sense}"
APP_VERSION="${APP_VERSION:-0.1.0}"
AUTO_CODESIGN="${AUTO_CODESIGN:-1}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-}"

usage() {
  cat >&2 <<EOF
usage: $0 [debug|release|debug-dev]

build profiles:
  debug      Build debug binary and recreate app bundle
  release    Build release binary and recreate app bundle
  debug-dev  Build debug binary for local iteration; keeps existing app path

env overrides:
  BUNDLE_ID=<bundle id>                 default: com.recaply.sense
  APP_VERSION=<version>                 default: 0.1.0
  CODESIGN_IDENTITY=<codesign identity> e.g. Apple Development: ...
  AUTO_CODESIGN=0|1                     default: 1 (auto-detect Apple Development identity)
EOF
}

resolve_build_config() {
  case "$BUILD_PROFILE" in
    debug)
      echo "debug"
      ;;
    release)
      echo "release"
      ;;
    debug-dev)
      echo "debug"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

should_clean_bundle() {
  if [[ "$BUILD_PROFILE" == "debug-dev" ]]; then
    echo "0"
  else
    echo "1"
  fi
}

resolve_codesign_identity() {
  if [[ -n "$CODESIGN_IDENTITY" ]]; then
    echo "$CODESIGN_IDENTITY"
    return 0
  fi

  if [[ "$AUTO_CODESIGN" != "1" ]]; then
    return 1
  fi

  if ! command -v security >/dev/null 2>&1; then
    return 1
  fi

  local detected
  detected="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)"
  if [[ -n "$detected" ]]; then
    echo "$detected"
    return 0
  fi

  return 1
}

BUILD_CONFIG="$(resolve_build_config)"
SHOULD_CLEAN_BUNDLE="$(should_clean_bundle)"

cd "$ROOT_DIR"
mkdir -p "$MODULE_CACHE_DIR"
export CLANG_MODULE_CACHE_PATH="$MODULE_CACHE_DIR"
swift build -c "$BUILD_CONFIG" --product "$CLI_NAME"

BIN_PATH="$ROOT_DIR/.build/${BUILD_CONFIG}/${CLI_NAME}"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "binary not found: $BIN_PATH" >&2
  exit 1
fi

if [[ "$SHOULD_CLEAN_BUNDLE" == "1" ]]; then
  rm -rf "$APP_DIR"
fi
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
  <string>${BUNDLE_ID}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

if SIGNING_IDENTITY="$(resolve_codesign_identity)"; then
  echo "codesigning app with identity: $SIGNING_IDENTITY"
  codesign --force --deep --sign "$SIGNING_IDENTITY" --timestamp=none "$APP_DIR"
  codesign --verify --deep --strict "$APP_DIR"
else
  echo "warning: code signing skipped (set CODESIGN_IDENTITY to a stable Apple Development identity)." >&2
  echo "warning: unsigned bundles may trigger repeated screen/accessibility permission prompts." >&2
fi

echo "app bundle created: $APP_DIR"
echo "build profile: $BUILD_PROFILE (swift config: $BUILD_CONFIG)"
if [[ "$SHOULD_CLEAN_BUNDLE" == "0" ]]; then
  echo "dev note: debug-dev preserves app path and avoids full bundle cleanup for faster local iteration."
fi
