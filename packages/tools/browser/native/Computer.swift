import AppKit
import ApplicationServices
import ScreenCaptureKit
import CryptoKit

// A deliberately small native actuator. No AppleScript, shell, browser protocol,
// JavaScript, clipboard access, or credentials. JSON arrives over stdin, not argv.
struct Refusal: Error { let message: String }
func refuse(_ message: String) throws -> Never { throw Refusal(message: message) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func rect(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func bounds(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
func secure(_ e: AXUIElement) -> Bool {
    string(e, kAXSubroleAttribute) == kAXSecureTextFieldSubrole || string(e, kAXRoleAttribute) == "AXSecureTextField"
}
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func fingerprint(_ object: [String: Any]) -> String {
    digest((try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data())
}
struct Node { let e: AXUIElement; let data: [String: Any] }
struct State {
    let app: NSRunningApplication; let window: AXUIElement; let frame: CGRect
    let title: String; let nodes: [Node]; let identity: String; let windowID: CGWindowID
}
func state(_ appId: String) throws -> State {
    guard AXIsProcessTrusted() else { try refuse("Allow Accessibility for Buddi's computer helper in macOS System Settings.") }
    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == appId else {
        try refuse("The selected app is no longer in front. Take over, bring it forward, resume and observe. No input was sent.")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    // Enable Chromium's macOS accessibility tree through the OS AX interface.
    // Unsupported attributes in other applications are simply ignored.
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    guard let window = element(attr(root, kAXFocusedWindowAttribute)), let frame = rect(window), frame.width > 1, frame.height > 1 else { try refuse("The selected app has no accessible focused window.") }
    var nodes: [Node] = []; var visited = 0
    func walk(_ e: AXUIElement, _ path: [Int], _ depth: Int) {
        if depth > 35 || visited >= 3000 || nodes.count >= 500 { return }; visited += 1
        let role = string(e, kAXRoleAttribute); let isSecure = secure(e)
        let title = string(e, kAXTitleAttribute)
        let description = string(e, kAXDescriptionAttribute)
        let value = isSecure ? "" : (attr(e, kAXValueAttribute) as? String ?? "")
        let name = String((!title.isEmpty ? title : !description.isEmpty ? description : value).prefix(300))
        if let r = rect(e), r.intersects(frame), r.width > 0, r.height > 0 {
            let data: [String: Any] = ["path": path, "role": role, "name": name,
                "value": String(value.prefix(2000)), "secure": isSecure,
                "enabled": (attr(e, kAXEnabledAttribute) as? Bool) ?? true,
                "bounds": bounds(r.offsetBy(dx: -frame.minX, dy: -frame.minY))]
            nodes.append(Node(e: e, data: data))
        }
        if isSecure { return }
        for (i, child) in ((attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []).enumerated() { walk(child, path + [i], depth + 1) }
    }
    walk(window, [], 0)
    let title = string(window, kAXTitleAttribute)
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter { info in
        guard (info[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier), (info[kCGWindowLayer as String] as? Int) == 0,
              let value = info[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: value as CFDictionary) else { return false }
        return abs(r.minX - frame.minX) < 3 && abs(r.minY - frame.minY) < 3 && abs(r.width - frame.width) < 3 && abs(r.height - frame.height) < 3
    }
    guard windows.count == 1, let number = windows.first?[kCGWindowNumber as String] as? UInt32 else { try refuse("Cannot uniquely identify the focused native window") }
    let identity = fingerprint(["pid": Int(app.processIdentifier), "window": number, "title": title, "frame": bounds(frame)])
    return State(app: app, window: window, frame: frame, title: title, nodes: nodes, identity: identity, windowID: number)
}
@available(macOS 14.0, *)
func capture(_ s: State) async throws -> (Data, Int, Int) {
    guard CGPreflightScreenCaptureAccess() else { try refuse("Allow Screen Recording for Buddi's computer helper in macOS System Settings.") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let matches = content.windows.filter { $0.windowID == s.windowID && $0.owningApplication?.processID == s.app.processIdentifier && abs($0.frame.minX - s.frame.minX) < 3 && abs($0.frame.minY - s.frame.minY) < 3 && abs($0.frame.width - s.frame.width) < 3 && abs($0.frame.height - s.frame.height) < 3 }
    guard matches.count == 1, let window = matches.first else { try refuse("Cannot uniquely identify the selected window for capture.") }
    let config = SCStreamConfiguration(); config.width = Int(s.frame.width); config.height = Int(s.frame.height)
    config.showsCursor = false; config.ignoreShadowsSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
    guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { try refuse("Cannot prepare screenshot") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    // Redact secure accessibility fields before exporting any pixels.
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    for n in s.nodes where n.data["secure"] as? Bool == true {
        if let r = rect(n.e) { context.fill(CGRect(x: r.minX - s.frame.minX, y: s.frame.height - (r.maxY - s.frame.minY), width: r.width, height: r.height)) }
    }
    guard let masked = context.makeImage(), let jpeg = NSBitmapImageRep(cgImage: masked).representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { try refuse("Cannot encode screenshot") }
    return (jpeg, image.width, image.height)
}
func focusCheck(_ app: NSRunningApplication, _ window: AXUIElement) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          let win = element(attr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute)), CFEqual(win, window) else { try refuse("Focus changed. Observe again before sending input.") }
}
func focusCheck(_ s: State) throws { try focusCheck(s.app, s.window) }
func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { try refuse("Cannot create keyboard event") }
    down.flags = flags; up.flags = flags
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
}
// The chunked keyboard write act/fill types through: the focused element of the
// frontmost app receives it, and the frontmost app and its focused window are
// re-checked per chunk.
func typeInto(_ text: String, _ app: NSRunningApplication, _ window: AXUIElement) throws {
    let units = Array(text.utf16)
    for offset in stride(from: 0, to: units.count, by: 20) {
        try focusCheck(app, window)
        let chunk = Array(units[offset..<min(offset + 20, units.count)])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { try refuse("Cannot create text input") }
        chunk.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress!)
        }
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }
}
func typeText(_ text: String, _ s: State) throws {
    try typeInto(text, s.app, s.window)
    if let focused = element(attr(AXUIElementCreateApplication(s.app.processIdentifier), kAXFocusedUIElementAttribute)), secure(focused) { try refuse("A password field is focused. Use human takeover.") }
}
@discardableResult func checkPoint(_ point: CGPoint, _ s: State) throws -> AXUIElement {
    try focusCheck(s)
    guard s.frame.contains(point) else { try refuse("Point is outside the selected window") }
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let hit else { try refuse("Cannot verify what is under the pointer") }
    var pid: pid_t = 0; AXUIElementGetPid(hit, &pid)
    guard pid == s.app.processIdentifier, !secure(hit), let hitWindow = element(attr(hit, kAXWindowAttribute)), CFEqual(hitWindow, s.window) else { try refuse("Point is obscured, secure, or outside the selected window") }
    var ancestor: AXUIElement? = hit
    for _ in 0..<20 {
        guard let current = ancestor else { break }
        if secure(current) { try refuse("Password fields require human takeover") }
        if CFEqual(current, s.window) { break }
        ancestor = element(attr(current, kAXParentAttribute))
    }
    return hit
}
func checkTarget(_ target: AXUIElement, _ s: State) throws {
    guard let r = rect(target) else { try refuse("Target has no visible bounds") }
    let visible = r.intersection(s.frame)
    guard !visible.isNull && visible.width > 0 && visible.height > 0 else { try refuse("Target is outside the selected window") }
    var hit: AXUIElement? = try checkPoint(CGPoint(x: visible.midX, y: visible.midY), s)
    for _ in 0..<25 {
        guard let current = hit else { break }
        if CFEqual(current, target) { return }
        hit = element(attr(current, kAXParentAttribute))
    }
    try refuse("The observed target is obscured or no longer hit-testable. Observe again.")
}
func click(_ point: CGPoint, _ s: State) throws {
    try checkPoint(point, s)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { try refuse("Cannot create mouse event") }
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
}
@main struct Computer {
    @MainActor static func main() async {
        var dispatched = false
        do {
            guard let request = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any], let operation = request["operation"] as? String else { try refuse("Invalid request") }
            var result: [String: Any] = [:]
            if operation == "permissions" {
                let prompt = request["prompt"] as? Bool == true
                let ax = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
                var screen = CGPreflightScreenCaptureAccess()
                if prompt && !screen { screen = CGRequestScreenCaptureAccess() }
                result = ["accessibility": ax, "screenRecording": screen, "supported": true]
            } else if operation == "focused" {
                // The bundle id of the app the owner is using right now, read with
                // no accessibility and no input: what `secret.type` binds to is what
                // macOS answers here, never what an agent claimed (owner-secrets §8).
                result = ["appId": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""]
            } else {
                guard #available(macOS 14.0, *) else { try refuse("Computer control requires macOS 14 or later") }
                guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { try refuse("Computer control needs macOS Accessibility and Screen Recording permission. Use Check permissions in the dashboard. No browser automation fallback was used.") }
                guard let appId = request["appId"] as? String else { try refuse("Missing selected application") }
                // A Chromium profile directory, validated to a plain name. Passed as
                // Chrome's own launch argument; the running instance honours it.
                let profile = request["profile"] as? String
                if let profile, profile.isEmpty || profile.count > 100 || profile.rangeOfCharacter(from: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-").inverted) != nil { try refuse("Invalid browser profile") }
                if operation == "open" {
                    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appId) else { try refuse("The allowed application is not installed") }
                    let config = NSWorkspace.OpenConfiguration(); config.activates = true
                    if let profile { config.arguments = ["--profile-directory=\(profile)"]; config.createsNewApplicationInstance = true }
                    dispatched = true
                    _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
                    result = ["opened": true]
                } else if operation == "secretType" {
                    // The owner's secret into the focused field of the app the use named
                    // (owner-secrets §3). The frontmost app is checked again here — the
                    // foreground guard every input has — so an app switch between the
                    // approval and the typing refuses with nothing typed. The write is
                    // the same chunked keyboard path act/fill uses; unlike that fill,
                    // a secure field is not refused, because the owner's secret into
                    // the owner's own focused field is the whole point, and the card
                    // the use drew is what stands behind it.
                    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == appId else {
                        try refuse("The focused app is no longer the one this use was approved for. Nothing was typed.")
                    }
                    guard let value = request["value"] as? String, value.utf16.count <= 10000 else { try refuse("Invalid text") }
                    let root = AXUIElementCreateApplication(app.processIdentifier)
                    AXUIElementSetMessagingTimeout(root, 2)
                    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                    guard let window = element(attr(root, kAXFocusedWindowAttribute)) else { try refuse("The focused app has no readable window. Nothing was typed.") }
                    guard element(attr(root, kAXFocusedUIElementAttribute)) != nil else { try refuse("The focused app has no focused field to type into. Nothing was typed.") }
                    dispatched = true
                    try key(0, .maskCommand)
                    try typeInto(value, app, window)
                    result = ["completed": true]
                } else {
                    let s = try state(appId)
                    if operation == "observe" {
                        let (jpeg, width, height) = try await capture(s)
                        try focusCheck(s)
                        result = ["identity": s.identity, "title": s.title, "nodes": s.nodes.map(\.data), "jpeg": jpeg.base64EncodedString(), "width": width, "height": height, "imageHash": digest(jpeg)]
                    } else if operation == "act" {
                        guard let action = request["action"] as? String else { try refuse("Missing action") }
                        if action == "navigate" {
                            guard ["com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser", "org.mozilla.firefox"].contains(appId), let url = request["url"] as? String, let parsed = URL(string: url), ["https", "http"].contains(parsed.scheme ?? ""), parsed.host != nil else { try refuse("Navigation requires a supported browser and an HTTP(S) URL") }
                            guard let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appId) else { try refuse("Browser is not installed") }
                            try focusCheck(s); dispatched = true
                            // LaunchServices opens a normal browser tab. No address-bar guessing,
                            // remote debugging, Apple events, browser scripting or URL code schemes.
                            let config = NSWorkspace.OpenConfiguration(); config.activates = true
                            if let profile {
                                // The URL travels as a launch argument so it lands in the chosen profile.
                                config.arguments = ["--profile-directory=\(profile)", parsed.absoluteString]; config.createsNewApplicationInstance = true
                                _ = try await NSWorkspace.shared.openApplication(at: application, configuration: config)
                            } else {
                                _ = try await NSWorkspace.shared.open([parsed], withApplicationAt: application, configuration: config)
                            }
                        } else {
                            guard request["identity"] as? String == s.identity else { try refuse("Window changed. Observe again.") }
                            var target: Node?
                            if let expected = request["target"] as? [String: Any], let path = expected["path"] as? [Int] {
                                target = s.nodes.first { ($0.data["path"] as? [Int]) == path }
                                guard let target, fingerprint(target.data) == fingerprint(expected), target.data["secure"] as? Bool != true, target.data["enabled"] as? Bool == true else { try refuse("Accessibility target changed, is disabled or secure. Observe again.") }
                            }
                            if let x = request["x"] as? Double, let y = request["y"] as? Double {
                                guard action == "click", x >= 0, y >= 0, x < s.frame.width, y < s.frame.height else { try refuse("Coordinates are supported only for clicks inside the screenshot") }
                                let (jpeg, _, _) = try await capture(s)
                                guard request["imageHash"] as? String == digest(jpeg) else { try refuse("Screenshot changed. Observe again before a coordinate click.") }
                                // click performs hit testing before dispatch; unknown errors are conservative.
                                dispatched = true; try click(CGPoint(x: s.frame.minX + x, y: s.frame.minY + y), s)
                            } else if action == "scroll" {
                                try focusCheck(s)
                                guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: request["direction"] as? String == "up" ? 400 : -400, wheel2: 0, wheel3: 0) else { try refuse("Cannot create scroll event") }
                                // Scroll at the center of the observed window, never wherever the human left the pointer.
                                e.location = CGPoint(x: s.frame.midX, y: s.frame.midY)
                                try checkPoint(e.location, s)
                                dispatched = true; e.post(tap: .cghidEventTap)
                            } else {
                                guard let target else { try refuse("Use a fresh accessibility target ref") }
                                try focusCheck(s)
                                try checkTarget(target.e, s)
                                switch action {
                                case "click":
                                    var actions: CFArray?; AXUIElementCopyActionNames(target.e, &actions)
                                    if (actions as? [String] ?? []).contains(kAXPressAction) {
                                        dispatched = true
                                        guard AXUIElementPerformAction(target.e, kAXPressAction as CFString) == .success else { throw NSError(domain: "AXPress may have failed", code: 1) }
                                    } else {
                                        guard let r = rect(target.e) else { try refuse("Target has no bounds") }
                                        dispatched = true; try click(CGPoint(x: r.midX, y: r.midY), s)
                                    }
                                case "fill", "press":
                                    let role = target.data["role"] as? String ?? ""
                                    if action == "fill" && !["AXTextField", "AXTextArea", "AXComboBox"].contains(role) { try refuse("Fill requires a non-password editable accessibility target") }
                                    guard let value = request["value"] as? String ?? (action == "press" ? "" : nil), value.utf16.count <= 10000 else { try refuse("Invalid text") }
                                    let keys: [String: CGKeyCode] = ["Enter": 36, "Tab": 48, "Escape": 53, "ArrowDown": 125, "ArrowUp": 126, "ArrowLeft": 123, "ArrowRight": 124, "Space": 49, "Backspace": 51]
                                    if action == "press" && keys[request["key"] as? String ?? ""] == nil { try refuse("Unsupported key") }
                                    dispatched = true
                                    guard AXUIElementSetAttributeValue(target.e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { throw NSError(domain: "Cannot focus target", code: 1) }
                                    let root = AXUIElementCreateApplication(s.app.processIdentifier)
                                    guard let focused = element(attr(root, kAXFocusedUIElementAttribute)), CFEqual(focused, target.e), !secure(focused) else { throw NSError(domain: "Focus did not match target", code: 1) }
                                    try focusCheck(s)
                                    if action == "fill" { try key(0, .maskCommand); try typeText(value, s) }
                                    else { try key(keys[request["key"] as? String ?? ""]!) }
                                default: try refuse("Unsupported OS action. Use click on an accessibility option instead of select/tab.")
                                }
                            }
                        }
                        result = ["completed": true]
                    } else { try refuse("Unknown operation") }
                }
            }
            emit(result)
        } catch {
            emit(["error": (error as? Refusal)?.message ?? error.localizedDescription, "dispatched": dispatched])
        }
    }
    static func emit(_ result: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) { FileHandle.standardOutput.write(data) }
    }
}
