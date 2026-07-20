import ApplicationServices
import CaptureCore
import Foundation

/// Reads only direct attributes from the active process's focused window and
/// focused element. It deliberately never asks Accessibility to enumerate
/// children, text, selections or page contents.
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
        guard
            let focusedWindow = elementAttribute(process, kAXFocusedWindowAttribute),
            integerAttribute(focusedWindow, windowNumberAttribute) == windowId
        else {
            // A context sampled from another window of the same app would be
            // misleading. Keep the app-level result, but omit all AX context.
            return nil
        }
        let focusedElement = elementAttribute(process, kAXFocusedUIElementAttribute)

        return CaptureSourceContext.make(
            application: application,
            document: documentAttribute(focusedWindow),
            url: urlAttribute(focusedElement, kAXURLAttribute)
                ?? urlAttribute(focusedWindow, kAXURLAttribute),
            windowTitle: stringAttribute(focusedWindow, kAXTitleAttribute)
        )
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
