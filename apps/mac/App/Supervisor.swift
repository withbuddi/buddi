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
    /// Located again before every start: an upgrade moves `<data>/releases/current`.
    private(set) var layout: BundleLayout?
    private var layoutProblem: String?
    private var socket: String { DataDirectory.socket(for: data) }

    private(set) var health: Health = .stopped { didSet { if health != oldValue { onChange?() } } }
    /// Another installation's supervisor answering on this data directory
    /// (an npm install's service, say). The app never starts a second one.
    private(set) var foreign: ControlSocket.Status?
    private(set) var version: ControlSocket.Version?
    /// A recorded port another program took was moved at this start: the menu says it in one line.
    private(set) var portNotice: String?
    var onChange: (() -> Void)?
    /// The supervisor left with `UninstallPolicy.exitStatus`: finish the uninstall (keep the data?).
    var onUninstall: ((Bool) -> Void)?

    private var child: Process?
    private var spawnedAt: Date?
    private var runningSince: Date?
    private var failures = 0
    /// Exit 75s in the last minute: one is an upgrade, two is a loop.
    private var restartExits = RestartExitThrottle()
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
        relocate()
    }

    private func relocate() {
        do {
            layout = try BundleLayout.locate(data: data)
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
                // only lose the lock race. Ours on another release than the one
                // chosen (a newer bundle's first launch moved `current`) is
                // replaced, or the new bundle would go on running the old buddi.
                guard let status else { self.spawn(); return }
                if self.isOurs(status), let layout = self.layout,
                   SupervisorPolicy.runsOtherRelease(installRoot: status.installRoot, chosen: layout.release.path) {
                    self.replace(status, with: layout)
                } else {
                    self.apply(status)
                }
            }
        }
    }

    /// Stop a supervisor of ours that runs another release, then start the chosen one.
    private func replace(_ status: ControlSocket.Status, with layout: BundleLayout) {
        NSLog("buddi: the running supervisor (pid \(status.supervisorPid)) runs \(status.installRoot); stopping it to start \(layout.release.path)")
        health = .updating
        let pid = pid_t(status.supervisorPid)
        Task.detached {
            await Self.terminate(pid, grace: 30)
            await MainActor.run {
                guard !self.stopping else { return }
                self.spawn()
            }
        }
    }

    /// SIGTERM (the supervisor's orderly shutdown: gateway, then the database),
    /// up to `grace` seconds, then SIGKILL for it and everything under it, so a
    /// Postgres it started never outlives it holding the data directory.
    nonisolated static func terminate(_ pid: pid_t, grace: TimeInterval) async {
        guard pid > 1 else { return }
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline {
            if kill(pid, 0) != 0 { return }
            try? await Task.sleep(for: .milliseconds(250))
        }
        guard kill(pid, 0) == 0 else { return }
        // Collected before the kill: once the supervisor is gone its children are launchd's.
        let tree = descendants(of: pid)
        NSLog("buddi: the supervisor (pid \(pid)) did not stop within \(Int(grace)) s; killing it and \(tree.count) process(es) under it")
        // Its own process group too, when it leads one (never ours: the app's group is not its).
        let group = getpgid(pid)
        if group == pid && group != getpgrp() { kill(-group, SIGKILL) }
        kill(pid, SIGKILL)
        for child in tree { kill(child, SIGKILL) }
    }

    /// Every process under `pid`, children first found, depth-first.
    nonisolated static func descendants(of pid: pid_t) -> [pid_t] {
        var found: [pid_t] = []
        var queue: [pid_t] = [pid]
        while let parent = queue.popLast(), found.count < 512 {
            let estimate = proc_listchildpids(parent, nil, 0)
            guard estimate > 0 else { continue }
            var buffer = [pid_t](repeating: 0, count: Int(estimate) + 16)
            let count = buffer.withUnsafeMutableBytes { raw in
                proc_listchildpids(parent, raw.baseAddress, Int32(raw.count))
            }
            guard count > 0 else { continue }
            for child in buffer.prefix(Int(count)) where child > 1 && !found.contains(child) {
                found.append(child)
                queue.append(child)
            }
        }
        return found
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
    /// then the database). Waits up to 30 s off the main thread; a supervisor
    /// still there then is killed with everything under it. Then calls back.
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
        Task.detached {
            await Self.terminate(pid, grace: 30)
            await MainActor.run { done() }
        }
    }

    // MARK: - The child

    private func spawn() {
        guard !stopping else { return }
        relocate()
        guard let layout else {
            health = .attention(layoutProblem ?? "This copy of buddi.app is incomplete.")
            return
        }
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
            let pid = ended.processIdentifier
            Task { @MainActor in self?.childEnded(status: status, pid: pid) }
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

    private func childEnded(status: Int32, pid: pid_t) {
        // A child that ended after a newer one started (a restart with the
        // previous version) is old news: the newer one is the child now.
        if let child, child.processIdentifier != pid { return }
        child = nil
        guard !stopping else { health = .stopped; return }
        // The owner removed buddi from Settings → System: the supervisor wrote
        // what they chose and left for the app to finish (product-uninstall.ts).
        if status == UninstallPolicy.exitStatus, let keepData = Uninstall.pendingRequest(data: data) {
            NSLog("buddi: the supervisor left for the uninstall; finishing it")
            stopping = true
            poller?.invalidate()
            health = .stopped
            onUninstall?(keepData)
            return
        }
        // An upgrade switched `<data>/releases/current` and handed over to us
        // (APP_RESTART_EXIT in app-layout.ts): start the new release now.
        // Twice within a minute is not an upgrade but a release that exits 75 as
        // it starts: it falls through to the backoff below, and the menu says so.
        if status == Self.restartExit {
            if restartExits.allowsImmediateRestart(at: Date()) {
                NSLog("buddi: the supervisor handed over for an upgrade; starting the release current points at")
                failures = 0
                health = .updating
                spawn()
                return
            }
            NSLog("buddi: the supervisor asked to be restarted again within a minute; backing off")
            failures += 1
            health = .attention("buddi keeps restarting for an update that does not start. The logs say why.")
            scheduleRespawn()
            return
        }
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
        // Named in Settings → System's "Remove buddi from this Mac" as what goes to the Trash.
        env["BUDDI_APP_BUNDLE"] = Bundle.main.bundlePath
        // Upgrades go to `<data>/releases`, never into the signed bundle.
        env["BUDDI_APP_LAYOUT"] = BundleLayout.releases(for: data).path
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
        guard let layout, status.nodePath == layout.node.path else { return false }
        // Any of this app's releases: the bundle's copy or one under <data>/releases.
        return status.installRoot == layout.release.path || status.installRoot == layout.bundleRelease.path
            || status.installRoot.hasPrefix(layout.releases.path + "/")
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
        if portNotice != status.portNotice {
            portNotice = status.portNotice
            if let notice = status.portNotice { NSLog("buddi: \(notice)") }
            onChange?()
        }
        if status.upgrading == true {
            health = .updating
        } else if status.gateway == "running" {
            let since = runningSince ?? Date()
            runningSince = since
            if Date().timeIntervalSince(since) > 60 { failures = 0; restartExits.reset() }
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

    /// Where a dashboard link goes when buddi opens it by itself (first run) or
    /// the owner asks for it: the app's window. Unset, or `inBrowser`, the
    /// default browser.
    var presentDashboard: ((URL) -> Void)?

    /// A fresh sign-in link: the one `buddi` prints (a five-minute ticket
    /// minted from the install's web token), so the app asks the same launcher
    /// for it rather than touching the token itself. `--no-service`: if the
    /// supervisor turned out not to be this app's, the launcher must never
    /// install a LaunchAgent in its place. The window loads it; Open in
    /// Browser hands it to the default browser.
    func dashboardLink() async -> Result<URL, DashboardLinkFailure> {
        guard let layout else { return .failure(DashboardLinkFailure(description: layoutProblem ?? "buddi.app is incomplete.")) }
        let env = environment(forService: false)
        let data = self.data
        return await Task.detached {
            let result = Self.runLauncher(layout: layout, env: env, cwd: data, args: ["--no-service", "--no-open"], timeout: 45)
            if let line = result.output.split(separator: "\n").first(where: { $0.hasPrefix("Dashboard: ") }),
               let url = URL(string: String(line.dropFirst("Dashboard: ".count)).trimmingCharacters(in: .whitespaces)) {
                return .success(url)
            }
            return .failure(DashboardLinkFailure(description: result.output.isEmpty ? "No answer within 45 seconds." : String(result.output.suffix(600))))
        }.value
    }

    struct DashboardLinkFailure: Error, CustomStringConvertible, Sendable { let description: String }

    /// Opens the dashboard with a fresh sign-in link: in the window
    /// (`presentDashboard`), or in the default browser.
    func openDashboard(inBrowser: Bool = false) {
        guard case .running = health else { return }
        Task { @MainActor in
            switch await self.dashboardLink() {
            case .success(let url):
                if !inBrowser, let present = self.presentDashboard { present(url) } else { NSWorkspace.shared.open(url) }
            case .failure(let failure):
                let alert = NSAlert()
                alert.messageText = "buddi did not give a dashboard link"
                alert.informativeText = failure.description
                NSApp.activate()
                alert.runModal()
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

    /// `APP_RESTART_EXIT` in packages/install/src/app-layout.ts.
    static let restartExit: Int32 = 75

    /// Start the upgrade Settings → System starts: the supervisor's `/upgrade`.
    /// It downloads and verifies the release into `<data>/releases`, takes a
    /// backup, switches `current` and exits with `restartExit`; `childEnded`
    /// starts the new release. Calls back with the refusal, if any.
    func startUpgrade(to version: String, then: @escaping @MainActor (String?) -> Void) {
        let socket = self.socket
        let body = try? JSONSerialization.data(withJSONObject: ["version": version])
        Task.detached {
            var refusal: String?
            do {
                let (code, data) = try ControlSocket.request(socket, method: "POST", path: "/upgrade", body: body, timeout: 25)
                if code != 200 && code != 202 {
                    refusal = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                        ?? "The service refused the upgrade (\(code))."
                }
            } catch {
                refusal = "The service did not answer. Try again in a moment."
            }
            await MainActor.run {
                if refusal == nil { self.health = .updating }
                then(refusal)
            }
        }
    }

    /// The version "Restart with the Previous Version" would go back to.
    var previousVersion: String? {
        guard let layout, foreign == nil, let target = layout.rollbackTarget() else { return nil }
        return BundleLayout.version(of: target)
    }

    /// Stop buddi, point `current` at the previous release, start it again.
    /// The data is not touched: a newer version may have changed the database,
    /// and the backup its upgrade took is what goes back with it.
    func restartWithPreviousVersion(then: @escaping @MainActor (String?) -> Void) {
        guard let layout, let target = layout.rollbackTarget() else { then("There is no previous version to go back to."); return }
        shutdown {
            var problem: String?
            do { try layout.rollBack(to: target) } catch { problem = "buddi could not switch versions: \(error.localizedDescription)" }
            self.failures = 0
            self.runningSince = nil
            self.start()
            then(problem)
        }
    }

    /// The launcher's `buddi uninstall`, with the backup and the words already
    /// taken care of. Run once the supervisor has stopped.
    func runUninstall(keepData: Bool) async -> (status: Int32, output: String) {
        guard let layout else { return (-1, layoutProblem ?? "buddi.app is incomplete.") }
        let env = environment(forService: false)
        return await Task.detached {
            Self.runLauncher(layout: layout, env: env, cwd: FileManager.default.homeDirectoryForCurrentUser,
                             args: UninstallPolicy.launcherArguments(keepData: keepData), timeout: 600)
        }.value
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
