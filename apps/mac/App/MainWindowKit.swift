import AppKit
import Foundation

/// buddi's design tokens (packages/web/src/tokens.css), for the few things the
/// app draws itself: the window's ground, the titlebar strip and the
/// "Starting buddi…" placeholder. Light and dark follow the system, as the
/// dashboard does unless the owner picked one in Settings → Appearance.
enum Kit {
    /// `--bg`: the blue ground.
    static let background = dynamic(light: 0xEEF4FD, dark: 0x0C1627)
    /// `--text`.
    static let text = dynamic(light: 0x152642, dark: 0xECF1F8)
    /// `--text-muted`.
    static let textMuted = dynamic(light: 0x5A6477, dark: 0xA3ADBE)
    /// `--accent`.
    static let accent = dynamic(light: 0x2B6FE6, dark: 0x7DB3FF)

    private static func dynamic(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return rgb(isDark ? dark : light)
        }
    }

    private static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// The dashboard's fixed places (packages/web/src/routes.ts) and the links the
/// Help menu opens.
enum DashboardRoutes {
    static let settings = "#/settings"
    static let docs = URL(string: "https://withbuddi.com/docs/")!
    static let reportProblem = URL(string: "https://github.com/withbuddi/buddi/issues/new")!
}
