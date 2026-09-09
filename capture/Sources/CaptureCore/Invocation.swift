public enum Invocation: Equatable {
    case run
    case printVersion

    public static func parse(_ arguments: [String]) -> Invocation {
        arguments.contains("--version") ? .printVersion : .run
    }
}
