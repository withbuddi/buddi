import Foundation

/// The decisions the supervisor and the takeover make, apart from the processes
/// they act on, so they can be tested on their own (Tests/SupervisorPolicyTests.swift).
enum SupervisorPolicy {
    /// `launchctl bootout` stopped the job (0), or there was none loaded (3, "No
    /// such process"). Anything else and the npm service may still be running.
    static func bootoutStopped(_ status: Int32) -> Bool { status == 0 || status == 3 }

    /// The window's words while npm's buddi holds the data folder: what is going
    /// on, that nothing is lost by waiting, and what Take Over does.
    static func anotherBuddi(canTakeOver: Bool) -> (title: String, detail: String) {
        let meanwhile = "Until then, the npm copy keeps running buddi; your agents and chats are the same either way."
        guard canTakeOver else {
            return ("Another buddi is already running", "A buddi started outside the app holds this Mac's buddi folder. Stop it (buddi service stop in Terminal), then restart the app. " + meanwhile)
        }
        return ("Another buddi is already running", "buddi from npm runs in the background on this Mac with the same data. Take Over stops that service and runs buddi from the app. " + meanwhile)
    }

    /// A supervisor already answering runs a different release than the one this
    /// app chose (a newer bundle's first launch moved `current`): replace it.
    static func runsOtherRelease(installRoot: String, chosen: String) -> Bool {
        installRoot != chosen
    }
}

/// Exit 75 (`APP_RESTART_EXIT`) means "start me again from `current`, now": an
/// upgrade switched releases. One is an upgrade; a second within a minute is a
/// release that exits 75 as it starts, and respawning it at once for ever would
/// spin. So the second one inside the window is treated like any other exit:
/// backoff, and the menu says buddi needs attention.
struct RestartExitThrottle {
    let window: TimeInterval
    private(set) var recent: [Date] = []

    init(window: TimeInterval = 60) { self.window = window }

    /// Record an exit 75 at `now`. True when it may be respawned at once.
    mutating func allowsImmediateRestart(at now: Date) -> Bool {
        recent = recent.filter { now.timeIntervalSince($0) < window }
        recent.append(now)
        return recent.count < 2
    }

    /// buddi ran: the next exit 75 is an upgrade again.
    mutating func reset() { recent = [] }
}

/// Uninstall from the product (packages/install/src/product-uninstall.ts): the
/// supervisor exits with `exitStatus` after writing `<data>/uninstall.json`, and
/// the app runs the launcher's `buddi uninstall` with `launcherArguments`, then
/// moves itself to the Trash and quits. The native menu item goes the same way.
enum UninstallPolicy {
    /// `APP_UNINSTALL_EXIT` in product-uninstall.ts.
    static let exitStatus: Int32 = 76
    static let requestFile = "uninstall.json"

    /// The backup and the passphrase are taken care of before this runs.
    static func launcherArguments(keepData: Bool) -> [String] {
        ["uninstall", "--yes", "--no-backup", "--i-have-the-passphrase"] + (keepData ? ["--keep-data"] : [])
    }

    /// `{ keepData, at }` as the supervisor writes it; nil when it is not one.
    static func keepData(fromRequest data: Data) -> Bool? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["keepData"] as? Bool ?? false
    }

    /// The supervisor's last-backup job, as `/jobs/<id>` reports it.
    struct BackupReport: Equatable, Sendable {
        let archive: String
        let passphraseFile: String?
        let passphrase: String?
    }

    enum JobState: Equatable, Sendable {
        case running(String)
        case done(BackupReport)
        case failed(String)
    }

    static func jobState(from data: Data) -> JobState? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let phase = object["phase"] as? String else { return nil }
        guard object["finishedAt"] is String else { return .running((object["detail"] as? String) ?? phase) }
        guard phase == "done", let report = object["report"] as? [String: Any], let archive = report["archive"] as? String else {
            return .failed((object["error"] as? String) ?? "no reason given")
        }
        return .done(BackupReport(archive: archive, passphraseFile: report["passphraseFile"] as? String, passphrase: report["passphrase"] as? String))
    }

    /// "Remove buddi" is offered only once the words are with the owner: ticked, or there were none.
    static func mayRemove(report: BackupReport, wroteItDown: Bool) -> Bool {
        report.passphrase == nil || wroteItDown
    }
}
