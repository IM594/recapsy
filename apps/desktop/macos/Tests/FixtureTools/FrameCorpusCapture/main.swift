import AppKit
import CaptureCore
import Darwin
import Foundation
import FrameCorpusTooling
import ScreenCaptureKit

private enum CommandError: Error, CustomStringConvertible {
    case captureDecisionMismatch(String, String)
    case corpusAlreadyExists(String)
    case corpusContainsUnexpectedFiles
    case imageCreationFailed(String)
    case invalidArguments
    case outputMustBeAbsolute
    case ownedWindowUnavailable

    var description: String {
        switch self {
        case let .captureDecisionMismatch(file, actual):
            return "Fixture \(file) produced unexpected frame decision \(actual)."
        case let .corpusAlreadyExists(path):
            return "Corpus output already exists: \(path)"
        case .corpusContainsUnexpectedFiles:
            return "Corpus contains files outside the pending manifest."
        case let .imageCreationFailed(file):
            return "Could not render PNG fixture \(file)."
        case .invalidArguments:
            return "Invalid arguments. Use `capture --output PATH` or " +
                "`approve --corpus PATH --confirm-no-user-data`."
        case .outputMustBeAbsolute:
            return "Corpus path must be absolute."
        case .ownedWindowUnavailable:
            return "The purpose-built window does not have one verified ScreenCaptureKit identity."
        }
    }
}

private enum Command {
    case capture(URL)
    case approve(URL)

    static func parse(_ arguments: [String]) throws -> Command {
        if arguments.count == 3,
           arguments[0] == "capture",
           arguments[1] == "--output" {
            return .capture(try absoluteDirectory(arguments[2]))
        }
        if arguments.count == 4,
           arguments[0] == "approve",
           arguments[1] == "--corpus",
           arguments[3] == "--confirm-no-user-data" {
            return .approve(try absoluteDirectory(arguments[2]))
        }
        throw CommandError.invalidArguments
    }

    private static func absoluteDirectory(_ path: String) throws -> URL {
        guard path.hasPrefix("/") else {
            throw CommandError.outputMustBeAbsolute
        }
        return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }
}

private struct RenderedFixture {
    let input: FrameCorpusFixtureInput
}

@main
private struct FrameCorpusCaptureCommand {
    @MainActor
    static func main() async {
        do {
            switch try Command.parse(Array(CommandLine.arguments.dropFirst())) {
            case let .capture(outputDirectory):
                try await capture(outputDirectory: outputDirectory)
            case let .approve(corpusDirectory):
                try approve(corpusDirectory: corpusDirectory)
            }
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }

    @MainActor
    private static func capture(outputDirectory: URL) async throws {
        try FrameCorpusOutputGuard.requireOutsideRepository(
            outputDirectory,
            repositoryDirectory: repositoryDirectory
        )
        guard !FileManager.default.fileExists(atPath: outputDirectory.path) else {
            throw CommandError.corpusAlreadyExists(outputDirectory.path)
        }

        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let view = FrameCorpusView(
            frame: NSRect(x: 0, y: 0, width: 480, height: 270)
        )
        let window = NSWindow(
            contentRect: view.bounds,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.hasShadow = false
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        application.activate(ignoringOtherApps: true)
        drainRunLoop()
        defer { window.close() }

        var rendered: [RenderedFixture] = []
        for specification in FrameCorpusFixtureSpecification.all {
            view.scene = specification.scene
            view.needsDisplay = true
            view.displayIfNeeded()
            drainRunLoop()

            guard view.window === window, window.contentView === view else {
                throw CommandError.imageCreationFailed(specification.file)
            }
            let image = try await captureOwnedWindow(window)
            let representation = NSBitmapImageRep(cgImage: image)
            guard let data = representation.representation(using: .png, properties: [:])
            else {
                throw CommandError.imageCreationFailed(specification.file)
            }
            try verifyDecision(
                image: image,
                expected: specification.expected,
                file: specification.file
            )
            rendered.append(RenderedFixture(input: FrameCorpusFixtureInput(
                file: specification.file,
                data: data,
                pixelWidth: image.width,
                pixelHeight: image.height,
                expected: specification.expected,
                purpose: specification.purpose
            )))
        }

        let pendingManifest = try FrameCorpusManifestFactory.makePending(
            fixtures: rendered.map(\.input)
        )
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: false
        )
        for fixture in rendered {
            try FrameCorpusFileWriter.writeNew(
                fixture.input.data,
                to: outputDirectory.appendingPathComponent(fixture.input.file)
            )
        }
        try FrameCorpusFileWriter.writeNew(
            FrameCorpusManifestCodec.encode(pendingManifest),
            to: outputDirectory.appendingPathComponent("manifest.pending-review.json")
        )
        print("Captured pending-review corpus at \(outputDirectory.path)")
    }

    @MainActor
    private static func captureOwnedWindow(_ applicationWindow: NSWindow) async throws -> CGImage {
        let processID = getpid()
        guard applicationWindow.windowNumber > 0 else {
            throw CommandError.ownedWindowUnavailable
        }
        let targetWindowID = CGWindowID(applicationWindow.windowNumber)
        let content = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        )
        guard FrameCorpusWindowIdentity.selectUniqueOwnedWindowID(
            candidates: content.windows.map { candidate in
                FrameCorpusWindowIdentityCandidate(
                    windowID: candidate.windowID,
                    ownerProcessID: candidate.owningApplication?.processID ?? -1,
                    isOnScreen: candidate.isOnScreen
                )
            },
            targetWindowID: targetWindowID,
            processID: processID
        ) == targetWindowID else {
            throw CommandError.ownedWindowUnavailable
        }
        let matchingWindows = content.windows.filter { candidate in
            candidate.windowID == targetWindowID &&
                candidate.owningApplication?.processID == processID &&
                candidate.isOnScreen
        }
        guard matchingWindows.count == 1, let window = matchingWindows.first else {
            throw CommandError.ownedWindowUnavailable
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        configuration.showsCursor = false
        configuration.captureResolution = .best
        configuration.ignoreShadowsSingleWindow = true
        guard configuration.width > 0, configuration.height > 0 else {
            throw CommandError.ownedWindowUnavailable
        }
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    }

    private static func approve(corpusDirectory: URL) throws {
        try FrameCorpusOutputGuard.requireOutsideRepository(
            corpusDirectory,
            repositoryDirectory: repositoryDirectory
        )
        let pendingURL = corpusDirectory.appendingPathComponent("manifest.pending-review.json")
        let approvedURL = corpusDirectory.appendingPathComponent("manifest.json")
        guard !FileManager.default.fileExists(atPath: approvedURL.path) else {
            throw CommandError.corpusAlreadyExists(approvedURL.path)
        }

        let pending = try FrameCorpusManifestCodec.decode(Data(contentsOf: pendingURL))
        let expectedFiles = Set(pending.fixtures.map(\.file))
            .union(["manifest.pending-review.json"])
        let actualFiles = Set(
            try FileManager.default.contentsOfDirectory(
                at: corpusDirectory,
                includingPropertiesForKeys: nil
            ).map(\.lastPathComponent)
        )
        guard expectedFiles == actualFiles else {
            throw CommandError.corpusContainsUnexpectedFiles
        }

        var fixtureData: [String: Data] = [:]
        for fixture in pending.fixtures {
            guard FrameCorpusPath.isSafeFixtureFile(fixture.file) else {
                throw FrameCorpusToolingError.invalidFixtureFile(fixture.file)
            }
            let data = try Data(
                contentsOf: corpusDirectory.appendingPathComponent(fixture.file)
            )
            guard let representation = NSBitmapImageRep(data: data),
                  let image = representation.cgImage,
                  image.width == fixture.pixelWidth,
                  image.height == fixture.pixelHeight
            else {
                throw CommandError.imageCreationFailed(fixture.file)
            }
            try verifyDecision(
                image: image,
                expected: fixture.expected,
                file: fixture.file
            )
            fixtureData[fixture.file] = data
        }
        let approved = try FrameCorpusReview.approve(
            pending,
            fixtureData: fixtureData,
            confirmedNoUserData: true
        )
        try FrameCorpusFileWriter.writeNew(
            FrameCorpusManifestCodec.encode(approved),
            to: approvedURL
        )
        print("Approved reviewed corpus at \(approvedURL.path)")
    }

    private static func verifyDecision(
        image: CGImage,
        expected: FrameCorpusExpectedDecision,
        file: String
    ) throws {
        guard let luminance = CaptureFrameSampler.sampledLuminance(from: image) else {
            throw CommandError.imageCreationFailed(file)
        }
        let decision = CaptureFrameEconomy.evaluate(
            luminance: luminance,
            width: CaptureFrameEconomy.sampleWidth,
            height: CaptureFrameEconomy.sampleHeight,
            context: CaptureFrameContext(
                bundleId: "one.recapsy.frame-corpus-capture",
                windowId: 1
            ),
            previous: nil
        )
        switch (expected, decision) {
        case (.lowInformation, .skip(.lowInformation)), (.accept, .accept):
            return
        default:
            throw CommandError.captureDecisionMismatch(file, String(describing: decision))
        }
    }

    @MainActor
    private static func drainRunLoop() {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }

    private static let repositoryDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .standardizedFileURL
        .resolvingSymlinksInPath()
}

@MainActor
private final class FrameCorpusView: NSView {
    var scene: FrameCorpusScene = .horizontalGradient

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        switch scene {
        case .horizontalGradient:
            drawGradient(angle: 0, startWhite: 0.94, endWhite: 0.72)
        case .verticalGradient:
            drawGradient(angle: 90, startWhite: 0.92, endWhite: 0.76)
        case .fictionalNotes:
            drawApplication(
                title: "Atlas Notes",
                section: "Example Project",
                lines: [
                    "Plan a fictional launch exercise",
                    "Review sample copy with the demo team",
                    "Archive the example checklist",
                ]
            )
        case .fictionalTasks:
            drawApplication(
                title: "Northstar Tasks",
                section: "Practice Board",
                lines: [
                    "09:30  Draft a sample agenda",
                    "11:00  Test the fictional workflow",
                    "14:15  Close the example task",
                ]
            )
        }
    }

    private func drawGradient(angle: CGFloat, startWhite: CGFloat, endWhite: CGFloat) {
        let gradient = NSGradient(
            starting: NSColor(white: startWhite, alpha: 1),
            ending: NSColor(white: endWhite, alpha: 1)
        )
        gradient?.draw(in: bounds, angle: angle)
    }

    private func drawApplication(title: String, section: String, lines: [String]) {
        NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
        bounds.fill()

        NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.17, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 48).fill()
        NSColor(calibratedWhite: 0.88, alpha: 1).setFill()
        NSRect(x: 0, y: 48, width: 108, height: bounds.height - 48).fill()
        NSColor.white.setFill()
        NSRect(x: 124, y: 64, width: 332, height: 182).fill()

        drawText(
            title,
            at: NSPoint(x: 18, y: 14),
            font: .boldSystemFont(ofSize: 16),
            color: .white
        )
        drawText(
            section,
            at: NSPoint(x: 142, y: 82),
            font: .boldSystemFont(ofSize: 15),
            color: NSColor(calibratedWhite: 0.18, alpha: 1)
        )
        for (index, line) in lines.enumerated() {
            let y = 120 + CGFloat(index * 34)
            NSColor(calibratedWhite: 0.87, alpha: 1).setFill()
            NSRect(x: 142, y: y + 23, width: 284, height: 1).fill()
            drawText(
                line,
                at: NSPoint(x: 142, y: y),
                font: .systemFont(ofSize: 13),
                color: NSColor(calibratedWhite: 0.32, alpha: 1)
            )
        }
        for (index, label) in ["Inbox", "Examples", "Archive"].enumerated() {
            drawText(
                label,
                at: NSPoint(x: 18, y: 70 + CGFloat(index * 32)),
                font: .systemFont(ofSize: 12),
                color: NSColor(calibratedWhite: 0.36, alpha: 1)
            )
        }
    }

    private func drawText(
        _ text: String,
        at point: NSPoint,
        font: NSFont,
        color: NSColor
    ) {
        NSString(string: text).draw(
            at: point,
            withAttributes: [
                .font: font,
                .foregroundColor: color,
            ]
        )
    }
}
