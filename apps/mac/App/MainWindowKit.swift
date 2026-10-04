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

/// The five-minute sign-in link `buddi` prints, for the window.
///
/// The same launcher call as the menu's Open in Browser (`buddi --no-service
/// --no-open`, see `Supervisor.openDashboard`), but the link comes back here
/// instead of going to the default browser. `--no-service`: if the supervisor
/// turned out not to be this app's, the launcher must never install a
/// LaunchAgent in its place. `BUDDI_WEB_PORT` is left out on purpose: for this
/// command a different port means "move the dashboard".
enum DashboardLink {
    static func fetch(layout: BundleLayout, data: URL) async -> Result<URL, LinkFailure> {
        await Task.detached { () -> Result<URL, LinkFailure> in
            let process = Process()
            process.executableURL = layout.node
            process.arguments = [layout.launcher.path, "--no-service", "--no-open"]
            process.environment = environment(layout: layout, data: data)
            process.currentDirectoryURL = data
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.standardInput = FileHandle.nullDevice
            do { try process.run() } catch { return .failure(LinkFailure(description: "\(error)")) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 45) { if process.isRunning { process.terminate() } }
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            process.waitUntilExit()
            if let line = output.split(separator: "\n").first(where: { $0.hasPrefix("Dashboard: ") }),
               let url = URL(string: String(line.dropFirst("Dashboard: ".count)).trimmingCharacters(in: .whitespaces)) {
                return .success(url)
            }
            return .failure(LinkFailure(description: output.isEmpty ? "No answer within 45 seconds." : String(output.suffix(600))))
        }.value
    }

    struct LinkFailure: Error, CustomStringConvertible { let description: String }

    /// launchd's minimal environment, as the supervisor's own (`Supervisor.environment`).
    private static func environment(layout: BundleLayout, data: URL) -> [String: String] {
        let source = ProcessInfo.processInfo.environment
        var env: [String: String] = [:]
        for key in ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"] {
            if let value = source[key] { env[key] = value }
        }
        env["BUDDI_DATA_DIR"] = data.path
        env["BUDDI_APP_LAYOUT"] = BundleLayout.releases(for: data).path
        env["PATH"] = [layout.runtimeDir.path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        return env
    }
}
