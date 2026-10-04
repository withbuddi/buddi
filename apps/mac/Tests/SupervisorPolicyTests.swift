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
