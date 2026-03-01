import Foundation

public struct AppRuntime {
    public let databaseURL: URL
    public let mediaDirectory: URL
    public let store: MemoryStore
    public let captureService: CaptureService
    public let lifecycleController: CaptureLifecycleController

    public init(
        databaseURL: URL,
        mediaDirectory: URL,
        store: MemoryStore,
        captureService: CaptureService,
        lifecycleController: CaptureLifecycleController
    ) {
        self.databaseURL = databaseURL
        self.mediaDirectory = mediaDirectory
        self.store = store
        self.captureService = captureService
        self.lifecycleController = lifecycleController
    }
}

public enum AppRuntimeBuilder {
    public static func build(
        databaseURL: URL,
        mediaDirectory: URL,
        captureInterval: TimeInterval = 2.0,
        windowSize: TimeInterval = 120,
        now: @escaping () -> Date = Date.init,
        onCaptureError: @escaping (Error) -> Void = { _ in },
        ocrProvider: OCRProvider = VisionOCRProvider(),
        frameSourceFactory: (URL) throws -> FrameSource = CaptureSourceFactory.makeDefault
    ) throws -> AppRuntime {
        let memoryStore = try MemoryStore(databaseURL: databaseURL)
        try memoryStore.bootstrapSchema()

        let pipeline = OfflinePipeline(
            store: memoryStore,
            ocrProvider: ocrProvider,
            windowSize: windowSize
        )

        let source = try frameSourceFactory(mediaDirectory)
        let service = CaptureService(
            frameSource: source,
            pipeline: pipeline,
            now: now,
            onError: onCaptureError
        )

        let lifecycleController = CaptureLifecycleController(
            captureService: service,
            captureInterval: captureInterval
        )

        return AppRuntime(
            databaseURL: databaseURL,
            mediaDirectory: mediaDirectory,
            store: memoryStore,
            captureService: service,
            lifecycleController: lifecycleController
        )
    }
}
