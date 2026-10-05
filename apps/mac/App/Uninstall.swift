import AppKit
import Foundation

/// buddi → Uninstall buddi…, and the end of Settings → System's "Remove buddi
/// from this Mac" (the supervisor leaves with `UninstallPolicy.exitStatus`).
///
/// The order is the product's promise: what goes is listed first; the last
/// backup is taken and moved to ~/buddi-backups with its `.passphrase.txt`;
/// the six words are shown with Copy and an "I wrote it down" box before
/// anything is deleted; then buddi stops, the launcher's `buddi uninstall`
/// removes the service, the data and the keychain entries (or keeps the data
/// for a reinstall), and buddi.app moves itself to the Trash and quits.
@MainActor
enum Uninstall {
    /// The menu item: the whole dialog, natively.
    static func run(supervisor: Supervisor) {
        guard case .running = supervisor.health else {
            let alert = NSAlert()
            alert.messageText = "buddi has to be running to uninstall it"
            alert.informativeText = "The last backup is taken before anything is removed, and that needs buddi running. Restart buddi, then try again."
            NSApp.activate()
            alert.runModal()
            return
        }
        let socket = DataDirectory.socket(for: supervisor.data)
        let planData = (try? ControlSocket.request(socket, method: "GET", path: "/uninstall", timeout: 10))?.1
        let plan = planData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]

        // 1. What goes.
        let keep = NSButton(checkboxWithTitle: "Keep my data for a reinstall", target: nil, action: nil)
        let first = NSAlert()
        first.messageText = UninstallPolicy.confirmTitle
        var lines: [String] = []
        if let service = plan["service"] as? String { lines.append("• The background service (\(service)).") }
        lines.append("• Your data: agents, chats, memory, files and the database, in \(supervisor.data.path).")
        if let keychain = plan["keychain"] as? String { lines.append("• The passwords and keys buddi keeps in the keychain (\(keychain)).") }
        lines.append("• buddi.app, moved to the Trash.")
        first.informativeText = "This removes:\n" + lines.joined(separator: "\n")
            + "\n\nFirst, one last backup goes to \((plan["backups"] as? String) ?? "~/buddi-backups"), where it stays. With “Keep my data”, your data and keychain entries stay too."
        first.accessoryView = keep
        first.addButton(withTitle: "Take the Last Backup")
        first.addButton(withTitle: "Cancel")
        NSApp.activate()
        guard first.runModal() == .alertFirstButtonReturn else { return }
        let keepData = keep.state == .on

        // 2. The last backup, with a window that says so while it runs.
        let progress = ProgressPanel(title: "Taking the last backup…")
        progress.show()
        Task.detached {
            let outcome = Self.takeLastBackup(socket: socket) { detail in
                Task { @MainActor in progress.update(detail) }
            }
            await MainActor.run {
                progress.close()
                switch outcome {
                case .failure(let message):
                    let failed = NSAlert()
                    failed.messageText = "buddi was not uninstalled"
                    failed.informativeText = "The last backup did not finish: \(message). Nothing was removed."
                    NSApp.activate()
                    failed.runModal()
                case .success(let report):
                    guard confirmWords(report) else { return }
                    finish(supervisor: supervisor, keepData: keepData)
                }
            }
        }
    }

    enum Outcome: Sendable { case success(UninstallPolicy.BackupReport), failure(String) }

    nonisolated static func takeLastBackup(socket: String, progress: @escaping @Sendable (String) -> Void) -> Outcome {
        guard let (code, body) = try? ControlSocket.request(socket, method: "POST", path: "/uninstall/backup", timeout: 25),
              code == 202,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let job = object["job"] as? [String: Any], let id = job["id"] as? String else {
            return .failure("the service would not start it")
        }
        let deadline = Date().addingTimeInterval(30 * 60)
        while Date() < deadline {
            if let (status, data) = try? ControlSocket.request(socket, method: "GET", path: "/jobs/\(id)", timeout: 10), status == 200,
               let state = UninstallPolicy.jobState(from: data) {
                switch state {
                case .running(let detail): progress(detail)
                case .done(let report): return .success(report)
                case .failed(let message): return .failure(message)
                }
            }
            Thread.sleep(forTimeInterval: 1)
        }
        return .failure("it took longer than half an hour")
    }

    /// 3. The words, before anything goes: Copy, and "I wrote it down" unlocks Uninstall.
    static func confirmWords(_ report: UninstallPolicy.BackupReport) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Write down your backup passphrase"
        let box = NSStackView()
        box.orientation = .vertical
        box.alignment = .leading
        box.spacing = 8
        var text = "The last backup is \(report.archive)."
        if let phrase = report.passphrase {
            text += " These six words open it. They leave this Mac's keychain with the rest, so write them down now."
            let words = NSTextField(labelWithString: phrase)
            words.isSelectable = true
            words.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .medium)
            box.addArrangedSubview(words)
            let copy = ActionButton(title: "Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(phrase, forType: .string) }
            box.addArrangedSubview(copy)
            if let file = report.passphraseFile {
                let note = NSTextField(wrappingLabelWithString: "They are also in \(file), which only you can read. Delete it once they are written down.")
                note.textColor = .secondaryLabelColor
                note.preferredMaxLayoutWidth = 320
                box.addArrangedSubview(note)
            }
        }
        alert.informativeText = text
        alert.addButton(withTitle: "Uninstall buddi")
        alert.addButton(withTitle: "Cancel")
        if report.passphrase != nil {
            let uninstall = alert.buttons[0]
            uninstall.isEnabled = UninstallPolicy.mayRemove(report: report, wroteItDown: false)
            let wrote = ActionButton(checkbox: "I wrote it down") { on in
                uninstall.isEnabled = UninstallPolicy.mayRemove(report: report, wroteItDown: on)
            }
            box.addArrangedSubview(wrote)
        }
        box.frame = NSRect(x: 0, y: 0, width: 340, height: box.fittingSize.height)
        alert.accessoryView = box
        NSApp.activate()
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Stop buddi, run the launcher's uninstall; when it all went, move the app
    /// to the Trash and quit. When it did not, the app stays (it is the way to
    /// try again), says why, and offers Retry.
    static func finish(supervisor: Supervisor, keepData: Bool) {
        supervisor.shutdown { runLauncherUninstall(supervisor: supervisor, keepData: keepData) }
    }

    private static func runLauncherUninstall(supervisor: Supervisor, keepData: Bool) {
        let progress = ProgressPanel(title: "Uninstalling buddi…")
        progress.show()
        Task.detached {
            let result = await supervisor.runUninstall(keepData: keepData)
            await MainActor.run {
                progress.close()
                switch UninstallPolicy.afterwards(status: result.status, output: result.output) {
                case .keepApp(let reason):
                    let failed = NSAlert()
                    failed.messageText = "buddi was not completely uninstalled"
                    failed.informativeText = reason + "\n\nbuddi.app stays so you can try again."
                    failed.addButton(withTitle: "Retry")
                    failed.addButton(withTitle: "Close")
                    NSApp.activate()
                    if failed.runModal() == .alertFirstButtonReturn {
                        runLauncherUninstall(supervisor: supervisor, keepData: keepData)
                    }
                case .trashAndQuit:
                    if LaunchAtLogin.isEnabled { LaunchAtLogin.setEnabled(false) }
                    let bundle = Bundle.main.bundleURL
                    NSWorkspace.shared.recycle([bundle]) { _, error in
                        if let error { NSLog("buddi: could not move \(bundle.path) to the Trash: \(error)") }
                        DispatchQueue.main.async { NSApp.terminate(nil) }
                    }
                }
            }
        }
    }

    /// The supervisor left for the app to finish (Settings → System): read what
    /// the owner chose, and delete the request at once. Left behind (with Keep
    /// my data, the folder stays), a later exit 76 would run it again.
    static func pendingRequest(data: URL) -> Bool? {
        let file = data.appendingPathComponent(UninstallPolicy.requestFile)
        guard let contents = try? Data(contentsOf: file) else { return nil }
        try? FileManager.default.removeItem(at: file)
        return UninstallPolicy.keepData(fromRequest: contents)
    }
}

/// A small window with a spinner and a line, while something long runs.
@MainActor
final class ProgressPanel {
    private let panel: NSPanel
    private let label: NSTextField

    init(title: String) {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "buddi"
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let heading = NSTextField(labelWithString: title)
        heading.font = .boldSystemFont(ofSize: 13)
        label = NSTextField(labelWithString: "")
        label.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [spinner, heading, label])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        panel.contentView = stack
        panel.center()
    }

    func show() { NSApp.activate(); panel.makeKeyAndOrderFront(nil) }
    func update(_ detail: String) { label.stringValue = detail }
    func close() { panel.orderOut(nil) }
}

/// A button whose action is a closure (checkbox: called with its state).
@MainActor
final class ActionButton: NSButton {
    private var onPress: (() -> Void)?
    private var onToggle: ((Bool) -> Void)?

    convenience init(title: String, action: @escaping () -> Void) {
        self.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        onPress = action
        target = self
        self.action = #selector(fire)
    }

    convenience init(checkbox title: String, toggled: @escaping (Bool) -> Void) {
        self.init(frame: .zero)
        setButtonType(.switch)
        self.title = title
        onToggle = toggled
        target = self
        action = #selector(fire)
    }

    @objc private func fire() {
        onPress?()
        onToggle?(state == .on)
    }
}
