// swift-tools-version:5.9
import PackageDescription

// macOS screen-capture process for Recapsy desktop (ADR 0009).
//
// Three artifacts:
//   - CaptureCore     : pure, dependency-free logic (relative keys, JPEG path
//                       joins, NDJSON envelope encoding, hashing) — unit tested.
//   - RecapsyCapture  : the capture executable. Physically renamed to `Recapsy`
//                       when assembled into `Recapsy.app` so the screen-recording
//                       privacy panel shows the product name (ADR 0009 约束③).
//   - CaptureLauncher : a minimal C launcher that posix_spawns the capture
//                       executable with `responsibility_spawnattrs_setdisclaim`
//                       so the capture process becomes its own TCC responsible
//                       process under bundle id `one.recapsy.desktop.capture`.
let package = Package(
    name: "RecapsyCapture",
    platforms: [
        .macOS(.v14),
    ],
    targets: [
        .target(
            name: "CaptureCore"
        ),
        .executableTarget(
            name: "RecapsyCapture",
            dependencies: ["CaptureCore"]
        ),
        .executableTarget(
            name: "CaptureLauncher"
        ),
        .testTarget(
            name: "CaptureCoreTests",
            dependencies: ["CaptureCore"]
        ),
    ]
)
