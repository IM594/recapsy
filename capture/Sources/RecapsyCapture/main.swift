import CaptureCore
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())

switch Invocation.parse(arguments) {
case .printVersion:
    print(CaptureVersion.current)
    exit(0)
case .run:
    exit(0)
}
