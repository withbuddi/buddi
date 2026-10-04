import AppKit
import UniformTypeIdentifiers
import WebKit

/// The app's window: the dashboard in a WKWebView, as Tauri would host it,
/// without a second runtime.
///
/// It loads the sign-in link the launcher prints (the same one Open in Browser
/// uses), so first run and the lock screen are simply pages in it. Until the
/// gateway answers it shows a native placeholder; when the gateway goes away
/// (a restart, an update) the placeholder comes back and the page reloads on
/// the same route once buddi is up again. ⌘W hides the window; the dock icon
/// and the menu-bar glyph's Open buddi bring it back.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let supervisor: Supervisor
    private let webView: WKWebView
    private let placeholder = MainWindowPlaceholder(frame: .zero)
    private let findBar: MainWindowFindBar
    private let notifications = MainWindowNotifications()

    /// `scheme://host:port` of the dashboard, from the sign-in link.
    private var origin: URL?
    private var revealed = false
    private var loading = false
    private var retry: DispatchWorkItem?
    /// The route to come back to after a reload, or one a menu item asked for before the page was up.
    private var pendingRoute: String?
    private var popups: [NSWindow] = []
    private var downloads: [ObjectIdentifier: URL] = [:]

    /// One pixel above the dashboard's phone breakpoint (`PHONE_QUERY`,
    /// max-width 720px, in App.tsx): the window always gets the desktop layout.
    static let minimumSize = NSSize(width: 721, height: 560)
    private static let zoomKey = "dashboardZoom"
    private static let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

    init(supervisor: Supervisor) {
        self.supervisor = supervisor

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        configuration.applicationNameForUserAgent = "Version/17.0 Safari/605.1.15 buddi-mac/\(version)"
        configuration.userContentController.addUserScript(MainWindowNotifications.script)
        configuration.userContentController.add(WeakScriptHandler(notifications), name: MainWindowNotifications.handlerName)
        webView = WKWebView(frame: .zero, configuration: configuration)
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        webView.underPageBackgroundColor = Kit.background
        webView.isHidden = true
        findBar = MainWindowFindBar(webView: webView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "buddi"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.backgroundColor = Kit.background
        window.contentMinSize = Self.minimumSize
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("buddi.main")

        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.pageZoom = Self.savedZoom
        notifications.isWindowInFront = { [weak self] in
            guard let window = self?.window else { return false }
            return window.isVisible && window.isKeyWindow && NSApp.isActive
        }
        notifications.onClick = { [weak self] in self?.present() }
        layout(in: window)

        placeholder.onRestart = { [weak self] in self?.supervisor.restart() }
        placeholder.onShowLogs = { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(DataDirectory.logs(for: self.supervisor.data))
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func layout(in window: NSWindow) {
        let content = NSView()
        content.wantsLayer = true
        window.contentView = content
        for view in [webView, placeholder, findBar] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        // The page starts below the titlebar: the strip above it is the kit's
        // ground with the standard traffic lights, never drawn-on chrome.
        let top = window.contentLayoutGuide as! NSLayoutGuide
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: top.topAnchor),
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            placeholder.topAnchor.constraint(equalTo: content.topAnchor),
            placeholder.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            placeholder.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            placeholder.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            findBar.topAnchor.constraint(equalTo: top.topAnchor, constant: 8),
            findBar.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
        ])
    }

    // MARK: - Showing and hiding

    /// Brings the window to the front (the dock icon, Open buddi, a notification).
    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// ⌘W and the close button hide the window; buddi keeps running.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window else { return true }
        sender.orderOut(nil)
        return false
    }

    /// Coming to the front gives the page the keyboard, so the composer's
    /// cursor is live without a click into the window first.
    func windowDidBecomeKey(_ notification: Notification) {
        guard let key = notification.object as? NSWindow, key === window, revealed else { return }
        key.makeFirstResponder(webView)
    }

    /// A popup window (window.open from the dashboard) went away.
    func windowWillClose(_ notification: Notification) {
        guard let closed = notification.object as? NSWindow, closed !== window else { return }
        popups.removeAll { $0 === closed }
    }

    // MARK: - Following the supervisor

    func supervisorChanged() {
        switch supervisor.health {
        case .running:
            if !revealed && !loading { load() }
        case .starting, .stopped:
            goneAway(.starting("Starting buddi…"))
        case .updating:
            goneAway(.starting("Updating buddi…"))
        case .attention(let reason):
            goneAway(.attention(reason, canRestart: supervisor.layout != nil && supervisor.foreign == nil))
        }
    }

    /// The gateway is not answering: placeholder up, and the next running loads again on this route.
    private func goneAway(_ mode: MainWindowPlaceholder.Mode) {
        if revealed, let fragment = webView.url?.fragment, !fragment.isEmpty, pendingRoute == nil {
            pendingRoute = "#" + fragment
        }
        revealed = false
        retry?.cancel()
        placeholder.show(mode)
        placeholder.isHidden = false
        webView.isHidden = true
        findBar.isHidden = true
    }

    private func load() {
        guard supervisor.layout != nil else { return }
        loading = true
        Task { @MainActor in
            let result = await self.supervisor.dashboardLink()
            guard case .running = self.supervisor.health else { self.loading = false; return }
            switch result {
            case .success(let link):
                self.open(link: link)
            case .failure(let failure):
                self.loading = false
                self.placeholder.show(.attention("buddi did not give a dashboard link. \(failure.description)", canRestart: true))
            }
        }
    }

    /// Loads a sign-in link, on the route to come back to if there is one.
    private func open(link: URL) {
        var components = URLComponents(url: link, resolvingAgainstBaseURL: false)
        origin = Self.origin(of: link)
        if let route = pendingRoute { components?.fragment = String(route.dropFirst()) }
        loading = true
        webView.load(URLRequest(url: components?.url ?? link))
    }

    /// `Supervisor.presentDashboard`: buddi opening the dashboard by itself (the
    /// first run): the window comes forward, and loads the link unless it already has a page.
    func present(link: URL) {
        present()
        if !revealed && !loading { open(link: link) }
    }

    private func reveal() {
        loading = false
        revealed = true
        pendingRoute = nil
        placeholder.isHidden = true
        webView.isHidden = false
        window?.makeFirstResponder(webView)
    }

    /// The gateway answered "running" but the page did not load: try again shortly.
    private func scheduleRetry() {
        loading = false
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, case .running = self.supervisor.health, !self.revealed else { return }
                self.load()
            }
        }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    // MARK: - Menu commands

    func go(to route: String) {
        guard revealed else { pendingRoute = route; return }
        evaluate("location.hash = \(Self.jsString(route));")
    }

    /// A fresh conversation with the agent on screen, or with the default agent
    /// (`#/chat/<agent>/new`, the route ChatPage opens fresh).
    func newConversation() {
        guard revealed else { pendingRoute = "#/chat"; return }
        evaluate("""
        (async () => {
          const on = /^#\\/chat\\/(?!g\\/)([^/?]+)/.exec(location.hash);
          let id = on ? decodeURIComponent(on[1]) : null;
          if (!id) {
            try {
              const res = await fetch('/api/chat/agents', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
              if (res.ok) id = (await res.json()).defaultAgentId || null;
            } catch (_) {}
          }
          location.hash = id ? '#/chat/' + encodeURIComponent(id) + '/new' : '#/chat';
        })();
        """)
    }

    /// Lock now: the page's own ⌃⌘L handler (shell/lock.tsx) does it, PIN or not.
    func lock() {
        guard revealed else { return }
        evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));")
    }

    func reload() {
        if revealed { webView.reload() } else if case .running = supervisor.health, !loading { load() }
    }

    func showFind() { if revealed { findBar.open() } }
    func findNext() { if revealed { findBar.findNext() } }
    func findPrevious() { if revealed { findBar.findPrevious() } }

    func zoom(_ direction: Int) {
        let current = webView.pageZoom
        let next: CGFloat
        if direction == 0 {
            next = 1
        } else if direction > 0 {
            next = Self.zoomSteps.first(where: { $0 > current + 0.001 }) ?? current
        } else {
            next = Self.zoomSteps.last(where: { $0 < current - 0.001 }) ?? current
        }
        webView.pageZoom = next
        UserDefaults.standard.set(Double(next), forKey: Self.zoomKey)
    }

    var canZoomIn: Bool { webView.pageZoom < (Self.zoomSteps.last ?? 3) - 0.001 }
    var canZoomOut: Bool { webView.pageZoom > (Self.zoomSteps.first ?? 0.5) + 0.001 }
    var isShowingDashboard: Bool { revealed }

    private static var savedZoom: CGFloat {
        let value = UserDefaults.standard.double(forKey: zoomKey)
        return value > 0 ? CGFloat(value) : 1
    }

    private func evaluate(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private static func jsString(_ text: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [text])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    // MARK: - Where links go

    private static func origin(of url: URL) -> URL? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url
    }

    private func isDashboard(_ url: URL) -> Bool {
        guard let origin, let mine = Self.origin(of: url) else { return false }
        return mine == origin
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { decisionHandler(.allow); return }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        switch scheme {
        case "about", "blob", "data":
            decisionHandler(.allow)
        case "http", "https":
            // The first load names the dashboard; after that, anything off its
            // origin in the main frame belongs in the browser. Frames inside
            // the page (a plugin's page, the browser canvas) load as they are.
            if origin == nil || isDashboard(url) || !mainFrame {
                decisionHandler(.allow)
            } else {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                if webView !== self.webView, webView.url == nil || webView.url?.absoluteString == "about:blank" {
                    webView.window?.close()
                }
            }
        default:
            // mailto:, tel:, and the like.
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        // A reload (⌘R, an update) keeps the keyboard in the page as the first load does.
        guard !revealed else { window?.makeFirstResponder(webView); return }
        if case .running = supervisor.health { reveal() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        let code = (error as NSError).code
        // A cancelled load (a download, a link sent to the browser) is not a failure.
        if code == NSURLErrorCancelled || code == 102 /* WebKitErrorFrameLoadInterruptedByPolicyChange */ { return }
        if !revealed { scheduleRetry() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        if let fragment = webView.url?.fragment { pendingRoute = "#" + fragment }
        goneAway(.starting("Starting buddi…"))
        if case .running = supervisor.health { load() }
    }

    // MARK: - window.open, dialogs, files, microphone and camera

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme), !isDashboard(url) {
            NSWorkspace.shared.open(url)
            return nil
        }
        if let url = action.request.url, let scheme = url.scheme?.lowercased(), !["http", "https", "about", "blob", "data"].contains(scheme) {
            NSWorkspace.shared.open(url)
            return nil
        }
        // The dashboard's own pages (a file preview, a printable view) open in
        // a plain window of their own, under the same rules.
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "buddi"
        window.contentView = popup
        window.cascadeTopLeft(from: self.window?.frame.origin ?? .zero)
        window.makeKeyAndOrderFront(nil)
        window.delegate = self
        popups.append(window)
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView !== self.webView { webView.window?.close() }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        sheet(alert, in: webView) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        sheet(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        sheet(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    private func sheet(_ alert: NSAlert, in webView: WKWebView, done: @escaping @MainActor (NSApplication.ModalResponse) -> Void) {
        if let window = webView.window {
            alert.beginSheetModal(for: window) { response in MainActor.assumeIsolated { done(response) } }
        } else {
            done(alert.runModal())
        }
    }

    /// `<input type=file>`: the Composer's attachments, plugin and skill uploads.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        if let window = webView.window {
            panel.beginSheetModal(for: window) { response in
                MainActor.assumeIsolated { completionHandler(response == .OK ? panel.urls : nil) }
            }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    /// Voice and the camera button. macOS asks the owner once (the usage
    /// strings in Info.plist); the dashboard's own origin needs no second prompt.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        let mine = self.origin.map { $0.host == origin.host && ($0.port ?? 0) == origin.port } ?? false
        decisionHandler(mine ? .grant : .prompt)
    }

    // MARK: - Downloads: into ~/Downloads, then shown in Finder

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        let destination = Self.unused(folder.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename))
        downloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert()
        alert.messageText = "The download did not finish"
        alert.informativeText = error.localizedDescription
        if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    /// `report.pdf`, then `report 2.pdf`, as Safari names a second copy.
    private static func unused(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        let folder = url.deletingLastPathComponent()
        for n in 2...999 {
            let name = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
            let candidate = folder.appendingPathComponent(name)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
        }
        return folder.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : ".\(ext)"))
    }
}

