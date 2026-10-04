import XCTest

final class BuddiLinkTests: XCTestCase {
    private func parse(_ text: String) -> BuddiLink? { URL(string: text).flatMap(BuddiLink.parse) }

    func testOpenBringsTheWindowForward() {
        XCTAssertEqual(parse("buddi://open"), .open)
        XCTAssertEqual(parse("BUDDI://open"), .open)
        XCTAssertEqual(parse("buddi://open/"), .open)
    }

    func testSettingsAndOnePage() {
        XCTAssertEqual(parse("buddi://settings"), .route("#/settings"))
        XCTAssertEqual(parse("buddi://settings/browser"), .route("#/settings/browser"))
        XCTAssertEqual(parse("buddi://settings/p.computer"), .route("#/settings/p.computer"))
    }

    func testThePairingCodeIsCarriedOverAsSixDigits() {
        XCTAssertEqual(parse("buddi://settings/browser?code=123456"), .route("#/settings/browser?code=123456"))
        XCTAssertEqual(parse("buddi://settings/browser?code=123%20456"), .route("#/settings/browser?code=123456"))
        XCTAssertEqual(parse("buddi://settings/plugins?tab=browse&kind=plugins"), .route("#/settings/plugins?tab=browse&kind=plugins"))
    }

    func testAQueryValueIsReEncodedNotPassedThrough() {
        XCTAssertEqual(parse("buddi://settings/connections?connection=a%27b%22c"), .route("#/settings/connections?connection=a'b%22c"))
    }

    func testEverythingElseIsRefused() {
        for text in [
            "buddi://", "buddi://chat", "buddi://settings/browser/extra", "buddi://settings/Browser",
            "buddi://settings/../x", "buddi://settings/browser?code=12345", "buddi://settings/browser?code=abcdef",
            "buddi://settings/browser#/chat", "buddi://user@settings/browser", "buddi://settings:80/browser",
            "buddi://open?x=1", "buddi://settings?x=1", "buddi://settings/browser?a-b=1",
            "https://settings/browser", "buddi:settings",
        ] {
            XCTAssertNil(parse(text), text)
        }
    }

    func testAtMostEightQueryItems() {
        let eight = (1...8).map { "k\($0)=v" }.joined(separator: "&")
        XCTAssertNotNil(parse("buddi://settings/plugins?" + eight))
        XCTAssertNil(parse("buddi://settings/plugins?" + eight + "&k9=v"))
        XCTAssertEqual(BuddiLink.maxQueryItems, 8)
    }

    func testASavedRouteLosesItsPairingCode() {
        XCTAssertEqual(BuddiLink.routeWithoutCode("#/settings/browser?code=123456"), "#/settings/browser")
        XCTAssertEqual(BuddiLink.routeWithoutCode("#/settings/computer?x=1&code=123456"), "#/settings/computer?x=1")
        XCTAssertEqual(BuddiLink.routeWithoutCode("#/settings/plugins?tab=browse"), "#/settings/plugins?tab=browse")
        XCTAssertEqual(BuddiLink.routeWithoutCode("#/chat"), "#/chat")
    }
}

final class PendingRouteTests: XCTestCase {
    func testARouteAskedBeforeTheLoadGoesIntoTheURL() {
        var pending = PendingRoute()
        pending.ask("#/settings/browser?code=123456")
        XCTAssertEqual(pending.takeForLoad(), "#/settings/browser?code=123456")
        XCTAssertNil(pending.takeOnReveal())
    }

    func testALinkArrivingDuringTheLoadIsAppliedWhenItFinishes() {
        var pending = PendingRoute()
        XCTAssertNil(pending.takeForLoad())
        pending.ask("#/settings/browser?code=123456")
        XCTAssertEqual(pending.takeOnReveal(), "#/settings/browser?code=123456")
        XCTAssertNil(pending.takeOnReveal())
    }

    func testTheSavedRouteKeepsAnAskedOneAndDropsTheCode() {
        var pending = PendingRoute()
        pending.remember("#/settings/browser?code=123456")
        XCTAssertEqual(pending.route, "#/settings/browser")
        pending.remember("#/chat")
        XCTAssertEqual(pending.route, "#/settings/browser")
        var asked = PendingRoute()
        asked.ask("#/chat")
        asked.remember("#/settings")
        XCTAssertEqual(asked.takeForLoad(), "#/chat")
    }
}
