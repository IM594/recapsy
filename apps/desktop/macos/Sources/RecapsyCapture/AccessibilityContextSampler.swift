import ApplicationServices
import CaptureCore
import Foundation

/// Reads only direct attributes from the selected process window and focused
/// element. It deliberately never asks Accessibility to enumerate children,
/// text, selections or page contents.
enum AccessibilityContextSampler {
    // ApplicationServices does not import the C constant into this Swift
    // overlay, but this is the documented direct AX window-number attribute.
    private static let windowNumberAttribute = "AXWindowNumber"

    static func sample(
        processId: Int32,
        application: CaptureApplicationPayload,
        windowId: Int
    ) -> CaptureSourceContext? {
        guard AXIsProcessTrusted() else {
            return nil
        }

        let process = AXUIElementCreateApplication(processId)
        let focusedWindow = elementAttribute(process, kAXFocusedWindowAttribute)
        let matchedWindow = matchingWindow(process, windowId: windowId)
        let selectedWindow = matchedWindow ?? focusedWindow
        guard let selectedWindow else {
            // A context sampled from another window of the same app would be
            // misleading. Keep the app-level result, but omit all AX context.
            return nil
        }
        // Some Chromium builds do not expose AXWindowNumber on the focused
        // window. The focused-window relation is still the safest available
        // context anchor in that case; when the number is exposed, retain the
        // strict selected-window match.
        if let selectedWindowNumber = integerAttribute(selectedWindow, windowNumberAttribute),
           selectedWindowNumber != windowId {
            return nil
        }
        // The focused element belongs to the focused window, not necessarily
        // the selected ScreenCaptureKit window. Only use it when no distinct
        // matching AX window was found.
        let focusedElement = matchedWindow == nil
            ? elementAttribute(process, kAXFocusedUIElementAttribute)
            : nil

        return CaptureSourceContext.make(
            application: application,
            document: documentAttribute(focusedElement) ?? documentAttribute(selectedWindow),
            url: urlAttribute(focusedElement, kAXURLAttribute)
                ?? urlAttribute(selectedWindow, kAXURLAttribute)
                ?? urlAttribute(selectedWindow, kAXDocumentAttribute),
            windowTitle: stringAttribute(selectedWindow, kAXTitleAttribute)
        )
    }

    private static func matchingWindow(_ process: AXUIElement, windowId: Int) -> AXUIElement? {
        guard
            let value = attributeValue(process, kAXWindowsAttribute),
            CFGetTypeID(value) == CFArrayGetTypeID()
        else {
            return nil
        }

        let windows = unsafeBitCast(value, to: CFArray.self)
        for index in 0..<CFArrayGetCount(windows) {
            guard
                let rawWindow = CFArrayGetValueAtIndex(windows, index),
                let window = Optional(unsafeBitCast(rawWindow, to: AXUIElement.self)),
                integerAttribute(window, windowNumberAttribute) == windowId
            else {
                continue
            }
            return window
        }
        return nil
    }

    private static func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard
            let value = attributeValue(element, attribute),
            CFGetTypeID(value) == AXUIElementGetTypeID()
        else {
            return nil
        }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private static func stringAttribute(_ element: AXUIElement?, _ attribute: String) -> String? {
        guard let element, let value = attributeValue(element, attribute) else {
            return nil
        }
        return value as? String
    }

    private static func urlAttribute(_ element: AXUIElement?, _ attribute: String) -> String? {
        guard let element, let value = attributeValue(element, attribute) else {
            return nil
        }
        if let url = value as? URL {
            return url.absoluteString
        }
        return value as? String
    }

    private static func documentAttribute(_ element: AXUIElement?) -> String? {
        guard let element, let value = attributeValue(element, kAXDocumentAttribute) else {
            return nil
        }
        if let url = value as? URL {
            return url.path
        }
        return value as? String
    }

    private static func integerAttribute(_ element: AXUIElement, _ attribute: String) -> Int? {
        guard let value = attributeValue(element, attribute), let number = value as? NSNumber else {
            return nil
        }
        return number.intValue
    }

    private static func attributeValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value
    }
}
