import Foundation
import ApplicationServices
import CaptureCore

/// Thread-safe stdout line emitter. All protocol output funnels through here so
/// concurrent producers (heartbeat timer, capture worker, command handler)
/// never interleave partial NDJSON lines.
final class LineEmitter {
    private let queue = DispatchQueue(label: "one.recapsy.capture.stdout")

    func emit(_ line: String) {
        queue.async {
            guard let data = line.data(using: .utf8) else {
                return
            }
            try? FileHandle.standardOutput.write(contentsOf: data)
        }
    }

    /// Serial-queue barrier: returns only once every previously enqueued write
    /// has run. Used before process exit so the final `helper.exiting` line is
    /// guaranteed on the wire before `exit(2)`.
    func flush() {
        queue.sync {}
    }
}

/// The capture process state machine and I/O orchestration (ADR 0009 §进程生命周期).
///
/// All mutable state lives behind `stateQueue` (serial); the heavy, blocking
/// ScreenCaptureKit + WebP work runs on `captureQueue` so a slow capture never
/// stalls command handling or heartbeats. Reentrancy is guarded by
/// `captureInFlight`, so overlapping timer ticks collapse to a single in-flight
/// capture.
final class CaptureEngine {
    private enum State: String {
        case starting
        case ready
        case paused
        case stopping
    }

    static let helperVersion = "recapsy-capture/0.1.0"
    private static let defaultCaptureIntervalMs = 3000
    private static let heartbeatIntervalMs = 1000

    private let emitter: LineEmitter
    private let assetRoot: URL?

    private let stateQueue = DispatchQueue(label: "one.recapsy.capture.state")
    private let captureQueue = DispatchQueue(label: "one.recapsy.capture.work", qos: .userInitiated)
    // `emit` is reached from both `stateQueue` (heartbeat/status/command replies)
    // and `captureQueue` (inside `performCapture`), so the message-sequence bump
    // and envelope construction must be serialized independently of either queue.
    private let emitLock = NSLock()

    private var state: State = .starting
    private var messageSequence = 0
    private var heartbeatSequence = 0
    private var captureCounter = 0
    private var configuredPolicy: ConfiguredPolicy?
    private var captureIntervalMs = CaptureEngine.defaultCaptureIntervalMs
    private var captureInFlight = false
    // Edge-tracks the "no capturable active window" condition so a long stretch
    // of windowless ticks logs one line on entry and one on recovery, instead of
    // dribbling a line every tick. Only ever touched inside `performCapture`,
    // which `captureInFlight` keeps single-in-flight on `captureQueue`.
    private var skippingNoActiveWindow = false

    private var captureTimer: DispatchSourceTimer?
    private var heartbeatTimer: DispatchSourceTimer?

    init(emitter: LineEmitter, assetRoot: URL?) {
        self.emitter = emitter
        self.assetRoot = assetRoot
    }

    // MARK: - Lifecycle

    func start() {
        stateQueue.async { [weak self] in
            guard let self else { return }
            self.emitHello()
            self.emitPermissionStatus()
            self.startHeartbeatTimer()
        }
    }

    /// Called from the stdin reader on parent-pipe EOF (parent gone / SIGKILL).
    func handleStdinEOF() {
        stateQueue.async { [weak self] in
            guard let self else { return }
            self.emitExiting(reason: "process_crashed", code: 0)
            self.terminate(code: 0)
        }
    }

    // MARK: - Inbound commands

    func handleLine(_ line: String) {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let envelope = object as? [String: Any],
            envelope["protocolVersion"] as? String == HelperProtocol.version,
            let type = envelope["type"] as? String
        else {
            // Malformed / foreign input is ignored, never fatal — mirrors the
            // reference dev helper's tolerance.
            return
        }
        let payload = envelope["payload"] as? [String: Any] ?? [:]
        let correlationId = envelope["correlationId"] as? String

        stateQueue.async { [weak self] in
            self?.dispatchCommand(type: type, payload: payload, correlationId: correlationId)
        }
    }

    private func dispatchCommand(type: String, payload: [String: Any], correlationId: String?) {
        switch type {
        case "helper.configure":
            guard let policy = ConfiguredPolicy.fromPayload(payload["policy"] as? [String: Any]) else {
                configuredPolicy = nil
                state = .paused
                stopCaptureTimer()
                emitStatus(status: "paused", reason: "policy_unavailable")
                return
            }
            configuredPolicy = policy
            if let interval = payload["captureIntervalMs"] as? Int, interval > 0 {
                captureIntervalMs = interval
            }
            emit(
                type: "helper.policy_applied",
                payload: PolicyAppliedPayload(policyHash: policy.hash, policyVersion: policy.version),
                correlationId: correlationId
            )
        case "permission.refresh":
            emitPermissionStatus()
        case "permission.request_screen_capture":
            _ = ScreenshotCapturer.requestScreenCaptureAccessIfNeeded()
            emitPermissionStatus()
        case "capture.start":
            guard let policy = configuredPolicy, !policy.sourcePolicy.paused else {
                state = .paused
                stopCaptureTimer()
                emitStatus(status: "paused", reason: "policy_unavailable")
                return
            }
            state = .ready
            emitStatus(status: "ready")
            startCaptureTimer()
        case "capture.pause":
            state = .paused
            let reason = payload["reason"] as? String
            emitStatus(status: "paused", reason: reason)
            stopCaptureTimer()
        case "capture.resume":
            guard let policy = configuredPolicy, !policy.sourcePolicy.paused else {
                state = .paused
                stopCaptureTimer()
                emitStatus(status: "paused", reason: "policy_unavailable")
                return
            }
            state = .ready
            let reason = payload["reason"] as? String
            emitStatus(status: "ready", reason: reason)
            startCaptureTimer()
        case "capture.flush", "capture.ack", "capture.nack":
            // 1B keeps no unacknowledged capture buffer, so there is nothing to
            // flush or reconcile. A later increment with on-disk manifests would
            // act here.
            break
        case "helper.shutdown":
            state = .stopping
            stopCaptureTimer()
            stopHeartbeatTimer()
            emitExiting(reason: "shutdown_requested", code: 0)
            terminate(code: 0)
        default:
            break
        }
    }

    // MARK: - Timers

    private func startCaptureTimer() {
        stopCaptureTimer()
        let timer = DispatchSource.makeTimerSource(queue: stateQueue)
        let intervalMs = captureIntervalMs
        timer.schedule(
            deadline: .now(),
            repeating: .milliseconds(intervalMs)
        )
        timer.setEventHandler { [weak self] in
            self?.onCaptureTick()
        }
        captureTimer = timer
        timer.resume()
    }

    private func stopCaptureTimer() {
        captureTimer?.cancel()
        captureTimer = nil
    }

    private func startHeartbeatTimer() {
        stopHeartbeatTimer()
        let timer = DispatchSource.makeTimerSource(queue: stateQueue)
        timer.schedule(
            deadline: .now() + .milliseconds(CaptureEngine.heartbeatIntervalMs),
            repeating: .milliseconds(CaptureEngine.heartbeatIntervalMs)
        )
        timer.setEventHandler { [weak self] in
            self?.emitHeartbeat()
        }
        heartbeatTimer = timer
        timer.resume()
    }

    private func stopHeartbeatTimer() {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
    }

    // MARK: - Capture orchestration (state queue)

    private func onCaptureTick() {
        guard state == .ready, let configuredPolicy, !captureInFlight else {
            return
        }
        captureInFlight = true
        captureCounter += 1
        let captureId = CaptureIdGenerator.make(
            epochMilliseconds: Int64(Date().timeIntervalSince1970 * 1000),
            counter: captureCounter
        )
        let observedAt = CaptureEngine.iso8601(Date())
        let root = assetRoot

        captureQueue.async { [weak self] in
            self?.performCapture(
                captureId: captureId,
                observedAt: observedAt,
                assetRoot: root,
                configuredPolicy: configuredPolicy
            )
            self?.stateQueue.async {
                self?.captureInFlight = false
            }
        }
    }

    /// Runs on `captureQueue`. Emits exactly one of `capture.result` /
    /// `capture.error` per tick.
    private func performCapture(
        captureId: String,
        observedAt: String,
        assetRoot: URL?,
        configuredPolicy: ConfiguredPolicy
    ) {
        guard let assetRoot else {
            emitCaptureError(
                captureId: captureId,
                code: "asset_write_failed",
                message: "Capture asset root is not configured."
            )
            return
        }

        let encoded: EncodedScreenshot
        do {
            encoded = try ScreenshotCapturer.capture(policy: configuredPolicy.sourcePolicy)
        } catch ScreenshotError.permissionMissing {
            emitPermissionStatus()
            emitCaptureError(
                captureId: captureId,
                code: "permission_missing",
                message: "Screen recording permission is required."
            )
            return
        } catch ScreenshotError.noActiveWindow {
            // No capturable foreground window this tick (e.g. Finder desktop
            // with nothing open). Emit nothing — no result, no error — and let
            // the next interval try again. Log a single stderr breadcrumb only on
            // entering the windowless state, so a long windowless stretch does
            // not dribble a line every tick. No protocol reason code is invented.
            if !skippingNoActiveWindow {
                skippingNoActiveWindow = true
                FileHandle.standardError.write(
                    Data("capture skipped: no active window (since \(captureId))\n".utf8)
                )
            }
            return
        } catch ScreenshotError.policyDenied {
            emit(
                type: "capture.skipped",
                payload: CaptureSkippedPayload(
                    captureId: captureId,
                    reason: "policy_denied",
                    observedAt: observedAt
                )
            )
            return
        } catch ScreenshotError.encodeFailed {
            emitCaptureError(
                captureId: captureId,
                code: "capture_failed",
                message: "Screenshot could not be encoded."
            )
            return
        } catch {
            emitCaptureError(
                captureId: captureId,
                code: "capture_failed",
                message: "Screenshot capture failed."
            )
            return
        }

        // A capturable window is back: close the windowless breadcrumb opened
        // above with one recovery line (edge-triggered, matching entry).
        if skippingNoActiveWindow {
            skippingNoActiveWindow = false
            FileHandle.standardError.write(
                Data("capture resumed: active window captured (\(captureId))\n".utf8)
            )
        }

        let fileURL = CaptureAsset.screenshotFileURL(assetRoot: assetRoot, captureId: captureId)
        let directory = CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try encoded.imageData.write(to: fileURL, options: .atomic)
        } catch {
            emitCaptureError(
                captureId: captureId,
                code: "asset_write_failed",
                message: "Screenshot bytes could not be written."
            )
            return
        }

        let relativeKey = CaptureAsset.screenshotRelativeKey(captureId: captureId)
        let hash = CaptureAsset.contentHash(for: encoded.imageData)

        let asset = CaptureAssetPayload(
            role: "screenshot",
            ref: relativeKey,
            hash: hash,
            mimeType: CaptureAsset.screenshotMimeType,
            sizeBytes: encoded.imageData.count
        )
        // Manifest is a synthetic relative ref only: the main-process sync layer
        // drops the `manifest` role (never reads its bytes), so 1B does not
        // write a manifest file. The ref is still relative (never absolute /
        // file://) to satisfy the opaque-ref contract.
        let manifest = CaptureAssetPayload(
            role: "manifest",
            ref: "\(captureId)/manifest.json",
            hash: hash,
            mimeType: "application/json",
            sizeBytes: 0
        )
        let context = CaptureContextPayload(
            app: encoded.application,
            observedAt: observedAt,
            policy: CapturePolicyPayload(
                version: configuredPolicy.version,
                decision: encoded.policyDecision.rawValue
            )
        )
        let payload = CaptureResultPayload(
            captureId: captureId,
            observedAt: observedAt,
            manifest: manifest,
            assets: [asset],
            context: context
        )
        emit(type: "capture.result", payload: payload)
    }

    // MARK: - Emission (state queue)

    private func emitHello() {
        let payload = HelloPayload(
            helperVersion: CaptureEngine.helperVersion,
            pid: Int(getpid()),
            capabilities: HelperCapabilities(capture: true, permissions: true, mock: false)
        )
        emit(type: "helper.hello", payload: payload)
    }

    private func emitStatus(status: String, reason: String? = nil) {
        emit(type: "helper.status", payload: StatusPayload(status: status, reason: reason))
    }

    private func emitPermissionStatus() {
        let screenCapture = ScreenshotCapturer.isScreenCaptureGranted ? "granted" : "not_determined"
        // Probe only — never call AXIsProcessTrustedWithOptions with prompt.
        // Disclaimed capture processes are not auto-added to Accessibility; the
        // desktop shell must open System Settings and guide manual enablement.
        let accessibility = AXIsProcessTrusted() ? "granted" : "not_determined"
        let payload = PermissionStatusPayload(
            screenCapture: screenCapture,
            accessibility: accessibility,
            observedAt: CaptureEngine.iso8601(Date())
        )
        emit(type: "permission.status", payload: payload)
    }

    private func emitHeartbeat() {
        heartbeatSequence += 1
        let status: String
        switch state {
        case .starting: status = "starting"
        case .ready: status = "ready"
        case .paused: status = "paused"
        case .stopping: status = "stopping"
        }
        emit(
            type: "helper.heartbeat",
            payload: HeartbeatPayload(sequence: heartbeatSequence, status: status)
        )
    }

    private func emitExiting(reason: String, code: Int) {
        emit(type: "helper.exiting", payload: ExitingPayload(reason: reason, code: code))
    }

    private func emitCaptureError(captureId: String?, code: String, message: String) {
        emit(
            type: "capture.error",
            payload: CaptureErrorPayload(captureId: captureId, code: code, message: message)
        )
    }

    private func emit<Payload: Encodable>(
        type: String,
        payload: Payload,
        correlationId: String? = nil
    ) {
        emitLock.lock()
        messageSequence += 1
        let sequence = messageSequence
        emitLock.unlock()

        let envelope = HelperEnvelope(
            messageId: "cap-msg-\(sequence)",
            correlationId: correlationId,
            sentAt: CaptureEngine.iso8601(Date()),
            type: type,
            payload: payload
        )
        guard let line = try? encodeEnvelopeLine(envelope) else {
            return
        }
        emitter.emit(line)
    }

    /// Canonical policy payload received from Electron. The helper keeps the
    /// full executable rule set even though the first source-only gate only
    /// evaluates window owner identity; later capture gates must never need to
    /// re-fetch or reconstruct policy data from a summary.
    private struct ConfiguredPolicy {
        let hash: String
        let version: String
        let sourcePolicy: CaptureSourcePolicy

        static func fromPayload(_ payload: [String: Any]?) -> ConfiguredPolicy? {
            guard
                let payload,
                let hash = payload["policyHash"] as? String,
                hash.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil,
                let version = payload["version"] as? String,
                !version.isEmpty,
                let paused = payload["paused"] as? Bool,
                let defaultActionRaw = payload["defaultAction"] as? String,
                let defaultAction = CaptureSourcePolicyAction(rawValue: defaultActionRaw),
                let rawRules = payload["rules"] as? [[String: Any]]
            else {
                return nil
            }

            var rules: [CaptureSourcePolicyRule] = []
            for rawRule in rawRules {
                guard
                    let id = rawRule["id"] as? String,
                    !id.isEmpty,
                    let kind = rawRule["kind"] as? String,
                    Self.isKind(kind),
                    let scope = rawRule["scope"] as? String,
                    Self.isScope(scope),
                    let pattern = rawRule["pattern"] as? String,
                    !pattern.isEmpty,
                    let actionRaw = rawRule["action"] as? String,
                    let action = CaptureSourcePolicyAction(rawValue: actionRaw),
                    let enabled = rawRule["enabled"] as? Bool
                else {
                    return nil
                }
                rules.append(
                    CaptureSourcePolicyRule(
                        id: id,
                        kind: kind,
                        scope: scope,
                        pattern: pattern,
                        action: action,
                        enabled: enabled
                    )
                )
            }

            return ConfiguredPolicy(
                hash: hash,
                version: version,
                sourcePolicy: CaptureSourcePolicy(
                    version: version,
                    paused: paused,
                    defaultAction: defaultAction,
                    rules: rules
                )
            )
        }

        private static func isKind(_ value: String) -> Bool {
            return ["pause", "app_name", "bundle_id", "domain", "document_path", "window_title"].contains(value)
        }

        private static func isScope(_ value: String) -> Bool {
            return ["hard", "local_user", "workspace_default"].contains(value)
        }
    }

    private func terminate(code: Int32) {
        // Block until all queued output (including the final helper.exiting
        // line) has been written, then exit deterministically.
        emitter.flush()
        exit(code)
    }

    // MARK: - Time

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func iso8601(_ date: Date) -> String {
        return isoFormatter.string(from: date)
    }
}
