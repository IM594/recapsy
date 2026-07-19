#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# SwiftPM links every executable target into its generated test runner. Reuse
# the pinned static libwebp build so `swift test` can rebuild that runner rather
# than executing a stale binary with --skip-build.
WEBP_PREFIX="$(bash "${SCRIPT_DIR}/build-libwebp-static.sh")"
WEBP_BUILD_FLAGS=(
	-Xcc -I"${WEBP_PREFIX}/include"
	-Xlinker "${WEBP_PREFIX}/lib/libwebp.a"
	-Xlinker "${WEBP_PREFIX}/lib/libsharpyuv.a"
)

expected_tests="$(
	find "${SCRIPT_DIR}/Tests/CaptureCoreTests" -name '*.swift' -exec \
		grep -E '^[[:space:]]*func[[:space:]]+test' {} + | wc -l | tr -d '[:space:]'
)"
if ! test_output="$(swift test --package-path "${SCRIPT_DIR}" "${WEBP_BUILD_FLAGS[@]}")"; then
	printf '%s\n' "${test_output}"
	exit 1
fi
printf '%s\n' "${test_output}"

executed_tests="$(
	printf '%s\n' "${test_output}" |
		sed -n "/Test Suite 'All tests' passed/{n;s/.*Executed \([0-9][0-9]*\) tests.*/\1/p;}" |
		tail -n 1
)"
if [[ "${executed_tests}" != "${expected_tests}" ]]; then
	echo "error: CaptureCore test runner executed ${executed_tests:-0} tests; source defines ${expected_tests}." >&2
	exit 1
fi
