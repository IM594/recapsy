/// Separates a side-effect-free screen-recording permission probe from the
/// explicit, user-initiated request that may display a macOS system prompt.
///
/// Capture ticks, status refreshes, and helper startup must use `probe`; they
/// are background operations and must never cause a system dialog. The only
/// caller of `requestIfNeeded` is the dedicated user action exposed by the
/// desktop shell.
public enum ScreenCaptureAuthorization {
    public static func probe(_ preflight: () -> Bool) -> Bool {
        return preflight()
    }

    public static func requestIfNeeded(
        preflight: () -> Bool,
        request: () -> Bool
    ) -> Bool {
        guard !preflight() else {
            return true
        }
        return request()
    }
}
