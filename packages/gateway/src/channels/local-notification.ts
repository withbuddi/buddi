/**
 * This machine's system notification as a channel (docs/notifications.md).
 *
 * macOS: `terminal-notifier` when it is installed, because a click on it can
 * open the dashboard; otherwise `osascript`'s `display notification`, which
 * shows and opens nothing. Linux: `notify-send`, when it exists and there is
 * a display to show on. Anywhere else there is nothing to show, so no channel
 * is made and Settings never lists one.
 *
 * The service runs as a user LaunchAgent on macOS, which is in the owner's
 * GUI session: `osascript -e 'display notification …'` works there without a
 * TTY. A LaunchDaemon (root, no session) could not, and buddi installs none.
 *
 * Nothing leaves the machine. Routing already sends a `now` message here only
 * when the owner is away from the dashboard or after the 10-minute wait, so
 * this module checks nothing more.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { DeliverableMessage, OwnerChannel } from '@buddi/core';

/** One command's outcome. `code` is null when it did not run or was killed. */
export interface ExecResult {
  code: number | null;
  stderr: string;
  /** Why it did not run (not found, timed out), when it did not. */
  error?: string;
}

export type Exec = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

/** How long one notification may take before it is refused. */
export const LOCAL_NOTIFY_TIMEOUT_MS = 5_000;

/** The longest text shown; a system notification is a line or two. */
export const LOCAL_NOTIFY_MAX_CHARS = 200;

export interface LocalNotificationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; otherwise `execFile`, never through a shell. */
  exec?: Exec;
  /** The absolute path of a binary, or null. Injected in tests; otherwise PATH is searched. */
  which?: (bin: string) => string | null;
  /** The dashboard URL for a route (`#/chat/…`), or for `''`, its home. */
  dashboardUrl?: (route: string) => string;
}

/** `execFile` with a timeout, answering instead of throwing. */
export const execCommand: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      const text = String(stderr ?? '');
      if (!err) return resolve({ code: 0, stderr: text });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve({ code: null, stderr: text, error: `it took longer than ${opts.timeoutMs / 1000} s` });
      if (typeof e.code === 'number') return resolve({ code: e.code, stderr: text });
      resolve({ code: null, stderr: text, error: e.message });
    });
  });

/** A binary on PATH (and, on macOS, where Homebrew puts it: a service's PATH may lack it). */
export function whichOn(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): (bin: string) => string | null {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return (bin) => {
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // not here
      }
    }
    return null;
  };
}

/** One line, at most `max` characters, cut with an ellipsis. */
export function oneLine(text: string, max = LOCAL_NOTIFY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** An AppleScript string literal's inside: backslashes and quotes escaped. */
export function appleScriptString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The first line of a command's stderr, or what is known instead. */
function reasonOf(what: string, result: ExecResult): string {
  const line = result.stderr.split('\n').map((l) => l.trim()).find(Boolean);
  if (line) return `${what}: ${line}`;
  if (result.error) return `${what} did not run: ${result.error}`;
  return `${what} exited with code ${result.code}`;
}

/** Title and body as the notification shows them. With no text, the title is the body. */
function parts(message: DeliverableMessage): { title: string; body: string | null } {
  const text = message.text?.trim();
  return text
    ? { title: oneLine(message.title, 120), body: oneLine(text) }
    : { title: oneLine(message.title), body: null };
}

/**
 * The channel for this machine, or null when it has nothing to show on.
 * The command is picked once, when the channel is made.
 */
export function createLocalNotificationChannel(opts: LocalNotificationOptions = {}): OwnerChannel | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? execCommand;
  const which = opts.which ?? whichOn(env, platform);
  const run = async (what: string, file: string, args: string[]): Promise<{ id: string } | { refused: string }> => {
    let result: ExecResult;
    try {
      result = await exec(file, args, { timeoutMs: LOCAL_NOTIFY_TIMEOUT_MS });
    } catch (err) {
      result = { code: null, stderr: '', error: err instanceof Error ? err.message : String(err) };
    }
    return result.code === 0 ? { id: 'local' } : { refused: reasonOf(what, result) };
  };
  const base = {
    kind: 'local.notification',
    can: { offers: false, attachments: false, markdown: false },
    // After Telegram, before a plugin's: nothing leaves the machine.
    priority: 10,
  };

  if (platform === 'darwin') {
    const notifier = which('terminal-notifier');
    if (notifier) {
      return {
        ...base,
        describe: () => ({ label: 'System notification', where: 'shows on this Mac; a click opens the dashboard' }),
        async deliver(message) {
          const { title, body } = parts(message);
          const args = ['-title', 'buddi', ...(body ? ['-subtitle', title, '-message', body] : ['-message', title]), '-group', `buddi-${message.id}`];
          const url = opts.dashboardUrl?.(message.link?.route ?? '');
          if (url) args.push('-open', url);
          return run('terminal-notifier', notifier, args);
        },
      };
    }
    const osascript = which('osascript');
    if (!osascript) return null;
    return {
      ...base,
      describe: () => ({ label: 'System notification', where: 'shows on this Mac; opens nothing' }),
      async deliver(message) {
        const { title, body } = parts(message);
        const script = body
          ? `display notification "${appleScriptString(body)}" with title "buddi" subtitle "${appleScriptString(title)}"`
          : `display notification "${appleScriptString(title)}" with title "buddi"`;
        return run('osascript', osascript, ['-e', script]);
      },
    };
  }

  if (platform === 'linux') {
    const notifySend = which('notify-send');
    if (!notifySend || !(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim())) return null;
    return {
      ...base,
      describe: () => ({ label: 'System notification', where: 'shows on this computer; opens nothing' }),
      async deliver(message) {
        const { title, body } = parts(message);
        return run('notify-send', notifySend, [`buddi: ${title}`, ...(body ? [body] : [])]);
      },
    };
  }

  return null;
}
