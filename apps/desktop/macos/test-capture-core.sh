#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CaptureCore is deliberately independent of the native encoder. Build only
# its test target so pure Swift tests remain runnable without downloading or
# linking libwebp; package:macos separately builds the real capture bundle.
swift build --package-path "${SCRIPT_DIR}" --target CaptureCoreTests
swift test --package-path "${SCRIPT_DIR}" --skip-build
