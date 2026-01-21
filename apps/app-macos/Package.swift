// swift-tools-version: 5.7
import PackageDescription

let package = Package(
  name: "recapsense-app-macos",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "recapsense-app", targets: ["RecapSenseApp"]),
  ],
  targets: [
    .executableTarget(
      name: "RecapSenseApp",
      path: "Sources"
    ),
  ]
)

