import { describe, expect, it } from 'vitest';
import { guardArguments } from './windows-guard.js';

describe('the Windows sign-out guard', () => {
  const script = (): string => Buffer.from(guardArguments().at(-1)!, 'base64').toString('utf16le');

  it('runs hidden, its script encoded rather than quoted', () => {
    expect(guardArguments().slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    // Paths come from the environment, never the command line.
    expect(script()).toContain('$env:BUDDI_GUARD_CLUSTER');
  });

  it('stops the database when the session ends, holds the end at most 15 seconds, and leaves an installer\'s close alone', () => {
    const text = script();
    expect(text).toContain('SetProcessShutdownParameters(0x2FF, 0)');
    expect(text).toContain('const int CapMs = 15000;');
    expect(text).toContain('"pgsignal_" + postmaster');
    // WM_QUERYENDSESSION: "not yet" while the database stops.
    expect(text).toMatch(/if \(Live\(\) && !Capped\(\)\) \{ Begin\(\); ShutdownBlockReasonCreate/);
    // ENDSESSION_CLOSEAPP (Restart Manager) is checked before anything is stopped.
    expect(text.indexOf('& 0x1) != 0')).toBeLessThan(text.indexOf('if (m.Msg == 0x11) {'));
  });
});
