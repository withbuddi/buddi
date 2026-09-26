/**
 * This machine's system notification: which command, with which arguments,
 * and nothing registered where there is nothing to show on.
 */
import { describe, expect, it } from 'vitest';
import type { DeliverableMessage } from '@buddi/core';
import { appleScriptString, createLocalNotificationChannel, type Exec, type ExecResult } from './local-notification.js';

type Call = { file: string; args: readonly string[]; timeoutMs: number };

function fakeExec(answer: ExecResult = { code: 0, stderr: '' }): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: async (file, args, opts) => {
      calls.push({ file, args, timeoutMs: opts.timeoutMs });
      return answer;
    },
  };
}

const on = (...bins: string[]) => (bin: string): string | null => (bins.includes(bin) ? `/bin/${bin}` : null);

const message = (over: Partial<DeliverableMessage> = {}): DeliverableMessage => ({
  id: 'n1',
  kind: 'approval',
  urgency: 'now',
  title: 'Scout wants to send a mail',
  text: 'To: ada@example.com\nSubject: Friday',
  ...over,
});

describe('local.notification on macOS', () => {
  it('uses osascript when terminal-notifier is not there, and says a click opens nothing', async () => {
    const { exec, calls } = fakeExec();
    const channel = createLocalNotificationChannel({ platform: 'darwin', env: {}, exec, which: on('osascript') })!;
    expect(channel.kind).toBe('local.notification');
    expect(channel.can).toEqual({ offers: false, attachments: false, markdown: false });
    expect(channel.describe()).toEqual({ label: 'System notification', where: 'shows on this Mac; opens nothing' });
    expect(await channel.deliver(message())).toEqual({ id: 'local' });
    expect(calls).toEqual([{
      file: '/bin/osascript',
      args: ['-e', 'display notification "To: ada@example.com Subject: Friday" with title "buddi" subtitle "Scout wants to send a mail"'],
      timeoutMs: 5000,
    }]);
  });

  it('escapes quotes and backslashes and flattens newlines', async () => {
    const { exec, calls } = fakeExec();
    const channel = createLocalNotificationChannel({ platform: 'darwin', env: {}, exec, which: on('osascript') })!;
    await channel.deliver(message({ title: 'Say "hi"', text: 'a\\b\n\n"c"' }));
    expect(calls[0]!.args[1]).toBe('display notification "a\\\\b \\"c\\"" with title "buddi" subtitle "Say \\"hi\\""');
    expect(appleScriptString('"\\')).toBe('\\"\\\\');
  });

  it('shows only the title when there is no text, and cuts long text with an ellipsis', async () => {
    const { exec, calls } = fakeExec();
    const channel = createLocalNotificationChannel({ platform: 'darwin', env: {}, exec, which: on('osascript') })!;
    await channel.deliver(message({ text: undefined }));
    expect(calls[0]!.args[1]).toBe('display notification "Scout wants to send a mail" with title "buddi"');
    await channel.deliver(message({ text: 'x'.repeat(500) }));
    const shown = /display notification "([^"]*)"/.exec(calls[1]!.args[1]!)![1]!;
    expect(shown).toHaveLength(200);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('prefers terminal-notifier, which opens the dashboard link', async () => {
    const { exec, calls } = fakeExec();
    const channel = createLocalNotificationChannel({
      platform: 'darwin',
      env: {},
      exec,
      which: on('osascript', 'terminal-notifier'),
      dashboardUrl: (route) => `http://127.0.0.1:7777/${route}`,
    })!;
    expect((await channel.describe())?.where).toBe('shows on this Mac; a click opens the dashboard');
    await channel.deliver(message({ link: { route: '#/chat/scout/c1' } }));
    expect(calls[0]).toEqual({
      file: '/bin/terminal-notifier',
      args: ['-title', 'buddi', '-subtitle', 'Scout wants to send a mail', '-message', 'To: ada@example.com Subject: Friday',
        '-group', 'buddi-n1', '-open', 'http://127.0.0.1:7777/#/chat/scout/c1'],
      timeoutMs: 5000,
    });
    await channel.deliver(message({ text: undefined }));
    expect(calls[1]!.args).toEqual(['-title', 'buddi', '-message', 'Scout wants to send a mail', '-group', 'buddi-n1', '-open', 'http://127.0.0.1:7777/']);
  });

  it('is refused with the first line of stderr on a non-zero exit, and never throws', async () => {
    const { exec } = fakeExec({ code: 1, stderr: '\nexecution error: Not authorized (-1743)\nmore\n' });
    const channel = createLocalNotificationChannel({ platform: 'darwin', env: {}, exec, which: on('osascript') })!;
    expect(await channel.deliver(message())).toEqual({ refused: 'osascript: execution error: Not authorized (-1743)' });

    const timedOut = createLocalNotificationChannel({
      platform: 'darwin', env: {}, which: on('osascript'),
      exec: async () => ({ code: null, stderr: '', error: 'it took longer than 5 s' }),
    })!;
    expect(await timedOut.deliver(message())).toEqual({ refused: 'osascript did not run: it took longer than 5 s' });

    const throwing = createLocalNotificationChannel({
      platform: 'darwin', env: {}, which: on('osascript'),
      exec: async () => { throw new Error('spawn EACCES'); },
    })!;
    expect(await throwing.deliver(message())).toEqual({ refused: 'osascript did not run: spawn EACCES' });

    const silent = createLocalNotificationChannel({
      platform: 'darwin', env: {}, which: on('osascript'), exec: async () => ({ code: 2, stderr: '' }),
    })!;
    expect(await silent.deliver(message())).toEqual({ refused: 'osascript exited with code 2' });
  });

  it('is not made without osascript', () => {
    expect(createLocalNotificationChannel({ platform: 'darwin', env: {}, exec: fakeExec().exec, which: on() })).toBeNull();
  });
});

describe('local.notification on Linux', () => {
  it('uses notify-send when there is a display', async () => {
    for (const env of [{ DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'wayland-0' }]) {
      const { exec, calls } = fakeExec();
      const channel = createLocalNotificationChannel({ platform: 'linux', env, exec, which: on('notify-send') })!;
      expect(channel.describe()).toEqual({ label: 'System notification', where: 'shows on this computer; opens nothing' });
      expect(await channel.deliver(message())).toEqual({ id: 'local' });
      expect(calls).toEqual([{ file: '/bin/notify-send', args: ['buddi: Scout wants to send a mail', 'To: ada@example.com Subject: Friday'], timeoutMs: 5000 }]);
      await channel.deliver(message({ text: undefined, title: 'Say "hi"\nnow' }));
      expect(calls[1]!.args).toEqual(['buddi: Say "hi" now']);
    }
  });

  it('is refused with stderr on a non-zero exit', async () => {
    const { exec } = fakeExec({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY\n' });
    const channel = createLocalNotificationChannel({ platform: 'linux', env: { DISPLAY: ':0' }, exec, which: on('notify-send') })!;
    expect(await channel.deliver(message())).toEqual({ refused: 'notify-send: Cannot autolaunch D-Bus without X11 $DISPLAY' });
  });

  it('is not made without notify-send, or without a display', () => {
    const { exec } = fakeExec();
    expect(createLocalNotificationChannel({ platform: 'linux', env: { DISPLAY: ':0' }, exec, which: on() })).toBeNull();
    expect(createLocalNotificationChannel({ platform: 'linux', env: {}, exec, which: on('notify-send') })).toBeNull();
    expect(createLocalNotificationChannel({ platform: 'linux', env: { DISPLAY: ' ' }, exec, which: on('notify-send') })).toBeNull();
  });
});

describe('local.notification elsewhere', () => {
  it('is not made', () => {
    expect(createLocalNotificationChannel({ platform: 'win32', env: {}, exec: fakeExec().exec, which: on('osascript', 'notify-send') })).toBeNull();
  });
});
