import Foundation

public enum CaptureSourceFactory {
    public static func makeDefault(mediaDirectory: URL) throws -> FrameSource {
        let fallback = try CGWindowCaptureSource(mediaDirectory: mediaDirectory)

        #if canImport(ScreenCaptureKit)
        if #available(macOS 14.0, *) {
            let primary = try ScreenCaptureKitFrameSource(mediaDirectory: mediaDirectory)
            return FallbackFrameSource(primary: primary, fallback: fallback)
        }
        #endif

        return fallback
    }
}
