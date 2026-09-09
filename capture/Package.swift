// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "RecapsyCapture",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CaptureCore"),
        .executableTarget(
            name: "RecapsyCapture",
            dependencies: ["CaptureCore"]
        ),
        .testTarget(
            name: "CaptureCoreTests",
            dependencies: ["CaptureCore"]
        ),
    ]
)
