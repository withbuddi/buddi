import AppKit
import Foundation

/// Taking over from `npm install -g @withbuddi/buddi`.
///
/// That install runs as a LaunchAgent named after the data directory
/// (`launchAgentLabel` in environment.ts). The app uses the same directory, so
/// the same agents, chats, settings and keychain namespace; only one supervisor
/// can hold it. Taking over stops and unloads that LaunchAgent and moves its
/// plist into the data directory (so launchd no longer starts it at login and
/// the owner can see what it was). Nothing in the data directory is touched.
@MainActor
enum Adoption {
    private static let declinedKey = "declinedNpmTakeover"

    /// The npm install's LaunchAgent for this data directory, when there is one
    /// and it is not this app's.
    static func npmService(data: URL) -> URL? {
        let plist = DataDirectory.launchAgentPlist(for: data)
        guard FileManager.default.fileExists(atPath: plist.path) else { return nil }
        if let dict = NSDictionary(contentsOf: plist) as? [String: Any],
           let program = dict["ProgramArguments"] as? [String],
           program.contains(where: { $0.hasPrefix(Bundle.main.bundlePath) }) {
            return nil
        }
        return plist
    }

    static var declined: Bool { UserDefaults.standard.bool(forKey: declinedKey) }

    /// The one dialog. Asked once on launch; afterwards the menu offers it.
    /// Returns true when the owner chose to take over (and it worked).
    static func offer(data: URL, plist: URL, fromMenu: Bool = false) -> Bool {
        if !fromMenu && declined { return false }
        let alert = NSAlert()
        alert.messageText = "Run your buddi from the app?"
        alert.informativeText = """
            buddi is already installed on this Mac with npm, and runs in the background on its own. \
            The app can take over: it stops that background service and runs the same buddi itself. \
            Your agents, chats, settings and passwords stay exactly where they are.

            Afterwards, the npm copy is unused. You can remove it whenever you like with:
            npm rm -g @withbuddi/buddi
            """
        alert.addButton(withTitle: "Take Over")
        alert.addButton(withTitle: "Not Now")
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else {
            UserDefaults.standard.set(true, forKey: declinedKey)
            return false
        }
        do {
            try takeOver(data: data, plist: plist)
            UserDefaults.standard.removeObject(forKey: declinedKey)
            return true
        } catch {
            let failed = NSAlert()
            failed.messageText = "buddi could not take over"
            failed.informativeText = "\(error.localizedDescription)\n\nNothing was removed. The npm service keeps running buddi."
            failed.runModal()
            return false
        }
    }

    /// `launchctl bootout` stops the supervisor (SIGTERM: gateway, then the
    /// database) and unloads the job; then the plist moves out of LaunchAgents,
    /// and this waits for the old supervisor to let go of the socket.
    static func takeOver(data: URL, plist: URL) throws {
        let label = DataDirectory.launchAgentLabel(for: data)
        let bootout = Process()
        bootout.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        bootout.arguments = ["bootout", "gui/\(getuid())/\(label)"]
        bootout.standardOutput = FileHandle.nullDevice
        bootout.standardError = FileHandle.nullDevice
        try bootout.run()
        bootout.waitUntilExit()
        // 3 ("No such process") means it was not loaded; that is fine too.

        let kept = data.appendingPathComponent("launchagent-from-npm.plist")
        try? FileManager.default.removeItem(at: kept)
        try FileManager.default.moveItem(at: plist, to: kept)

        let socket = DataDirectory.socket(for: data)
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, ControlSocket.status(socket) != nil {
            Thread.sleep(forTimeInterval: 0.5)
        }
    }
}
