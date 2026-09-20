/**
 * Unit-file generation — pure text, no filesystem, no `launchctl`.
 *
 * The supervisor is deliberately dumb: it runs the *built* `serve.js` with node,
 * from the repo root, and restarts it when it dies. Everything the process needs
 * to know it reads from `.env` at that root, so the unit carries no secret and
 * needs no rewrite when a credential changes.
 */

export const SERVICE_LABEL = 'com.buddi.serve';

export interface UnitSpec {
  /** Reverse-DNS label (launchd) / unit base name (systemd). */
  label: string;
  /** Absolute path to the node binary that will run the service. */
  nodePath: string;
  /** Absolute path to `packages/gateway/dist/serve.js`. */
  serveEntry: string;
  /** Optional entry arguments and non-secret environment for packaged supervision. */
  args?: string[];
  environment?: Record<string, string>;
  /** The repo root; `serve` resolves `.env`, `agents/` and `data/` from it. */
  workingDirectory: string;
  logFile: string;
  errorFile: string;
  /**
   * PATH for the supervised process. launchd gives a job an almost empty
   * environment, and the node directory must be on it (node itself is invoked
   * by absolute path, but anything it spawns is not).
   */
  path: string;
}

/** XML text escaping. Paths with `&` are rare and still must not corrupt the file. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A macOS LaunchAgent that keeps `buddi serve` alive and starts it at login. */
export function buildPlist(spec: UnitSpec): string {
  const e = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${e(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(spec.nodePath)}</string>
    <string>${e(spec.serveEntry)}</string>
${(spec.args ?? []).map(arg => `    <string>${e(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${e(spec.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${e(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${e(spec.errorFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${e(spec.path)}</string>
${Object.entries(spec.environment ?? {}).map(([key, value]) => `    <key>${e(key)}</key>\n    <string>${e(value)}</string>`).join('\n')}
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/**
 * The Linux counterpart: a systemd *user* unit (no root, starts with the user
 * session). Written against the same spec so both platforms describe one service.
 *
 * systemd has no StandardOutPath, so output is appended to the same files via
 * `append:`; that needs systemd 240 or newer.
 */
export function buildSystemdUnit(spec: UnitSpec): string {
  return `[Unit]
Description=buddi — telegram surface + mission scheduler
After=network-online.target

[Service]
Type=simple
ExecStart=${spec.nodePath} ${spec.serveEntry}
WorkingDirectory=${spec.workingDirectory}
Environment=PATH=${spec.path}
Restart=always
RestartSec=5
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.errorFile}

[Install]
WantedBy=default.target
`;
}

/**
 * Read a pid out of `launchctl print gui/<uid>/<label>`.
 *
 * The output is a nested property list, not a format with a promise of
 * stability, so only the two lines that matter are looked for: `pid = 1234`
 * means running, `state = running` without a pid still counts as running.
 */
export function parseLaunchctlPrint(output: string): { running: boolean; pid?: number } {
  const pidMatch = /^\s*pid\s*=\s*(\d+)/m.exec(output);
  if (pidMatch?.[1]) return { running: true, pid: Number(pidMatch[1]) };
  if (/^\s*state\s*=\s*running/m.test(output)) return { running: true };
  return { running: false };
}

/** `systemctl --user show` answers `key=value` lines; only two are read. */
export function parseSystemctlShow(output: string): { running: boolean; pid?: number } {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) values.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const pid = Number(values.get('MainPID') ?? '0');
  const running = values.get('ActiveState') === 'active' || values.get('SubState') === 'running';
  return pid > 0 ? { running, pid } : { running };
}
