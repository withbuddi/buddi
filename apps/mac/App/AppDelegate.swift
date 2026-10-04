import AppKit
import Sparkle

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var statusItemController: StatusItemController?
    private var mainWindow: MainWindowController?
    /// A `buddi://` link that arrived before the window existed (a cold launch by link).
    private var pendingLink: BuddiLink?
    let supervisor = Supervisor()

    // Sparkle updates the app binary itself (rarely); buddi's own releases are the
    // supervisor's business. Feed URL and public key live in Info.plist
    // (SUFeedURL / SUPublicEDKey). Until the real key is in project.yml the
    // updater is not started: Sparkle refuses to run without a valid key.
    private lazy var updaterController = SPUStandardUpdaterController(
        startingUpdater: AppDelegate.sparkleConfigured, updaterDelegate: nil, userDriverDelegate: nil)

    static var sparkleConfigured: Bool {
        guard let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String else { return false }
        return !key.isEmpty && !key.hasPrefix("REPLACE")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if AppDelegate.sparkleConfigured { _ = updaterController }
        NSApp.mainMenu = MainMenu.build(target: self)
        statusItemController = StatusItemController(supervisor: supervisor, appDelegate: self)

        // The window opens at launch with its placeholder and follows the
        // supervisor from there, next to the status item.
        let window = MainWindowController(supervisor: supervisor)
        mainWindow = window
        let statusChanged = supervisor.onChange
        supervisor.onChange = { [weak window] in
            statusChanged?()
            window?.supervisorChanged()
        }
        // Settings → System's "Remove buddi from this Mac" ends here: the app finishes it.
        supervisor.onUninstall = { [weak self] keepData in
            guard let self else { return }
            Uninstall.finish(supervisor: self.supervisor, keepData: keepData)
        }
        window.onTakeOver = { [weak self] in self?.takeOverFromNpm() }
        // A newer buddi: one quiet alert per version, then the menu item (UpdatePolicy).
        supervisor.onVersion = { [weak self] view in self?.statusItemController?.offerUpdateOnce(view) }
        // First run (and anything else that opens the dashboard) lands in the window.
        supervisor.presentDashboard = { [weak window] url in window?.present(link: url) }
        window.present()
        window.supervisorChanged()
        if let link = pendingLink { pendingLink = nil; follow(link) }

        if let plist = Adoption.npmService(data: supervisor.data) {
            _ = Adoption.offer(data: supervisor.data, plist: plist)
        }
        supervisor.start()
    }

    /// `buddi://open`, `buddi://settings/<page>?…` (App/BuddiLink.swift). Anything
    /// else is refused: the window does not move for a link it does not know.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let link = BuddiLink.parse(url) else {
                NSLog("buddi: refused a link it does not answer (%@)", url.scheme ?? "no scheme")
                continue
            }
            if mainWindow == nil { pendingLink = link } else { follow(link) }
        }
    }

    private func follow(_ link: BuddiLink) {
        mainWindow?.present()
        if case .route(let route) = link { mainWindow?.go(to: route) }
    }

    /// From the menu, while an npm install's service still holds the data directory.
    func takeOverFromNpm() {
        guard let plist = Adoption.npmService(data: supervisor.data) else { return }
        if Adoption.offer(data: supervisor.data, plist: plist, fromMenu: true) {
            supervisor.start()
        }
    }

    /// Sparkle only ever offers a new app shell (apps/mac/SHELL_VERSION); asked
    /// in the background, it says nothing unless there is one.
    func checkForAppUpdates() {
        guard AppDelegate.sparkleConfigured else { return }
        updaterController.updater.checkForUpdatesInBackground()
    }

    /// The dock icon with the window hidden (⌘W) brings it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { mainWindow?.present() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: - Menu commands

    @objc func showMainWindow() { mainWindow?.present() }

    @objc func showAbout() {
        var options: [NSApplication.AboutPanelOptionKey: Any] = [:]
        // The bundle carries one buddi; after an in-app update the running one is newer.
        if let running = supervisor.version?.current,
           running != Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
            options[.credits] = NSAttributedString(
                string: "Running buddi \(running)",
                attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor])
        }
        NSApp.orderFrontStandardAboutPanel(options: options)
        NSApp.activate()
    }

    @objc func checkForUpdatesFromMenu() { statusItemController?.checkForUpdates() }
    @objc func uninstallBuddi() { Uninstall.run(supervisor: supervisor) }

    /// buddi → Install Command Line Tool…: the supervisor writes the shim
    /// (packages/install/src/cli-shim.ts), the same call Settings → System makes.
    @objc func installCommandLineTool() {
        let socket = DataDirectory.socket(for: supervisor.data)
        Task.detached {
            // macOS's administrator prompt is part of this call: give it time.
            let answer = try? ControlSocket.request(socket, method: "POST", path: "/cli", body: Data("{}".utf8), timeout: 150)
            await MainActor.run {
                let alert = NSAlert()
                let object = answer.flatMap { try? JSONSerialization.jsonObject(with: $0.1) as? [String: Any] } ?? [:]
                if let answer, answer.0 == 200 {
                    alert.messageText = "The command line tool is installed"
                    alert.informativeText = (object["lines"] as? [String])?.joined(separator: "\n") ?? "Open a new terminal and run buddi status."
                } else {
                    alert.messageText = "The command line tool was not installed"
                    alert.informativeText = (object["error"] as? String) ?? "buddi did not answer. Make sure it is running, then try again."
                }
                NSApp.activate()
                alert.runModal()
            }
        }
    }

    @objc func openSettings() { mainWindow?.present(); mainWindow?.go(to: DashboardRoutes.settings) }
    @objc func lockDashboard() { mainWindow?.lock() }
    @objc func newConversation() { mainWindow?.present(); mainWindow?.newConversation() }
    @objc func openInBrowser() { supervisor.openDashboard(inBrowser: true) }
    @objc func showFind() { mainWindow?.present(); mainWindow?.showFind() }
    @objc func findNext() { mainWindow?.findNext() }
    @objc func findPrevious() { mainWindow?.findPrevious() }
    @objc func reloadDashboard() { mainWindow?.reload() }
    @objc func zoomActual() { mainWindow?.zoom(0) }
    @objc func zoomIn() { mainWindow?.zoom(1) }
    @objc func zoomOut() { mainWindow?.zoom(-1) }
    @objc func openHelp() { NSWorkspace.shared.open(DashboardRoutes.docs) }
    @objc func reportProblem() { NSWorkspace.shared.open(DashboardRoutes.reportProblem) }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let shown = mainWindow?.isShowingDashboard ?? false
        var running = false
        if case .running = supervisor.health { running = true }
        switch item.action {
        case #selector(lockDashboard), #selector(showFind), #selector(findNext), #selector(findPrevious):
            return shown
        case #selector(openInBrowser), #selector(installCommandLineTool):
            return running
        case #selector(zoomIn): return shown && (mainWindow?.canZoomIn ?? false)
        case #selector(zoomOut): return shown && (mainWindow?.canZoomOut ?? false)
        case #selector(zoomActual): return shown
        default: return true
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        supervisor.shutdown {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
