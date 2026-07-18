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
    private var policyGeneration: UInt64 = 0
    /// A written screenshot remains helper-owned until main acknowledges its
    /// capture id. The receipt file is the durable source of truth; this map
    /// only avoids rescanning the asset root for the current process.
    private var pendingCaptureAssets: [String: URL] = [:]
    // Accessed exclusively from stateQueue. Each tick snapshots it before
    // dispatching capture work, and a new value is committed only after the
    // policy generation fence admits the corresponding asset.
    private var lastAcceptedFrameFingerprint: CaptureFrameFingerprint?
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
            var policyPayload = payload["policy"] as? [String: Any] ?? [:]
            if let identity = payload["captureIdentity"] {
                policyPayload["captureIdentity"] = identity
            }
            guard let policy = ConfiguredPolicy.fromPayload(policyPayload) else {
                policyGeneration &+= 1
                configuredPolicy = nil
                state = .paused
                stopCaptureTimer()
                emitStatus(status: "paused", reason: "policy_unavailable")
                return
            }
            policyGeneration &+= 1
            configuredPolicy = policy
            if let interval = payload["captureIntervalMs"] as? Int, interval > 0 {
                captureIntervalMs = interval
            }
            emit(
                type: "helper.policy_applied",
                payload: PolicyAppliedPayload(policyHash: policy.hash, policyVersion: policy.version),
                correlationId: correlationId
            )
            recoverPendingReceipts(for: policy)
        case "permission.refresh":
            emitPermissionStatus()
        case "permission.request_screen_capture":
            _ = ScreenshotCapturer.requestScreenCaptureAccessIfNeeded()
            emitPermissionStatus()
        case "capture.start":
            guard
                let policy = configuredPolicy,
                !policy.sourcePolicy.paused,
                policy.workspaceId != nil,
                policy.deviceId != nil
            else {
                state = .paused
                stopCaptureTimer()
                emitStatus(status: "paused", reason: "policy_unavailable")
                return
            }
            state = .ready
            emitStatus(status: "ready")
            startCaptureTimer()
            replayPendingCaptureResults()
        case "capture.pause":
            policyGeneration &+= 1
            state = .paused
            let reason = payload["reason"] as? String
            emitStatus(status: "paused", reason: reason)
            stopCaptureTimer()
        case "capture.resume":
            guard
                let policy = configuredPolicy,
                !policy.sourcePolicy.paused,
                policy.workspaceId != nil,
                policy.deviceId != nil
            else {
                state = .paused
                stopCaptureTimer()
                emitStatus(status: "paused", reason: "policy_unavailable")
                return
            }
            policyGeneration &+= 1
            state = .ready
            let reason = payload["reason"] as? String
            emitStatus(status: "ready", reason: reason)
            startCaptureTimer()
            replayPendingCaptureResults()
        case "capture.ack":
            if let captureId = payload["captureId"] as? String {
                pendingCaptureAssets.removeValue(forKey: captureId)
                if let assetRoot {
                    CaptureReceiptStore.removeReceipt(assetRoot: assetRoot, captureId: captureId)
                }
            }
        case "capture.nack":
            if let captureId = payload["captureId"] as? String {
                let code = payload["code"] as? String
                if code != "backpressure" && code != "storage_unavailable" {
                    removePendingCapture(captureId: captureId)
                }
            }
        case "capture.flush":
            replayPendingCaptureResults()
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
        let previousFingerprint = lastAcceptedFrameFingerprint
        let startedPolicyGeneration = policyGeneration

        captureQueue.async { [weak self] in
            self?.performCapture(
                captureId: captureId,
                observedAt: observedAt,
                configuredPolicy: configuredPolicy,
                startedPolicyGeneration: startedPolicyGeneration,
                previousFingerprint: previousFingerprint
            )
        }
    }

    /// Runs on `captureQueue`. Emits exactly one of `capture.result` /
    /// `capture.error` per tick.
    private func performCapture(
        captureId: String,
        observedAt: String,
        configuredPolicy: ConfiguredPolicy,
        startedPolicyGeneration: UInt64,
        previousFingerprint: CaptureFrameFingerprint?
    ) {
        var preparedCapture: PreparedCapture?
        defer {
            stateQueue.async { [weak self] in
                guard let self else { return }
                if let preparedCapture {
                    self.finalizePreparedCapture(
                        preparedCapture,
                        startedPolicyHash: configuredPolicy.hash,
                        startedPolicyGeneration: startedPolicyGeneration
                    )
                }
                self.captureInFlight = false
            }
        }

        guard assetRoot != nil else {
            emitCaptureError(
                captureId: captureId,
                code: "asset_write_failed",
                message: "Capture asset root is not configured."
            )
            return
        }

        let encoded: EncodedScreenshot
        do {
            encoded = try ScreenshotCapturer.capture(
                policy: configuredPolicy.sourcePolicy,
                previousFingerprint: previousFingerprint
            )
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
                    reason: .policyDenied,
                    observedAt: observedAt
                )
            )
            return
        } catch ScreenshotError.blankFrame {
            emit(
                type: "capture.skipped",
                payload: CaptureSkippedPayload(
                    captureId: captureId,
                    reason: .blank,
                    observedAt: observedAt
                )
            )
            return
        } catch ScreenshotError.lowInformationFrame {
            emit(
                type: "capture.skipped",
                payload: CaptureSkippedPayload(
                    captureId: captureId,
                    reason: .lowInformation,
                    observedAt: observedAt
                )
            )
            return
        } catch ScreenshotError.duplicateFrame {
            emit(
                type: "capture.skipped",
                payload: CaptureSkippedPayload(
                    captureId: captureId,
                    reason: .duplicate,
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

        guard
            let workspaceId = configuredPolicy.workspaceId,
            let deviceId = configuredPolicy.deviceId
        else {
            emitCaptureError(
                captureId: captureId,
                code: "asset_write_failed",
                message: "Capture identity is unavailable."
            )
            return
        }
        preparedCapture = PreparedCapture(
            captureId: captureId,
            observedAt: observedAt,
            receipt: CaptureReceipt(
                workspaceId: workspaceId,
                deviceId: deviceId,
                payload: payload,
                screenshotHash: hash,
                screenshotSizeBytes: encoded.imageData.count
            ),
            imageData: encoded.imageData,
            frameFingerprint: encoded.frameFingerprint
        )
    }

    /// Runs on stateQueue after capture/encoding has completed. `helper.configure`
    /// also runs on stateQueue, so a matching ACK is always ordered before this
    /// fence when the new policy was activated first. `captureInFlight` remains
    /// true through cleanup, preventing a new generation from reusing this
    /// capture id or staging path before stale work has been discarded.
    private func finalizePreparedCapture(
        _ prepared: PreparedCapture,
        startedPolicyHash: String,
        startedPolicyGeneration: UInt64
    ) {
        guard let assetRoot else {
            emitCaptureError(
                captureId: prepared.captureId,
                code: "asset_write_failed",
                message: "Capture asset root is not configured."
            )
            return
        }

        do {
            let outcome = try CaptureCommitCoordinator.finalize(
                startedPolicyHash: startedPolicyHash,
                currentPolicyHash: configuredPolicy?.hash,
                startedPolicyGeneration: startedPolicyGeneration,
                currentPolicyGeneration: policyGeneration,
                receipt: prepared.receipt,
                imageData: prepared.imageData,
                assetRoot: assetRoot,
                captureId: prepared.captureId
            )
            switch outcome {
            case let .committed(payload, directory):
                lastAcceptedFrameFingerprint = prepared.frameFingerprint
                // Register ownership before emitting the result. A fast NACK
                // therefore cannot observe an untracked committed directory.
                pendingCaptureAssets[prepared.captureId] = directory
                emit(type: "capture.result", payload: payload)
            case let .skipped(reason):
                emit(
                    type: "capture.skipped",
                    payload: CaptureSkippedPayload(
                        captureId: prepared.captureId,
                        reason: reason,
                        observedAt: prepared.observedAt
                    )
                )
            }
        } catch {
            emitCaptureError(
                captureId: prepared.captureId,
                code: "asset_write_failed",
                message: "Capture receipt could not be committed."
            )
        }
    }

    /// Replays receipts only after Electron has supplied a verified identity.
    /// A receipt from another workspace/device is left untouched for the
    /// matching profile rather than being attached to the current session.
    private func recoverPendingReceipts(for policy: ConfiguredPolicy) {
        guard let assetRoot else {
            return
        }
        guard let workspaceId = policy.workspaceId, let deviceId = policy.deviceId else {
            return
        }

        let receiptIds = CaptureReceiptStore.listCaptureIds(assetRoot: assetRoot)
        for captureId in receiptIds {
            let receipt: CaptureReceipt
            do {
                receipt = try CaptureReceiptStore.read(assetRoot: assetRoot, captureId: captureId)
            } catch {
                CaptureReceiptStore.removeCapture(assetRoot: assetRoot, captureId: captureId)
                emitCaptureError(
                    captureId: captureId,
                    code: "asset_write_failed",
                    message: "Pending capture receipt is invalid."
                )
                continue
            }
            guard receipt.workspaceId == workspaceId, receipt.deviceId == deviceId else {
                continue
            }
            guard let payload = try? CaptureReceiptStore.recover(receipt, assetRoot: assetRoot) else {
                CaptureReceiptStore.removeCapture(assetRoot: assetRoot, captureId: captureId)
                emitCaptureError(
                    captureId: captureId,
                    code: "asset_write_failed",
                    message: "Pending capture could not be recovered."
                )
                continue
            }
            pendingCaptureAssets[captureId] = CaptureAsset.captureDirectoryURL(
                assetRoot: assetRoot,
                captureId: captureId
            )
            emit(type: "capture.result", payload: payload)
        }
    }

    private func replayPendingCaptureResults() {
        guard let assetRoot else {
            return
        }
        for captureId in pendingCaptureAssets.keys.sorted() {
            guard let receipt = try? CaptureReceiptStore.read(assetRoot: assetRoot, captureId: captureId),
                  let payload = try? CaptureReceiptStore.recover(receipt, assetRoot: assetRoot)
            else {
                continue
            }
            emit(type: "capture.result", payload: payload)
        }
    }

    private func removePendingCapture(captureId: String) {
        let directory = pendingCaptureAssets.removeValue(forKey: captureId)
        guard let assetRoot else {
            return
        }
        CaptureReceiptStore.removeReceipt(assetRoot: assetRoot, captureId: captureId)
        guard let directory else {
            return
        }
        captureQueue.async {
            try? FileManager.default.removeItem(at: directory)
        }
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
    private struct PreparedCapture {
        let captureId: String
        let observedAt: String
        let receipt: CaptureReceipt
        let imageData: Data
        let frameFingerprint: CaptureFrameFingerprint
    }

    private struct ConfiguredPolicy {
        let hash: String
        let version: String
        let workspaceId: String?
        let deviceId: String?
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
            var canonicalRules: [CapturePolicyCanonicalRule] = []
            for rawRule in rawRules {
                guard
                    let id = rawRule["id"] as? String,
                    !id.isEmpty,
                    CapturePolicyCanonicalRule.isSupportedText(id),
                    let kind = rawRule["kind"] as? String,
                    Self.isKind(kind),
                    let scope = rawRule["scope"] as? String,
                    Self.isScope(scope),
                    let pattern = rawRule["pattern"] as? String,
                    !pattern.isEmpty,
                    CapturePolicyCanonicalRule.isSupportedText(pattern),
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
                canonicalRules.append(
                    CapturePolicyCanonicalRule(
                        action: actionRaw,
                        enabled: enabled,
                        id: id,
                        kind: kind,
                        pattern: pattern,
                        scope: scope
                    )
                )
            }

            let canonical = CapturePolicyCanonicalSnapshot(
                defaultAction: defaultActionRaw,
                paused: paused,
                rules: canonicalRules,
                version: version
            )
            guard let computedHash = try? canonical.policyHash(), computedHash == hash else {
                return nil
            }

            let identity = payload["captureIdentity"] as? NSDictionary
            let workspaceId = identity?["workspaceId"] as? String
            let deviceId = identity?["deviceId"] as? String

            return ConfiguredPolicy(
                hash: hash,
                version: version,
                workspaceId: workspaceId?.isEmpty == false ? workspaceId : nil,
                deviceId: deviceId?.isEmpty == false ? deviceId : nil,
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
