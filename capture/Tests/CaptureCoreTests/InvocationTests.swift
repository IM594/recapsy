import CaptureCore
import Testing

@Test func versionFlagAlone() {
    #expect(Invocation.parse(["--version"]) == .printVersion)
}

@Test func versionFlagAmongOtherArguments() {
    #expect(Invocation.parse(["--foo", "--version", "bar"]) == .printVersion)
}

@Test func emptyArguments() {
    #expect(Invocation.parse([]) == .run)
}

@Test func unrelatedArguments() {
    #expect(Invocation.parse(["--foo", "bar"]) == .run)
}
