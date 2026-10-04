import CryptoKit
import Foundation

/// Where the pieces sit inside buddi.app (see apps/mac/README.md):
///
///     Contents/Resources/runtime/node              the bundled Node (universal)
///     Contents/Resources/buddi/current             -> buddi-<version>/
///     Contents/Resources/buddi/buddi-<version>/    the npm tarball, unpacked
///
/// Paths are resolved with realpath(3), the way Node resolves its own entry and
/// `process.execPath`: the supervisor reports both in `/status`, and the app
/// compares them to know the supervisor answering is its own.
struct BundleLayout: Sendable {
    let runtimeDir: URL
    let node: URL
    /// The release root the `current` link points at, resolved.
    let release: URL
    let launcher: URL
    let version: String

    enum Problem: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what): return "This copy of buddi.app is incomplete: \(what) is missing. Download it again."
            }
        }
    }

    static func locate(in bundle: Bundle = .main) throws -> BundleLayout {
        guard let resources = bundle.resourceURL else { throw Problem.missing("Contents/Resources") }
        let runtime = resources.appendingPathComponent("runtime")
        guard let node = realPath(runtime.appendingPathComponent("node")) else { throw Problem.missing("the Node runtime") }
        guard let release = realPath(resources.appendingPathComponent("buddi/current")) else { throw Problem.missing("the buddi release") }
        let launcher = release.appendingPathComponent("packages/install/dist/launcher.js")
        guard FileManager.default.fileExists(atPath: launcher.path) else { throw Problem.missing("the buddi launcher") }
        let version = (try? JSONSerialization.jsonObject(with: Data(contentsOf: release.appendingPathComponent("package.json"))))
            .flatMap { ($0 as? [String: Any])?["version"] as? String } ?? release.lastPathComponent
        return BundleLayout(runtimeDir: runtime, node: node, release: release, launcher: launcher, version: version)
    }
}

func realPath(_ url: URL) -> URL? {
    guard let resolved = realpath(url.path, nil) else { return nil }
    defer { free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved))
}

/// The data directory and the names derived from it, computed exactly as
/// packages/install/src/environment.ts does, so the app is one more packaged
/// installation: same directory, same keychain namespace, same LaunchAgent label.
enum DataDirectory {
    /// `BUDDI_DATA_DIR` when the app was started with one (local testing), else
    /// `~/Library/Application Support/buddi` — `defaultDataDir` on darwin.
    static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override = environment["BUDDI_DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override).standardizedFileURL
        }
        let home = environment["HOME"] ?? NSHomeDirectory()
        return URL(fileURLWithPath: home)
            .appendingPathComponent("Library/Application Support/buddi", isDirectory: true)
            .standardizedFileURL
    }

    /// `launchAgentLabel(data)`: what `buddi` (from npm) installs its service as.
    static func launchAgentLabel(for data: URL) -> String {
        "com.buddi.install.\(sha256Hex(path(data)).prefix(12))"
    }

    /// `BUDDI_VAULT_SERVICE`: the keychain namespace. The gateway computes it
    /// itself; the app only shows it in diagnostics and never reads a secret.
    static func vaultService(for data: URL) -> String {
        "buddi.install.\(sha256Hex(path(data)).prefix(20))"
    }

    static func launchAgentPlist(for data: URL, home: String = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel(for: data)).plist")
    }

    static func socket(for data: URL) -> String { data.appendingPathComponent("supervisor.sock").path }
    static func logs(for data: URL) -> URL { data.appendingPathComponent("logs", isDirectory: true) }

    /// Node's `path.join`/`path.resolve` never leave a trailing slash.
    private static func path(_ url: URL) -> String {
        var p = url.path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }

    private static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
