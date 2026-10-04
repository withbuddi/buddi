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
    /// Before pre.41 a "Not Now" was kept for good in this defaults key, and the
    /// offer never came back at launch. It is cleared now, and read no more.
    private static let declinedKey = "declinedNpmTakeover"

    /// "Not Now" holds for this launch only: the next launch asks again.
    private static var declinedThisLaunch = false

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

    static var declined: Bool { declinedThisLaunch }

    /// The one dialog. Asked once on launch; afterwards the menu offers it.
    /// Returns true when the owner chose to take over (and it worked).
    static func offer(data: URL, plist: URL, fromMenu: Bool = false) -> Bool {
        UserDefaults.standard.removeObject(forKey: declinedKey)
        if !fromMenu && declined { return false }
        let alert = NSAlert()
        alert.messageText = "Run your buddi from the app?"
        alert.informativeText = """
            buddi is already installed on this Mac with npm, and runs in the background on its own. \
            The app can take over: it stops that background service and runs the same buddi itself. \
            Your agents, chats, settings and passwords stay exactly where they are.

            Afterwards, the npm copy is unused. You can remove it whenever you like with:
            npm rm -g @withbuddi/buddi

            Not Now leaves the npm copy running buddi as it is; the app asks again next time it opens.
            """
        alert.addButton(withTitle: "Take Over")
        alert.addButton(withTitle: "Not Now")
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else {
            declinedThisLaunch = true
            return false
        }
        do {
            try takeOver(data: data, plist: plist)
            declinedThisLaunch = false
            return true
        } catch {
            let failed = NSAlert()
            failed.messageText = "buddi could not take over"
            failed.informativeText = "\(error.localizedDescription)\n\nNothing was removed. The npm service keeps running buddi."
            failed.runModal()
            return false
        }
    }

    enum TakeOverError: LocalizedError {
        case bootout(Int32)
        case stillAnswering(restarted: Bool)
        var errorDescription: String? {
            switch self {
            case .bootout(let status):
                return "macOS would not stop the npm service (launchctl status \(status))."
            case .stillAnswering(let restarted):
                return "The npm service's buddi was still running after 20 seconds, so the app left it in place"
                    + (restarted ? " and started its service again." : ".")
            }
        }
    }

    /// How long the old supervisor gets to let go of the socket after bootout.
    static let socketWait: TimeInterval = 20

    /// `launchctl bootout` stops the supervisor (SIGTERM: gateway, then the
    /// database) and unloads the job. Only once its control socket has gone
    /// silent does the plist move out of LaunchAgents: an old supervisor still
    /// answering keeps its plist, its service is loaded again, and the owner is
    /// told, rather than two supervisors racing for one data directory.
    static func takeOver(data: URL, plist: URL) throws {
        let label = DataDirectory.launchAgentLabel(for: data)
        let status = launchctl(["bootout", "gui/\(getuid())/\(label)"])
        guard SupervisorPolicy.bootoutStopped(status) else { throw TakeOverError.bootout(status) }

        let socket = DataDirectory.socket(for: data)
        let deadline = Date().addingTimeInterval(socketWait)
        while Date() < deadline, ControlSocket.status(socket) != nil {
            Thread.sleep(forTimeInterval: 0.5)
        }
        if ControlSocket.status(socket) != nil {
            // Put the service back as it was: loaded again from the plist it kept.
            let restarted = status == 0 && launchctl(["bootstrap", "gui/\(getuid())", plist.path]) == 0
            NSLog("buddi: the npm service still answered \(Int(socketWait)) s after bootout; left in place (reloaded: \(restarted))")
            throw TakeOverError.stillAnswering(restarted: restarted)
        }

        let kept = data.appendingPathComponent("launchagent-from-npm.plist")
        try? FileManager.default.removeItem(at: kept)
        try FileManager.default.moveItem(at: plist, to: kept)
    }

    private static func launchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }
}
