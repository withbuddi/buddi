import Foundation

/// The decisions the supervisor and the takeover make, apart from the processes
/// they act on, so they can be tested on their own (Tests/SupervisorPolicyTests.swift).
enum SupervisorPolicy {
    /// `launchctl bootout` stopped the job (0), or there was none loaded (3, "No
    /// such process"). Anything else and the npm service may still be running.
    static func bootoutStopped(_ status: Int32) -> Bool { status == 0 || status == 3 }

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
