import CryptoKit
import Foundation

/// Where the pieces sit inside buddi.app (see apps/mac/README.md):
///
///     Contents/Resources/runtime/node              the bundled Node (universal)
///     Contents/Resources/buddi/current             -> buddi-<version>/
///     Contents/Resources/buddi/buddi-<version>/    the npm tarball, unpacked
///
/// and the releases buddi installed for itself since, outside the signed bundle
/// (`packages/install/src/app-layout.ts`):
///
///     <data>/releases/current      -> the release root to run
///     <data>/releases/previous     -> the one that ran before it
///     <data>/releases/bundle-seen  the bundle's buddi version when `current` was last chosen
///
/// The app runs `current` when it exists, and the bundle's copy otherwise. A
/// newer app (Sparkle, a new DMG) carries a newer buddi than `current`: the first
/// launch that sees it moves `current` to the bundle's copy, once, so a rollback
/// the owner chose afterwards is not undone at every launch.
///
/// Paths are resolved with realpath(3), the way Node resolves its own entry and
/// `process.execPath`: the supervisor reports both in `/status`, and the app
/// compares them to know the supervisor answering is its own.
struct BundleLayout: Sendable {
    let runtimeDir: URL
    let node: URL
    /// The release root the app runs, resolved: `current`, or the bundle's copy.
    let release: URL
    let launcher: URL
    let version: String
    /// The bundle's own copy, resolved. Never written to; always the fallback.
    let bundleRelease: URL
    /// Where buddi puts the releases it installs (`BUDDI_APP_LAYOUT`).
    let releases: URL

    enum Problem: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what): return "This copy of buddi.app is incomplete: \(what) is missing. Download it again."
            }
        }
    }

    static func releases(for data: URL) -> URL { data.appendingPathComponent("releases", isDirectory: true) }

    static func locate(in bundle: Bundle = .main, data: URL) throws -> BundleLayout {
        guard let resources = bundle.resourceURL else { throw Problem.missing("Contents/Resources") }
        let runtime = resources.appendingPathComponent("runtime")
        guard let node = realPath(runtime.appendingPathComponent("node")) else { throw Problem.missing("the Node runtime") }
        guard let bundled = realPath(resources.appendingPathComponent("buddi/current")) else { throw Problem.missing("the buddi release") }
        guard runnable(bundled) else { throw Problem.missing("the buddi launcher") }
        let releases = releases(for: data)
        let release = choose(bundled: bundled, releases: releases)
        return BundleLayout(runtimeDir: runtime, node: node, release: release,
                            launcher: release.appendingPathComponent("packages/install/dist/launcher.js"),
                            version: version(of: release), bundleRelease: bundled, releases: releases)
    }

    /// `current` when it holds a runnable release, unless the app was replaced by
    /// one carrying a newer buddi since `current` was last chosen.
    private static func choose(bundled: URL, releases: URL) -> URL {
        let currentLink = releases.appendingPathComponent("current")
        guard let current = realPath(currentLink), runnable(current) else { return bundled }
        let seenFile = releases.appendingPathComponent("bundle-seen")
        let bundledVersion = version(of: bundled)
        let seen = (try? String(contentsOf: seenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard seen != bundledVersion else { return current }
        try? (bundledVersion + "\n").write(to: seenFile, atomically: true, encoding: .utf8)
        guard ReleaseVersion.isNewer(bundledVersion, than: version(of: current)) else { return current }
        try? pointLink(releases.appendingPathComponent("previous"), at: current)
        try? pointLink(currentLink, at: bundled)
        return bundled
    }

    /// The release "Restart with the Previous Version" goes back to: `previous`,
    /// or the bundle's copy when buddi runs a release of its own and no
    /// `previous` is left. Nil when there is nothing else to run.
    func rollbackTarget() -> URL? {
        if let previous = realPath(releases.appendingPathComponent("previous")), previous != release, Self.runnable(previous) {
            return previous
        }
        return bundleRelease != release ? bundleRelease : nil
    }

    /// Make `target` current and what runs now previous. Written while the
    /// supervisor is stopped, so the next start runs `target`.
    func rollBack(to target: URL) throws {
        try FileManager.default.createDirectory(at: releases, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Self.pointLink(releases.appendingPathComponent("previous"), at: release)
        try Self.pointLink(releases.appendingPathComponent("current"), at: target)
        // The owner chose this: the bundle's buddi is not "new" at the next launch.
        try? (Self.version(of: bundleRelease) + "\n").write(to: releases.appendingPathComponent("bundle-seen"), atomically: true, encoding: .utf8)
    }

    static func runnable(_ root: URL) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent("packages/install/dist/launcher.js").path)
    }

    static func version(of root: URL) -> String {
        (try? JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("package.json"))))
            .flatMap { ($0 as? [String: Any])?["version"] as? String } ?? root.lastPathComponent
    }

    /// Replace a symlink with one rename(2), so nobody ever sees it missing.
    static func pointLink(_ link: URL, at target: URL) throws {
        let tmp = link.deletingLastPathComponent().appendingPathComponent(".\(link.lastPathComponent).tmp-\(getpid())")
        try? FileManager.default.removeItem(at: tmp)
        try FileManager.default.createSymbolicLink(atPath: tmp.path, withDestinationPath: target.path)
        guard rename(tmp.path, link.path) == 0 else {
            try? FileManager.default.removeItem(at: tmp)
            throw CocoaError(.fileWriteUnknown)
        }
    }
}

/// buddi's versions as numbers, the mapping `scripts/release/bundle-version.mjs`
/// gives CFBundleVersion: `0.1.0-pre.39` is 0.1.0.39 and a final `0.1.0` is
/// 0.1.0.1000, above every pre-release of it. Anything else is not comparable.
enum ReleaseVersion {
    static func numbers(_ version: String) -> [Int]? {
        let parts = version.split(separator: "-", maxSplits: 1).map(String.init)
        guard let head = parts.first else { return nil }
        let fields = head.split(separator: ".", omittingEmptySubsequences: false)
        let core = fields.compactMap { Int($0) }
        guard fields.count == 3, core.count == 3 else { return nil }
        if parts.count == 1 { return core + [1000] }
        let pre = parts[1]
        guard pre.hasPrefix("pre."), let n = Int(pre.dropFirst(4)), n >= 1, n < 1000 else { return nil }
        return core + [n]
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        guard let x = numbers(a), let y = numbers(b) else { return false }
        return y.lexicographicallyPrecedes(x)
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
