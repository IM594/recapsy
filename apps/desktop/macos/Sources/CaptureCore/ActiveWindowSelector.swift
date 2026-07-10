import Foundation

/// A screenshot-relevant snapshot of one on-screen window, reduced to the plain
/// scalar fields the selection rule needs. Keeping this free of any
/// ScreenCaptureKit type is what lets the selection logic live in dependency-free
/// `CaptureCore` and be unit tested without a display, a permission grant, or the
/// windowing system.
public struct CaptureWindowInfo: Equatable {
    public let windowId: Int
    public let ownerProcessId: Int
    public let layer: Int
    public let isOnScreen: Bool
    public let width: Double
    public let height: Double
    public let hasTitle: Bool

    public init(
        windowId: Int,
        ownerProcessId: Int,
        layer: Int,
        isOnScreen: Bool,
        width: Double,
        height: Double,
        hasTitle: Bool
    ) {
        self.windowId = windowId
        self.ownerProcessId = ownerProcessId
        self.layer = layer
        self.isOnScreen = isOnScreen
        self.width = width
        self.height = height
        self.hasTitle = hasTitle
    }
}

/// Pure rule that picks *which* window represents the foreground app, mirroring
/// the behaviour proven in the old capture plugin's `findWindows` + main-window
/// pick, but as a side-effect-free function over plain data.
///
/// The rule:
///   1. keep only windows that belong to the frontmost process, are on screen,
///      sit on the normal window layer (0), and are larger than a tiny 100×100
///      floor (drops shadows, status items, and off-screen scratch windows);
///   2. prefer titled windows over untitled ones (a titled window is almost
///      always the real document window, not an inspector/toolbar);
///   3. among the preferred pool pick the largest by area, breaking ties on the
///      lower window id so the choice is deterministic and testable.
///
/// Returns `nil` when the foreground app has no capturable window (e.g. the
/// Finder desktop with no open window); the caller treats that as "skip this
/// tick", never as an error.
public enum ActiveWindowSelector {
    public static let minimumWindowEdge: Double = 100

    public static func selectWindowId(
        windows: [CaptureWindowInfo],
        frontmostProcessId: Int
    ) -> Int? {
        let candidates = windows.filter { window in
            window.ownerProcessId == frontmostProcessId
                && window.isOnScreen
                && window.layer == 0
                && window.width > minimumWindowEdge
                && window.height > minimumWindowEdge
        }
        if candidates.isEmpty {
            return nil
        }

        let titled = candidates.filter { $0.hasTitle }
        let pool = titled.isEmpty ? candidates : titled

        return pool.max { lhs, rhs in
            let lhsArea = lhs.width * lhs.height
            let rhsArea = rhs.width * rhs.height
            if lhsArea != rhsArea {
                return lhsArea < rhsArea
            }
            // Deterministic tie-break: prefer the lower window id so equal-area
            // windows never make the pick depend on enumeration order.
            return lhs.windowId > rhs.windowId
        }?.windowId
    }
}
