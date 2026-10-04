import AppKit

/// The menu-bar item: a status line and the handful of things an owner does
/// with a background service. Everything else lives in the dashboard.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let supervisor: Supervisor
    private weak var appDelegate: AppDelegate?

    private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let detailLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var openItem: NSMenuItem!
    private var updateBuddiItem: NSMenuItem!
    private var checkItem: NSMenuItem!
    private var restartItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var takeOverItem: NSMenuItem!
    private var logsItem: NSMenuItem!
    private var advancedItem: NSMenuItem!
    private var previousItem: NSMenuItem!

    init(supervisor: Supervisor, appDelegate: AppDelegate) {
        self.supervisor = supervisor
        self.appDelegate = appDelegate
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        statusItem.menu = buildMenu()
        supervisor.onChange = { [weak self] in self?.refresh() }
        refresh()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        // Without this, NSMenu re-enables any item whose target responds to its action.
        menu.autoenablesItems = false

        statusLine.isEnabled = false
        detailLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(detailLine)
        menu.addItem(.separator())

        openItem = add(menu, "Open buddi", #selector(openBuddi), key: "o")
        menu.addItem(.separator())
        updateBuddiItem = add(menu, "Update buddi", #selector(updateBuddi))
        checkItem = add(menu, "Check for Updates…", #selector(checkForUpdates))
        menu.addItem(.separator())
        restartItem = add(menu, "Restart buddi", #selector(restart))
        loginItem = add(menu, "Start at Login", #selector(toggleLogin))
        takeOverItem = add(menu, "Take Over from npm Install…", #selector(takeOver))
        logsItem = add(menu, "Show Logs", #selector(showLogs))
        let advanced = NSMenu()
        advanced.autoenablesItems = false
        previousItem = add(advanced, "Restart with the Previous Version…", #selector(restartWithPrevious))
        advancedItem = menu.addItem(withTitle: "Advanced", action: nil, keyEquivalent: "")
        advancedItem.submenu = advanced
        menu.addItem(.separator())
        add(menu, "Quit buddi", #selector(quit), key: "q")
        return menu
    }

    @discardableResult
    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
        // The supervisor's cached answer; the daily check (or Check for Updates) refreshes it.
        if case .running = supervisor.health { supervisor.refreshVersion() }
    }

    private func refresh() {
        let health = supervisor.health
        var running = false
        detailLine.isHidden = true
        switch health {
        case .starting, .stopped:
            statusLine.title = health == .stopped ? "Stopped" : "Starting…"
        case .updating:
            statusLine.title = "Updating…"
        case .running(let since):
            running = true
            statusLine.title = "Running since \(Self.format(since))"
        case .attention(let reason):
            statusLine.title = "Needs attention"
            detailLine.title = reason
            detailLine.isHidden = false
        }
        openItem.isEnabled = running
        restartItem.isEnabled = supervisor.layout != nil && supervisor.foreign == nil
        loginItem.state = LaunchAtLogin.isEnabled ? .on : .off
        takeOverItem.isHidden = Adoption.npmService(data: supervisor.data) == nil
        if case .attention = health { logsItem.isHidden = false } else { logsItem.isHidden = true }
        if let previous = supervisor.previousVersion, health != .updating {
            previousItem.title = "Restart with the Previous Version (\(previous))…"
            previousItem.isEnabled = true
        } else {
            previousItem.title = "Restart with the Previous Version…"
            previousItem.isEnabled = false
        }

        if let version = supervisor.version, version.updateAvailable, let latest = version.latest, running {
            updateBuddiItem.title = "Update to \(latest)"
            updateBuddiItem.isHidden = false
        } else {
            updateBuddiItem.isHidden = true
        }
        updateGlyph(health)
    }

    private func updateGlyph(_ health: Supervisor.Health) {
        let name: String
        switch health {
        case .running: name = "b.circle.fill"
        case .attention: name = "exclamationmark.circle"
        default: name = "b.circle"
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "buddi")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "buddi — \(statusLine.title)"
    }

    private static func format(_ date: Date) -> String {
        let formatter = DateFormatter()
        if Calendar.current.isDateInToday(date) {
            formatter.timeStyle = .short
            formatter.dateStyle = .none
        } else {
            formatter.setLocalizedDateFormatFromTemplate("MMMd jmm")
        }
        return formatter.string(from: date)
    }

    // MARK: - Actions

    @objc private func openBuddi() { supervisor.openDashboard() }

    @objc private func restart() { supervisor.restart() }

    @objc private func toggleLogin() {
        LaunchAtLogin.setEnabled(!LaunchAtLogin.isEnabled)
        refresh()
    }

    @objc private func takeOver() { appDelegate?.takeOverFromNpm() }

    @objc private func showLogs() {
        NSWorkspace.shared.open(DataDirectory.logs(for: supervisor.data))
    }

    /// Both layers: Sparkle for the app binary (its own window), and buddi's
    /// own check — the supervisor's `/version/check`, the call behind Settings →
    /// System's "Check now".
    @objc private func checkForUpdates() {
        appDelegate?.checkForAppUpdates()
        guard case .running = supervisor.health else { return }
        supervisor.refreshVersion(check: true) { view in
            let alert = NSAlert()
            if let view, view.updateAvailable, let latest = view.latest {
                alert.messageText = "buddi \(latest) is available"
                alert.informativeText = "You have \(view.current). Choose Update to \(latest) in the menu."
            } else if let view {
                alert.messageText = "buddi is up to date"
                alert.informativeText = view.error.map { "The check did not finish: \($0)" } ?? "You have \(view.current), the latest version."
            } else {
                alert.messageText = "buddi could not check for updates"
                alert.informativeText = "The service did not answer. Try again in a moment."
            }
            NSApp.activate()
            alert.runModal()
        }
    }

    /// The same upgrade as Settings → System: the supervisor downloads the
    /// release from npm, checks its integrity and provenance, unpacks it into
    /// `<data>/releases` (never into this signed app), takes a backup, and
    /// restarts on it. Asked once, with what changes.
    @objc private func updateBuddi() {
        guard let view = supervisor.version, let latest = view.latest else { return }
        let alert = NSAlert()
        alert.messageText = "Update buddi to \(latest)?"
        var text = "You have \(view.current). buddi takes a backup first, installs \(latest) and restarts; it takes a minute or two."
        if let notes = view.latestNotes, !notes.isEmpty {
            text += "\n\nWhat changes:\n" + String(notes.prefix(1200))
        }
        alert.informativeText = text
        alert.addButton(withTitle: "Update")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        supervisor.startUpgrade(to: latest) { refusal in
            guard let refusal else { return }
            let failed = NSAlert()
            failed.messageText = "buddi did not update"
            failed.informativeText = refusal
            NSApp.activate()
            failed.runModal()
        }
    }

    /// Advanced → Restart with the Previous Version: back to the release that
    /// ran before the last update (or the one this app carries).
    @objc private func restartWithPrevious() {
        guard let previous = supervisor.previousVersion else { return }
        let alert = NSAlert()
        alert.messageText = "Restart buddi with \(previous)?"
        alert.informativeText = "buddi stops and starts again on \(previous). Your data stays as it is. If the newer version already changed the database, \(previous) may refuse to start: then restore the backup the update took first, in Settings → Backups."
        alert.addButton(withTitle: "Restart with \(previous)")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        supervisor.restartWithPreviousVersion { problem in
            guard let problem else { return }
            let failed = NSAlert()
            failed.messageText = "buddi did not switch versions"
            failed.informativeText = problem
            NSApp.activate()
            failed.runModal()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }
}
