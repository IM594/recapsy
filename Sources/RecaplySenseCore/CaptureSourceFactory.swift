import Foundation

public enum CaptureSourceFactory {
    public static func makeDefault(mediaDirectory: URL) throws -> FrameSource {
        try makeDefault(
            mediaDirectory: mediaDirectory,
            primaryFactory: { url in
                #if canImport(ScreenCaptureKit)
                if #available(macOS 14.0, *) {
                    return try ScreenCaptureKitFrameSource(mediaDirectory: url)
                }
                #endif
                return nil
            },
            fallbackFactory: { url in
                try CGWindowCaptureSource(mediaDirectory: url)
            }
        )
    }

    static func makeDefault(
        mediaDirectory: URL,
        primaryFactory: (URL) throws -> FrameSource?,
        fallbackFactory: (URL) throws -> FrameSource
    ) throws -> FrameSource {
        let fallback = try fallbackFactory(mediaDirectory)
        guard let primary = try primaryFactory(mediaDirectory) else {
            return fallback
        }
        return FallbackFrameSource(primary: primary, fallback: fallback)
    }
}
