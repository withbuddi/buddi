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

    /// The query the route keeps, re-encoded; a `code` only as six digits. Nil refuses the link.
    private static func query(_ items: [URLQueryItem]) -> String? {
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
