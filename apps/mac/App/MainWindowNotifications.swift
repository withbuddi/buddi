import AppKit
import UserNotifications
import WebKit

/// Web Notifications from the dashboard, as native notifications.
///
/// A user script replaces `window.Notification` with a stand-in that posts
/// `{title, body, tag}` to the `buddiNotify` message handler; this shows it
/// through UNUserNotificationCenter (asking for permission the first time).
/// Clicking one brings the window back. While the window is in front the
/// page already shows the news itself, so the banner stays quiet.
@MainActor
final class MainWindowNotifications: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    static let handlerName = "buddiNotify"

    /// Installed at document start in the main frame only.
    static let script = WKUserScript(source: """
    (() => {
      const post = (message) => { try { window.webkit.messageHandlers.\(handlerName).postMessage(message); } catch (_) {} };
      class BuddiNotification extends EventTarget {
        constructor(title, options = {}) {
          super();
          this.title = String(title);
          this.body = options.body ? String(options.body) : '';
          this.tag = options.tag ? String(options.tag) : '';
          this.onclick = null; this.onclose = null; this.onerror = null; this.onshow = null;
          post({ title: this.title, body: this.body, tag: this.tag });
        }
        close() {}
        static get permission() { return 'granted'; }
        static requestPermission(callback) {
          post({ request: true });
          if (typeof callback === 'function') callback('granted');
          return Promise.resolve('granted');
        }
      }
      Object.defineProperty(window, 'Notification', { value: BuddiNotification, configurable: true, writable: true });
    })();
    """, injectionTime: .atDocumentStart, forMainFrameOnly: true)

    var isWindowInFront: () -> Bool = { false }
    var onClick: () -> Void = {}

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let center = UNUserNotificationCenter.current()
        if body["request"] != nil {
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
            return
        }
        guard let title = body["title"] as? String, !title.isEmpty else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        if let text = body["body"] as? String { content.body = text }
        content.sound = .default
        let tag = (body["tag"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            center.add(request)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let handler = UncheckedSendable(completionHandler)
        Task { @MainActor in
            handler.value(self.isWindowInFront() ? [] : [.banner, .sound])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let handler = UncheckedSendable(completionHandler)
        Task { @MainActor in
            self.onClick()
            handler.value()
        }
    }
}

/// WKUserContentController keeps its handlers strongly; this breaks the cycle.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?
    init(_ target: any WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

struct UncheckedSendable<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}
