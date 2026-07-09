#!/usr/bin/env bash
#
# Builds and code-signs the Recapsy macOS capture bundle (ADR 0009).
#
# Produces a stable, gitignored `Recapsy.app` under `macos/build/` — never under
# a system temp directory, because macOS refuses to persist accessibility grants
# for bundles living in /tmp (ADR 0009 约束①). The bundle contains:
#   Contents/MacOS/Recapsy          — the capture executable (renamed so the
#                                      privacy panel shows "Recapsy", ADR 约束③)
#   Contents/MacOS/CaptureLauncher  — the disclaim launcher Electron spawns
#   Contents/Info.plist             — frozen bundle identity
#
# The whole bundle is signed with a stable identity (dev: the self-signed
# `Recapsy Developer` cert) so the capture process holds its own first-class TCC
# identity under bundle id `one.recapsy.desktop.capture`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_CONFIG="release"
BUILD_DIR="${SCRIPT_DIR}/build"
APP_DIR="${BUILD_DIR}/Recapsy.app"
MACOS_DIR="${APP_DIR}/Contents/MacOS"

# Dev signing identity. Overridable for other machines / channels; defaults to
# the self-signed cert ADR 0009 pins for dev. Not a secret — a local keychain
# identity name.
SIGN_IDENTITY="${RECAPSY_CAPTURE_SIGN_IDENTITY:-Recapsy Developer}"

echo "==> swift build -c ${BUILD_CONFIG}"
swift build --package-path "${SCRIPT_DIR}" -c "${BUILD_CONFIG}"

BIN_DIR="$(swift build --package-path "${SCRIPT_DIR}" -c "${BUILD_CONFIG}" --show-bin-path)"
CAPTURE_BIN="${BIN_DIR}/RecapsyCapture"
LAUNCHER_BIN="${BIN_DIR}/CaptureLauncher"

for bin in "${CAPTURE_BIN}" "${LAUNCHER_BIN}"; do
	if [[ ! -x "${bin}" ]]; then
		echo "error: expected build product missing: ${bin}" >&2
		exit 1
	fi
done

echo "==> assembling ${APP_DIR}"
rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}"
# CFBundleExecutable is "Recapsy", so the capture binary must be named Recapsy.
cp "${CAPTURE_BIN}" "${MACOS_DIR}/Recapsy"
cp "${LAUNCHER_BIN}" "${MACOS_DIR}/CaptureLauncher"
cp "${SCRIPT_DIR}/Resources/Info.plist" "${APP_DIR}/Contents/Info.plist"

# Fail loudly if the plist is malformed or the frozen id drifted.
plutil -lint "${APP_DIR}/Contents/Info.plist" >/dev/null
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${APP_DIR}/Contents/Info.plist")"
if [[ "${BUNDLE_ID}" != "one.recapsy.desktop.capture" ]]; then
	echo "error: bundle id drifted to '${BUNDLE_ID}'" >&2
	exit 1
fi

echo "==> codesign (identity: ${SIGN_IDENTITY})"
# Sign inside-out: nested launcher first, then the whole bundle (which signs the
# main executable and seals the bundle).
codesign --force --sign "${SIGN_IDENTITY}" "${MACOS_DIR}/CaptureLauncher"
codesign --force --sign "${SIGN_IDENTITY}" "${APP_DIR}"

echo "==> codesign -dv verification"
codesign -dv --verbose=4 "${APP_DIR}" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|Signature'
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

echo ""
echo "capture bundle:   ${APP_DIR}"
echo "launcher path:    ${MACOS_DIR}/CaptureLauncher"
echo "capture path:     ${MACOS_DIR}/Recapsy"
