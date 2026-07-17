#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! WEBP_PREFIX="$(brew --prefix webp 2>/dev/null)" || [[ ! -d "${WEBP_PREFIX}" ]]; then
	echo "error: libwebp not found. Run 'brew install webp' first." >&2
	exit 1
fi

WEBP_INCLUDE="${WEBP_PREFIX}/include"
WEBP_LIB="${WEBP_PREFIX}/lib"
for archive in "${WEBP_LIB}/libwebp.a" "${WEBP_LIB}/libsharpyuv.a"; do
	if [[ ! -f "${archive}" ]]; then
		echo "error: expected static archive missing: ${archive}" >&2
		exit 1
	fi
done

swift test \
	--package-path "${SCRIPT_DIR}" \
	-Xcc -I"${WEBP_INCLUDE}" \
	-Xlinker "${WEBP_LIB}/libwebp.a" \
	-Xlinker "${WEBP_LIB}/libsharpyuv.a"
