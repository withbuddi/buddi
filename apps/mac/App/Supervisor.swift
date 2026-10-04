import AppKit
import Foundation

/// Runs buddi the way a packaged install does, with the app in launchd's place.
///
/// `buddi` from npm installs a LaunchAgent that runs
/// `node <root>/packages/install/dist/launcher.js supervise` with `BUDDI_DATA_DIR`
/// set, a minimal PATH, the data directory as working directory and both output
/// streams appended to `logs/supervisor.log` (`launchService` in launcher.ts).
/// The app starts exactly that command as its child. The supervisor already
/// owns everything below it — the embedded Postgres, the gateway child and its
/// restarts, backups, upgrades — and answers on `<data>/supervisor.sock`; the
/// app only keeps the supervisor itself alive and reads its status.
@MainActor
final class Supervisor {
    enum Health: Equatable {
        case starting
        case running(since: Date)
        case updating
        case attention(String)
        case stopped
    }

    let data: URL
    let layout: BundleLayout?
    private let layoutProblem: String?
    private var socket: String { DataDirectory.socket(for: data) }

    private(set) var health: Health = .stopped { didSet { if health != oldValue { onChange?() } } }
    /// Another installation's supervisor answering on this data directory
    /// (an npm install's service, say). The app never starts a second one.
    private(set) var foreign: ControlSocket.Status?
    private(set) var version: ControlSocket.Version?
    var onChange: (() -> Void)?

    private var child: Process?
    private var spawnedAt: Date?
    private var runningSince: Date?
    private var failures = 0
    private var respawn: DispatchWorkItem?
    private var poller: Timer?
    private var stopping = false
    private var polling = false
    private var firstRun = false
    private var openedFirstRun = false

    /// Slow first runs provision a Postgres cluster; after this long without a
    /// running gateway the menu says so instead of "Starting…" forever.
    private let patience: TimeInterval = 180

    init(data: URL = DataDirectory.resolve()) {
        self.data = data
        do {
            layout = try BundleLayout.locate()
            layoutProblem = nil
        } catch {
            layout = nil
            layoutProblem = "\(error)"
        }
    }

    // MARK: - Lifecycle

    func start() {
        guard layout != nil else {
            health = .attention(layoutProblem ?? "This copy of buddi.app is incomplete.")
            return
        }
        stopping = false
        firstRun = !FileManager.default.fileExists(atPath: data.appendingPathComponent("installation.json").path)
        health = .starting
        startPolling()
        let socket = self.socket
        Task.detached {
            let status = ControlSocket.status(socket)
            await MainActor.run {
                // A supervisor already answering is either ours from an earlier
                // session (an upgrade hands over to a detached successor) or
                // another installation's; either way, starting one more would
                // only lose the lock race.
                if let status { self.apply(status) } else { self.spawn() }
            }
        }
    }

    /// Restart buddi: the supervisor restarts its gateway; with no supervisor
    /// answering, the supervisor itself is started again at once.
    func restart() {
        guard layout != nil else { return }
        failures = 0
        runningSince = nil
        health = .starting
        let socket = self.socket
        Task.detached {
            let answered = (try? ControlSocket.request(socket, method: "POST", path: "/restart", timeout: 25)) != nil
            await MainActor.run {
                if !answered {
                    self.respawn?.cancel()
                    if self.child?.isRunning != true { self.spawn() }
                }
            }
        }
    }

    /// Stop buddi on Quit: SIGTERM is the supervisor's orderly shutdown (gateway,
    /// then the database). Waits up to 30 s off the main thread, then calls back.
    func shutdown(_ done: @escaping @MainActor () -> Void) {
        stopping = true
        respawn?.cancel()
        poller?.invalidate()
        let socket = self.socket
        var pid: pid_t?
        if let child, child.isRunning {
            pid = child.processIdentifier
        } else if foreign == nil, let status = ControlSocket.status(socket), isOurs(status) {
            pid = pid_t(status.supervisorPid)   // a successor an upgrade handed over to
        }
        guard let pid else { done(); return }
        kill(pid, SIGTERM)
        Task.detached {
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline {
                if kill(pid, 0) != 0 { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            await MainActor.run { done() }
        }
    }

    // MARK: - The child

    private func spawn() {
        guard let layout, !stopping else { return }
        respawn = nil
        let fm = FileManager.default
        let logs = DataDirectory.logs(for: data)
        do {
            try fm.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: data.path)
        } catch {
            health = .attention("buddi cannot create its folder at \(data.path): \(error.localizedDescription)")
            return
        }
        let logFile = logs.appendingPathComponent("supervisor.log")
        if !fm.fileExists(atPath: logFile.path) {
            fm.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try? FileHandle(forWritingTo: logFile)
        _ = try? log?.seekToEnd()

        let process = Process()
        process.executableURL = layout.node
        process.arguments = [layout.launcher.path, "supervise"]
        process.environment = environment(forService: true)
        process.currentDirectoryURL = data
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log ?? FileHandle.nullDevice
        process.standardError = log ?? FileHandle.nullDevice
        process.terminationHandler = { [weak self] ended in
            let status = ended.terminationStatus
            Task { @MainActor in self?.childEnded(status: status) }
        }
        do {
            try process.run()
            child = process
            spawnedAt = Date()
            if case .attention = health {} else { health = .starting }
        } catch {
            health = .attention("buddi could not start: \(error.localizedDescription)")
            scheduleRespawn()
        }
        try? log?.close()
    }

    private func childEnded(status: Int32) {
        child = nil
        guard !stopping else { health = .stopped; return }
        let socket = self.socket
        Task.detached {
            // A supervisor that exits during an upgrade has handed over to a
            // detached successor; give it a moment to take the socket.
            var answer: ControlSocket.Status?
            for _ in 0..<10 {
                answer = ControlSocket.status(socket)
                if answer != nil { break }
                try? await Task.sleep(for: .seconds(1))
            }
            await MainActor.run {
                if let answer { self.apply(answer); return }
                self.failures += 1
                NSLog("buddi: supervisor exited with status \(status) (failure \(self.failures))")
                if self.failures >= 4 {
                    self.health = .attention("buddi keeps stopping. The logs say why.")
                }
                self.scheduleRespawn()
            }
        }
    }

    /// `restartDelay` in supervisor.ts: 4 s, 8 s, 16 s, then every 30 s.
    private func scheduleRespawn() {
        guard !stopping else { return }
        let delay = min(30, 2 * pow(2, Double(min(failures, 4))))
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.spawn() }
        }
        respawn?.cancel()
        respawn = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// The service's environment, as the LaunchAgent gives it: launchd passes
    /// HOME, USER, LOGNAME, SHELL and TMPDIR plus the plist's own variables.
    /// `BUDDI_WEB_PORT` only matters on a first run (the state file wins after),
    /// and must not reach the one-shot `buddi` that prints the dashboard link:
    /// there a different port means "move the dashboard".
    private func environment(forService: Bool) -> [String: String] {
        let source = ProcessInfo.processInfo.environment
        var env: [String: String] = [:]
        for key in ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"] {
            if let value = source[key] { env[key] = value }
        }
        env["BUDDI_DATA_DIR"] = data.path
        if forService, let port = source["BUDDI_WEB_PORT"], !port.isEmpty { env["BUDDI_WEB_PORT"] = port }
        env["PATH"] = [layout?.runtimeDir.path ?? "", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        return env
    }

    // MARK: - Status

    private func startPolling() {
        poller?.invalidate()
        poller = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
    }

    private func poll() {
        guard !polling, !stopping else { return }
        polling = true
        let socket = self.socket
        Task.detached {
            let status = ControlSocket.status(socket)
            await MainActor.run {
                self.polling = false
                if let status { self.apply(status) } else { self.silent() }
            }
        }
    }

    func isOurs(_ status: ControlSocket.Status) -> Bool {
        guard let layout else { return false }
        return status.installRoot == layout.release.path && status.nodePath == layout.node.path
    }

    private func apply(_ status: ControlSocket.Status) {
        guard !stopping else { return }
        guard isOurs(status) else {
            foreign = status
            runningSince = nil
            health = .attention("Another buddi is already running on this Mac.")
            return
        }
        foreign = nil
        if status.upgrading == true {
            health = .updating
        } else if status.gateway == "running" {
            let since = runningSince ?? Date()
            runningSince = since
            if Date().timeIntervalSince(since) > 60 { failures = 0 }
            health = .running(since: since)
            if firstRun && !openedFirstRun {
                // First launch asks nothing: it opens the first-run chapters.
                openedFirstRun = true
                openDashboard()
            }
        } else {
            runningSince = nil
            let waited = Date().timeIntervalSince(spawnedAt ?? Date())
            if let phase = status.phase, phase.contains("failed") {
                health = .attention("buddi stopped after a failed \(phase.replacingOccurrences(of: "-failed", with: "")). Open buddi for the way back.")
            } else if waited > patience {
                health = .attention("buddi's gateway is \(status.gateway). Restart, or look at the logs.")
            } else {
                health = .starting
            }
        }
    }

    private func silent() {
        foreign = nil
        runningSince = nil
        if case .attention = health, child == nil { return }
        if child?.isRunning == true, Date().timeIntervalSince(spawnedAt ?? Date()) > patience {
            health = .attention("buddi did not finish starting. The logs say why.")
        } else if child?.isRunning == true || respawn != nil {
            if case .attention = health {} else { health = .starting }
        } else if child == nil, respawn == nil, !stopping {
            // Nobody answers and nothing is pending: a handed-over successor died.
            scheduleRespawn()
        }
    }

    // MARK: - Dashboard and updates

    /// Opens the dashboard with a fresh sign-in link. The link is the one
    /// `buddi` prints (a five-minute ticket minted from the install's web
    /// token), so the app asks the same launcher for it rather than touching
    /// the token itself. `--no-service`: if the supervisor turned out not to be
    /// this app's, the launcher must never install a LaunchAgent in its place.
    func openDashboard() {
        guard let layout, case .running = health else { return }
        let env = environment(forService: false)
        let data = self.data
        Task.detached {
            let result = Self.runLauncher(layout: layout, env: env, cwd: data, args: ["--no-service", "--no-open"], timeout: 45)
            await MainActor.run {
                if let line = result.output.split(separator: "\n").first(where: { $0.hasPrefix("Dashboard: ") }),
                   let url = URL(string: String(line.dropFirst("Dashboard: ".count)).trimmingCharacters(in: .whitespaces)) {
                    NSWorkspace.shared.open(url)
                } else {
                    let alert = NSAlert()
                    alert.messageText = "buddi did not give a dashboard link"
                    alert.informativeText = result.output.isEmpty ? "No answer within 45 seconds." : String(result.output.suffix(600))
                    NSApp.activate()
                    alert.runModal()
                }
            }
        }
    }

    /// What Settings → System shows: the supervisor's `/version` (cached check).
    func refreshVersion(check: Bool = false, then: (@MainActor (ControlSocket.Version?) -> Void)? = nil) {
        let socket = self.socket
        Task.detached {
            let view = ControlSocket.version(socket, check: check)
            await MainActor.run {
                if let view { self.version = view; self.onChange?() }
                then?(view)
            }
        }
    }

    nonisolated private static func runLauncher(layout: BundleLayout, env: [String: String], cwd: URL,
                                                args: [String], timeout: TimeInterval) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = layout.node
        process.arguments = [layout.launcher.path] + args
        process.environment = env
        process.currentDirectoryURL = cwd
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return (-1, "\(error)") }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if process.isRunning { process.terminate() } }
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: output, encoding: .utf8) ?? "")
    }
}
