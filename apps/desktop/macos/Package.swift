// swift-tools-version:5.9
import PackageDescription

// macOS screen-capture process for Recapsy desktop (ADR 0009).
//
// Artifacts:
//   - CaptureCore     : system-framework-only logic (relative keys, asset path
//                       joins, NDJSON encoding, hashing, active-window selection,
//                       in-memory frame sampling) — unit tested, no libwebp.
//   - CWebP           : system-library shim exposing libwebp's C encoder API.
//                       Header/library paths are supplied at build time by the
//                       pinned macOS-14 source build — see `Sources/CWebP/shim.h`.
//   - RecapsyCapture  : the capture executable. Physically renamed to `Recapsy`
//                       when assembled into `Recapsy.app` so the screen-recording
//                       privacy panel shows the product name (ADR 0009 约束③).
//   - CaptureLauncher : a minimal C launcher that posix_spawns the capture
//                       executable with `responsibility_spawnattrs_setdisclaim`
//                       so the capture process becomes its own TCC responsible
//                       process under bundle id `one.recapsy.desktop.capture`.
//
// `swift test` builds only CaptureCore + its tests, so it needs no libwebp and
// runs standalone. `swift build` of RecapsyCapture requires the libwebp include
// path; run it through `build-capture-bundle.sh` — a bare `swift build` without
// that flag cannot resolve `<webp/encode.h>` and is expected to fail.
let package = Package(
    name: "RecapsyCapture",
    platforms: [
        .macOS(.v14),
    ],
    targets: [
        .target(
            name: "CaptureCore"
        ),
        .target(
            name: "FrameCorpusTooling",
            dependencies: ["CaptureCore"],
            path: "Tests/FixtureTools/FrameCorpusTooling"
        ),
        // No `pkgConfig`/path here on purpose: pkg-config would inject a dynamic
        // `-lwebp`, which pulls libwebp.dylib and defeats the self-contained,
        // statically-linked capture binary we want. `build-capture-bundle.sh`
        // resolves a pinned libwebp source build and passes the header search
        // path (`-Xcc -I…/include`) plus the static archives
        // (`-Xlinker …/libwebp.a -Xlinker …/libsharpyuv.a`) to `swift build`.
        // Because this target has no default header/library path, a bare
        // `swift build`/`swift test` of the *executable* cannot resolve
        // `<webp/encode.h>`; the pure-logic tests are built target-scoped
        // (`swift build --target CaptureCoreTests`) so they never need libwebp.
        .systemLibrary(
            name: "CWebP"
        ),
        .executableTarget(
            name: "RecapsyCapture",
            dependencies: ["CaptureCore", "CWebP"]
        ),
        .executableTarget(
            name: "CaptureLauncher"
        ),
        .executableTarget(
            name: "FrameCorpusCapture",
            dependencies: ["CaptureCore", "FrameCorpusTooling"],
            path: "Tests/FixtureTools/FrameCorpusCapture"
        ),
        .testTarget(
            name: "CaptureCoreTests",
            dependencies: ["CaptureCore", "FrameCorpusTooling"],
            resources: [
                .process("Fixtures"),
            ]
        ),
    ]
)
