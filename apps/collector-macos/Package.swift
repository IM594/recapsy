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
  targets: [
    .executableTarget(
      name: "RecapSenseCollector",
      path: "Sources"
    ),
  ]
)

