import XCTest

final class SupervisorPolicyTests: XCTestCase {
    func testOneRestartExitIsAnUpgradeTheSecondWithinAMinuteIsNot() {
        var throttle = RestartExitThrottle()
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(throttle.allowsImmediateRestart(at: t0))
        XCTAssertFalse(throttle.allowsImmediateRestart(at: t0.addingTimeInterval(5)))
        XCTAssertFalse(throttle.allowsImmediateRestart(at: t0.addingTimeInterval(10)))
    }

    func testRestartExitsAMinuteApartAreEachAnUpgrade() {
        var throttle = RestartExitThrottle()
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(throttle.allowsImmediateRestart(at: t0))
        XCTAssertTrue(throttle.allowsImmediateRestart(at: t0.addingTimeInterval(61)))
        XCTAssertTrue(throttle.allowsImmediateRestart(at: t0.addingTimeInterval(130)))
    }

    func testRunningResetsTheCount() {
        var throttle = RestartExitThrottle()
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(throttle.allowsImmediateRestart(at: t0))
        throttle.reset()
        XCTAssertTrue(throttle.allowsImmediateRestart(at: t0.addingTimeInterval(5)))
    }

    func testBootoutCountsAsStoppedOnlyForZeroOrNotLoaded() {
        XCTAssertTrue(SupervisorPolicy.bootoutStopped(0))
        XCTAssertTrue(SupervisorPolicy.bootoutStopped(3))
        XCTAssertFalse(SupervisorPolicy.bootoutStopped(5))
        XCTAssertFalse(SupervisorPolicy.bootoutStopped(113))
        XCTAssertFalse(SupervisorPolicy.bootoutStopped(1))
    }

    func testASupervisorOnAnotherReleaseIsReplaced() {
        let bundled = "/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.1"
        XCTAssertTrue(SupervisorPolicy.runsOtherRelease(installRoot: "/Users/me/Library/Application Support/buddi/releases/buddi-0.1.0/node_modules/@withbuddi/buddi", chosen: bundled))
        XCTAssertFalse(SupervisorPolicy.runsOtherRelease(installRoot: bundled, chosen: bundled))
    }
}

final class AnotherBuddiTests: XCTestCase {
    func testTheWindowOffersTakeOverAndSaysTheNpmCopyKeepsRunning() {
        let words = SupervisorPolicy.anotherBuddi(canTakeOver: true)
        XCTAssertEqual(words.title, "Another buddi is already running")
        XCTAssertTrue(words.detail.contains("Take Over"))
        XCTAssertTrue(words.detail.contains("the npm copy keeps running buddi"))
        let stuck = SupervisorPolicy.anotherBuddi(canTakeOver: false)
        XCTAssertFalse(stuck.detail.contains("Take Over"))
        XCTAssertTrue(stuck.detail.contains("the npm copy keeps running buddi"))
    }
}

final class UninstallPolicyTests: XCTestCase {
    func testOnlyACleanUninstallTrashesTheAppAndQuits() {
        XCTAssertEqual(UninstallPolicy.afterwards(status: 0, output: "Removed."), .trashAndQuit)
        XCTAssertEqual(UninstallPolicy.afterwards(status: 1, output: "Could not remove the keychain entries.\n"),
                       .keepApp(reason: "Could not remove the keychain entries."))
        XCTAssertEqual(UninstallPolicy.afterwards(status: -1, output: ""),
                       .keepApp(reason: "buddi uninstall stopped with status -1 and said nothing."))
        guard case .keepApp(let long) = UninstallPolicy.afterwards(status: 1, output: String(repeating: "x", count: 5000)) else { return XCTFail() }
        XCTAssertEqual(long.count, 1200)
    }

    func testTheLauncherRunsWithTheBackupAndTheWordsAlreadyTakenCareOf() {
        XCTAssertEqual(UninstallPolicy.launcherArguments(keepData: false), ["uninstall", "--yes", "--no-backup", "--i-have-the-passphrase"])
        XCTAssertEqual(UninstallPolicy.launcherArguments(keepData: true).last, "--keep-data")
    }

    func testTheRequestSaysWhetherToKeepTheData() {
        XCTAssertEqual(UninstallPolicy.keepData(fromRequest: Data(#"{"keepData":true,"at":"x"}"#.utf8)), true)
        XCTAssertEqual(UninstallPolicy.keepData(fromRequest: Data(#"{"at":"x"}"#.utf8)), false)
        XCTAssertNil(UninstallPolicy.keepData(fromRequest: Data("nope".utf8)))
    }

    func testTheBackupJobIsReadAsRunningDoneOrFailed() {
        XCTAssertEqual(UninstallPolicy.jobState(from: Data(#"{"phase":"backup","detail":"dumping"}"#.utf8)), .running("dumping"))
        XCTAssertEqual(UninstallPolicy.jobState(from: Data(#"{"phase":"failed","error":"disk full","finishedAt":"t"}"#.utf8)), .failed("disk full"))
        let done = UninstallPolicy.jobState(from: Data(#"{"phase":"done","finishedAt":"t","report":{"archive":"/a.age","passphraseFile":"/a.age.passphrase.txt","passphrase":"six words"}}"#.utf8))
        XCTAssertEqual(done, .done(.init(archive: "/a.age", passphraseFile: "/a.age.passphrase.txt", passphrase: "six words")))
    }

    func testRemoveWaitsForIWroteItDownWhenThereAreWords() {
        let locked = UninstallPolicy.BackupReport(archive: "/a.age", passphraseFile: nil, passphrase: "six words")
        XCTAssertFalse(UninstallPolicy.mayRemove(report: locked, wroteItDown: false))
        XCTAssertTrue(UninstallPolicy.mayRemove(report: locked, wroteItDown: true))
        XCTAssertTrue(UninstallPolicy.mayRemove(report: .init(archive: "/a", passphraseFile: nil, passphrase: nil), wroteItDown: false))
    }

    func testTheUninstallExitIsNotTheUpgradeExit() {
        XCTAssertEqual(UninstallPolicy.exitStatus, 76)
        XCTAssertNotEqual(UninstallPolicy.exitStatus, 75)
    }
}

final class UpdatePolicyTests: XCTestCase {
    func testANewerBuddiIsSaidOncePerVersion() {
        XCTAssertTrue(UpdatePolicy.shouldAlert(updateAvailable: true, latest: "0.1.0-pre.41", alerted: nil))
        XCTAssertFalse(UpdatePolicy.shouldAlert(updateAvailable: true, latest: "0.1.0-pre.41", alerted: "0.1.0-pre.41"))
        XCTAssertTrue(UpdatePolicy.shouldAlert(updateAvailable: true, latest: "0.1.0-pre.42", alerted: "0.1.0-pre.41"))
        XCTAssertFalse(UpdatePolicy.shouldAlert(updateAvailable: false, latest: "0.1.0-pre.42", alerted: nil))
        XCTAssertFalse(UpdatePolicy.shouldAlert(updateAvailable: true, latest: nil, alerted: nil))
    }
}
