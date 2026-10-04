import Foundation

/// `buddi://` links, read into a dashboard route.
///
/// The scheme is how a page outside the app (the Chrome extension's popup, the
/// signed-out page) hands the owner to the window instead of a browser tab.
/// Only three shapes are understood, and anything else is refused rather than
/// guessed at, because a link can come from any page on the web:
///
///   buddi://open                       the window, where it was
///   buddi://settings                   Settings
///   buddi://settings/<page>?<query>    one Settings page, its query carried over
///
/// `buddi://settings/browser?code=123456` pre-fills the pairing code on the
/// Your Chrome row; the owner still presses Pair. Foundation only, so the
/// logic tests compile it without the app.
enum BuddiLink: Equatable {
    /// Bring the window forward and leave it on its route.
    case open
    /// Bring the window forward on this hash (`#/settings/browser?code=123456`).
    case route(String)

    static let scheme = "buddi"

    /// A Settings page id as the dashboard writes it: `computer`, `plugins`, `p.computer`.
    private static func isPage(_ text: String) -> Bool {
        guard let first = text.unicodeScalars.first, text.count <= 64 else { return false }
        let start = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789")
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
        return start.contains(first) && text.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// At most this many query items; a link with more is refused.
    static let maxQueryItems = 8

    /// The query the route keeps, re-encoded; a `code` only as six digits. Nil refuses the link.
    private static func query(_ items: [URLQueryItem]) -> String? {
        guard items.count <= maxQueryItems else { return nil }
        let name = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        var kept: [URLQueryItem] = []
        for item in items {
            guard !item.name.isEmpty, item.name.count <= 32,
                  item.name.unicodeScalars.allSatisfy({ name.contains($0) }) else { return nil }
            var value = item.value ?? ""
            if item.name == "code" {
                value = value.filter { $0 == " " || $0 == "-" ? false : true }
                guard value.count == 6, value.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            }
            guard value.count <= 256 else { return nil }
            kept.append(URLQueryItem(name: item.name, value: value))
        }
        guard !kept.isEmpty else { return "" }
        var components = URLComponents()
        components.queryItems = kept
        return components.percentEncodedQuery.map { "?" + $0 }
    }

    /// A route the window saved from its own page (to come back to after a
    /// restart or a crash), without a pairing code: a code is used once, and a
    /// restored route must not type a dead one in again. Other parameters stay.
    static func routeWithoutCode(_ route: String) -> String {
        guard let mark = route.firstIndex(of: "?") else { return route }
        let path = String(route[..<mark])
        guard path.hasPrefix("#/settings/"),
              var components = URLComponents(string: "x:?" + route[route.index(after: mark)...]),
              let items = components.queryItems, items.contains(where: { $0.name == "code" }) else { return route }
        let kept = items.filter { $0.name != "code" }
        if kept.isEmpty { return path }
        components.queryItems = kept
        return path + "?" + (components.percentEncodedQuery ?? "")
    }

    /// The link, or nil for anything this app does not answer.
    static func parse(_ url: URL) -> BuddiLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == scheme,
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil,
              let host = components.host?.lowercased() else { return nil }
        let parts = components.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        switch host {
        case "open":
            guard parts.isEmpty, components.query == nil else { return nil }
            return .open
        case "settings":
            guard parts.count <= 1 else { return nil }
            guard let page = parts.first else {
                return components.query == nil ? .route("#/settings") : nil
            }
            guard isPage(page), let query = query(components.queryItems ?? []) else { return nil }
            return .route("#/settings/\(page)\(query)")
        default:
            return nil
        }
    }
}

/// The route the window should land on, across a load.
///
/// A route can arrive (a `buddi://` link, a menu command) before the page has
/// loaded. Asked for before the load starts, it goes into the URL being
/// loaded; asked for while the load is under way, it is kept and applied when
/// the navigation finishes, instead of being dropped as the window is
/// revealed. Foundation only, for the logic tests.
struct PendingRoute: Equatable {
    private(set) var route: String?

    /// A route to land on once the page is there.
    mutating func ask(_ route: String) { self.route = route }

    /// A route saved from the page itself, unless one was already asked for.
    mutating func remember(_ route: String) { if self.route == nil { self.route = BuddiLink.routeWithoutCode(route) } }

    /// The route to fold into the URL a load starts with; taken, so a later one is told apart.
    mutating func takeForLoad() -> String? { defer { route = nil }; return route }

    /// When the navigation finishes: a route that arrived during the load, to apply now.
    mutating func takeOnReveal() -> String? { defer { route = nil }; return route }
}
