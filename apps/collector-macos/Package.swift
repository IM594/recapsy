// swift-tools-version: 5.7
import PackageDescription

let package = Package(
  name: "recapsense-collector-macos",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "recapsense-collector", targets: ["RecapSenseCollector"]),
  ],
  dependencies: [
    .package(url: "https://github.com/SDWebImage/libwebp-Xcode.git", from: "1.3.2"),
  ],
  targets: [
    .executableTarget(
      name: "RecapSenseCollector",
      dependencies: [
        .product(name: "libwebp", package: "libwebp-Xcode"),
      ],
      path: "Sources"
    ),
    .testTarget(
      name: "RecapSenseCollectorTests",
      dependencies: ["RecapSenseCollector"],
      path: "Tests/RecapSenseCollectorTests"
    ),
  ]
)
