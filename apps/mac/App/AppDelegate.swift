import AppKit
import Sparkle

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItemController: StatusItemController?
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
        statusItemController = StatusItemController(supervisor: supervisor, appDelegate: self)

        if let plist = Adoption.npmService(data: supervisor.data) {
            _ = Adoption.offer(data: supervisor.data, plist: plist)
        }
        supervisor.start()
    }

    /// From the menu, while an npm install's service still holds the data directory.
    func takeOverFromNpm() {
        guard let plist = Adoption.npmService(data: supervisor.data) else { return }
        if Adoption.offer(data: supervisor.data, plist: plist, fromMenu: true) {
            supervisor.start()
        }
    }

    func checkForAppUpdates() {
        guard AppDelegate.sparkleConfigured else { return }
        updaterController.checkForUpdates(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        supervisor.shutdown {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
