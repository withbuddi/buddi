/**
 * `main`'s answers before anything loads: usage errors, commands that do not
 * apply here, and `--json` where there is none. All exit 2, none touch a database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitCodeForError, main } from './main.js';

function capture(): { err: string[]; out: string[] } {
  const err: string[] = [];
  const out: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
  return { err, out };
}

afterEach(() => vi.restoreAllMocks());

describe('main', () => {
  it('answers a hidden command with the alternative, in a packaged install', async () => {
    const { err } = capture();
    expect(await main(['init'], { BUDDI_INSTALL_ROOT: '/opt/buddi' })).toBe(2);
    expect(err).toEqual([
      'buddi init is for a source checkout. A packaged install sets itself up the first time you run buddi.',
    ]);
  });

  it('refuses --json on a command that has none', async () => {
    const { err } = capture();
    expect(await main(['doctor', '--json'], {})).toBe(2);
    expect(err[0]).toMatch(/buddi doctor has no --json output/);
  });

  it('says the nearest command for a wrong word', async () => {
    const { err } = capture();
    expect(await main(['stauts'], {})).toBe(2);
    expect(err).toEqual(['buddi stauts is not a command. Did you mean buddi status?']);
  });

  it('treats a delegated typo as a usage error too', async () => {
    const { err } = capture();
    expect(await main(['reminders', '--soon'], {})).toBe(2);
    expect(err[0]).toMatch(/unknown option for buddi reminders: --soon/);
  });

  it('prints one command page for --help', async () => {
    const { out } = capture();
    expect(await main(['backup', 'create', '--help'], {})).toBe(0);
    expect(out.join('\n')).toContain('Exit codes');
  });

  it('prints the list without the Develop group in a packaged install', async () => {
    const { out } = capture();
    expect(await main(['help'], { BUDDI_INSTALL_ROOT: '/opt/buddi' })).toBe(0);
    expect(out.join('\n')).not.toContain('buddi db up');
  });
});

describe('exitCodeForError', () => {
  it('is 3 for a database that is not there, 1 otherwise', () => {
    expect(exitCodeForError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(3);
    expect(exitCodeForError(new Error('boom'))).toBe(1);
  });
});
