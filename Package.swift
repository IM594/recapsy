// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RecaplySense",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "RecaplySenseCore",
            targets: ["RecaplySenseCore"]
        ),
        .executable(
            name: "RecaplySenseCLI",
            targets: ["RecaplySenseCLI"]
        )
    ],
    targets: [
        .target(
            name: "RecaplySenseCore"
        ),
        .executableTarget(
            name: "RecaplySenseCLI",
            dependencies: ["RecaplySenseCore"]
        ),
        .testTarget(
            name: "RecaplySenseCoreTests",
            dependencies: ["RecaplySenseCore"]
        )
    ]
)
