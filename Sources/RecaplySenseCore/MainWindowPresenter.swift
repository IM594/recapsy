import Foundation

public struct MainWindowViewModel: Sendable {
    public let statusText: String
    public let permissionText: String
    public let statsText: String
    public let latestCaptureText: String
    public let latestFrameOCRText: String
    public let latestChunkText: String
    public let dataDirectoryText: String
    public let errorText: String
    public let hintText: String

    public let statusItemTitle: String
    public let startButtonEnabled: Bool
    public let pauseButtonEnabled: Bool
    public let resumeButtonEnabled: Bool
    public let stopButtonEnabled: Bool
    public let openDataButtonEnabled: Bool

    public init(
        statusText: String,
        permissionText: String,
        statsText: String,
        latestCaptureText: String,
        latestFrameOCRText: String,
        latestChunkText: String,
        dataDirectoryText: String,
        errorText: String,
        hintText: String,
        statusItemTitle: String,
        startButtonEnabled: Bool,
        pauseButtonEnabled: Bool,
        resumeButtonEnabled: Bool,
        stopButtonEnabled: Bool,
        openDataButtonEnabled: Bool
    ) {
        self.statusText = statusText
        self.permissionText = permissionText
        self.statsText = statsText
        self.latestCaptureText = latestCaptureText
        self.latestFrameOCRText = latestFrameOCRText
        self.latestChunkText = latestChunkText
        self.dataDirectoryText = dataDirectoryText
        self.errorText = errorText
        self.hintText = hintText
        self.statusItemTitle = statusItemTitle
        self.startButtonEnabled = startButtonEnabled
        self.pauseButtonEnabled = pauseButtonEnabled
        self.resumeButtonEnabled = resumeButtonEnabled
        self.stopButtonEnabled = stopButtonEnabled
        self.openDataButtonEnabled = openDataButtonEnabled
    }
}

public struct MainWindowPresenter {
    public init() {}

    public func makeViewModel(
        snapshot: DashboardSnapshot,
        lifecycleState: CaptureLifecycleState?,
        hasDataDirectory: Bool
    ) -> MainWindowViewModel {
        let buttonState = buttonState(for: lifecycleState)
        return MainWindowViewModel(
            statusText: snapshot.statusText,
            permissionText: snapshot.permissionText,
            statsText: snapshot.statsText,
            latestCaptureText: snapshot.latestCaptureText,
            latestFrameOCRText: snapshot.latestFrameOCRText,
            latestChunkText: snapshot.latestChunkText,
            dataDirectoryText: snapshot.dataDirectoryText,
            errorText: snapshot.errorText,
            hintText: snapshot.hintText,
            statusItemTitle: statusItemTitle(for: lifecycleState),
            startButtonEnabled: buttonState.startEnabled,
            pauseButtonEnabled: buttonState.pauseEnabled,
            resumeButtonEnabled: buttonState.resumeEnabled,
            stopButtonEnabled: buttonState.stopEnabled,
            openDataButtonEnabled: hasDataDirectory
        )
    }

    public func statusItemTitle(for lifecycleState: CaptureLifecycleState?) -> String {
        switch lifecycleState {
        case .running:
            return "RS:R"
        case .paused:
            return "RS:P"
        case .stopped, .none:
            return "RS:S"
        }
    }

    private func buttonState(for lifecycleState: CaptureLifecycleState?) -> CaptureButtonState {
        switch lifecycleState {
        case .running:
            return CaptureButtonState(startEnabled: false, pauseEnabled: true, resumeEnabled: false, stopEnabled: true)
        case .paused:
            return CaptureButtonState(startEnabled: false, pauseEnabled: false, resumeEnabled: true, stopEnabled: true)
        case .stopped, .none:
            return CaptureButtonState(startEnabled: true, pauseEnabled: false, resumeEnabled: false, stopEnabled: false)
        }
    }
}

private struct CaptureButtonState {
    let startEnabled: Bool
    let pauseEnabled: Bool
    let resumeEnabled: Bool
    let stopEnabled: Bool
}
