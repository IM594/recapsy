#!/usr/bin/env bash
# Builds the exact libwebp archive consumed by the native capture helper.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
ARCHITECTURE="${RECAPSY_CAPTURE_ARCH:-$(uname -m)}"
DEPLOYMENT_TARGET="14.0"
VERSION="1.6.0"
SOURCE_SHA256="e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564"
SOURCE_URL="https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${VERSION}.tar.gz"

if [[ "${ARCHITECTURE}" != "arm64" && "${ARCHITECTURE}" != "x86_64" ]]; then
	echo "error: capture builds support only arm64 or x86_64." >&2
	exit 1
fi

if [[ "$(uname -m)" != "${ARCHITECTURE}" ]]; then
	echo "error: capture builds must run natively for the requested architecture." >&2
	exit 1
fi

for command in cmake curl lipo otool shasum; do
	if ! command -v "${command}" >/dev/null 2>&1; then
		echo "error: required build command is unavailable: ${command}" >&2
		exit 1
	fi
done

SOURCE_CACHE_DIR="${BUILD_DIR}/third-party/source-cache"
SOURCE_ARCHIVE="${SOURCE_CACHE_DIR}/libwebp-${VERSION}.tar.gz"
SOURCE_ROOT="${BUILD_DIR}/third-party/libwebp-${VERSION}"
SOURCE_DIR="${SOURCE_ROOT}/libwebp-${VERSION}"
CMAKE_BUILD_DIR="${BUILD_DIR}/third-party/libwebp-${VERSION}-${ARCHITECTURE}-macos-${DEPLOYMENT_TARGET}"
INSTALL_DIR="${BUILD_DIR}/third-party/libwebp-${ARCHITECTURE}-macos-${DEPLOYMENT_TARGET}"
PROVENANCE_PATH="${BUILD_DIR}/libwebp-${ARCHITECTURE}.json"

mkdir -p "${SOURCE_CACHE_DIR}" "${SOURCE_ROOT}"

if [[ ! -f "${SOURCE_ARCHIVE}" ]]; then
	partial_archive="${SOURCE_ARCHIVE}.partial"
	echo "==> downloading libwebp ${VERSION}" >&2
	curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "${partial_archive}" "${SOURCE_URL}"
	mv "${partial_archive}" "${SOURCE_ARCHIVE}"
fi

actual_sha256="$(shasum -a 256 "${SOURCE_ARCHIVE}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${SOURCE_SHA256}" ]]; then
	echo "error: libwebp source checksum mismatch." >&2
	exit 1
fi

if [[ ! -f "${SOURCE_DIR}/CMakeLists.txt" ]]; then
	echo "==> extracting libwebp ${VERSION}" >&2
	tar -xzf "${SOURCE_ARCHIVE}" -C "${SOURCE_ROOT}"
fi

echo "==> building libwebp ${VERSION} (${ARCHITECTURE}, macOS ${DEPLOYMENT_TARGET})" >&2
MACOSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" cmake \
	-S "${SOURCE_DIR}" \
	-B "${CMAKE_BUILD_DIR}" \
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_INSTALL_PREFIX="${INSTALL_DIR}" \
	-DCMAKE_OSX_ARCHITECTURES="${ARCHITECTURE}" \
	-DCMAKE_OSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
	-DBUILD_SHARED_LIBS=OFF \
	-DWEBP_BUILD_ANIM_UTILS=OFF \
	-DWEBP_BUILD_CWEBP=OFF \
	-DWEBP_BUILD_DWEBP=OFF \
	-DWEBP_BUILD_EXTRAS=OFF \
	-DWEBP_BUILD_GIF2WEBP=OFF \
	-DWEBP_BUILD_IMG2WEBP=OFF \
	-DWEBP_BUILD_VWEBP=OFF \
	-DWEBP_BUILD_WEBPINFO=OFF \
	-DWEBP_BUILD_WEBPMUX=OFF >&2
cmake --build "${CMAKE_BUILD_DIR}" --config Release --parallel >&2
cmake --install "${CMAKE_BUILD_DIR}" --config Release >&2
mkdir -p "${INSTALL_DIR}/share/doc/libwebp"
cp "${SOURCE_DIR}/COPYING" "${INSTALL_DIR}/share/doc/libwebp/COPYING"

WEBP_ARCHIVE="${INSTALL_DIR}/lib/libwebp.a"
SHARPYUV_ARCHIVE="${INSTALL_DIR}/lib/libsharpyuv.a"
for archive in "${WEBP_ARCHIVE}" "${SHARPYUV_ARCHIVE}"; do
	if [[ ! -f "${archive}" ]]; then
		echo "error: expected static archive missing: ${archive}" >&2
		exit 1
	fi
	if [[ "$(lipo -archs "${archive}")" != "${ARCHITECTURE}" ]]; then
		echo "error: libwebp archive has an unexpected architecture: ${archive}" >&2
		exit 1
	fi
	minimum_versions="$(otool -l "${archive}" | awk '/minos / { print $2 }' | sort -u | tr '\n' ' ' | sed 's/ $//')"
	if [[ "${minimum_versions}" != "${DEPLOYMENT_TARGET}" ]]; then
		echo "error: libwebp archive does not target macOS ${DEPLOYMENT_TARGET}: ${archive}" >&2
		exit 1
	fi
done

json_string() {
	local value="${1//\\/\\\\}"
	value="${value//\"/\\\"}"
	printf '"%s"' "${value}"
}

{
	printf '{\n'
	printf '  "architecture": '; json_string "${ARCHITECTURE}"; printf ',\n'
	printf '  "deploymentTarget": '; json_string "${DEPLOYMENT_TARGET}"; printf ',\n'
	printf '  "libsharpyuvArchive": '; json_string "${SHARPYUV_ARCHIVE}"; printf ',\n'
	printf '  "libwebpArchive": '; json_string "${WEBP_ARCHIVE}"; printf ',\n'
	printf '  "sourceSha256": '; json_string "${SOURCE_SHA256}"; printf ',\n'
	printf '  "sourceUrl": '; json_string "${SOURCE_URL}"; printf ',\n'
	printf '  "version": '; json_string "${VERSION}"; printf '\n}\n'
} > "${PROVENANCE_PATH}"

printf '%s\n' "${INSTALL_DIR}"
