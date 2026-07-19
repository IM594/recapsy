// Umbrella header exposing the libwebp encoder C API to Swift as the `CWebP`
// module (ADR 0009 增量 1D: WebP capture encoding).
//
// The concrete header/library location is NEVER hard-coded here or in
// Package.swift. `build-capture-bundle.sh` builds a pinned source archive for
// arm64/macOS 14 and passes its prefix to `swift build` as
// `-Xcc -I<prefix>/include` (so this `#include <webp/encode.h>` resolves) plus
// `-Xlinker <prefix>/lib/libwebp.a -Xlinker <prefix>/lib/libsharpyuv.a` (static
// link, so the assembled capture binary carries no runtime libwebp dylib
// dependency). `encode.h` transitively includes `types.h`, which declares
// `WebPFree`.
#include <webp/encode.h>
