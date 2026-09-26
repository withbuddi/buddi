import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  approvalResumeFrom,
  approvalStopText,
  completerFor,
  historyFile,
  loadHistory,
  parseArgs,
  saveHistory,
  shouldPage,
} from './cli.js';

describe('parseArgs', () => {
  it('reads the ask question and a resume id', () => {
    expect(parseArgs(['ask', 'is it wise?', '--resume', 'abc'])).toEqual({
      command: 'ask',
      question: 'is it wise?',
      resume: 'abc',
      last: false,
    });
  });

  it('ignores the pnpm `--` separator', () => {
    expect(parseArgs(['chat', '--', '--last'])).toMatchObject({
      command: 'chat',
      last: true,
    });
  });

  it('reads --agent', () => {
    expect(parseArgs(['ask', 'q', '--agent', 'concierge'])).toMatchObject({
      command: 'ask',
      question: 'q',
      agent: 'concierge',
    });
  });

  it('reads --agent given a handle, which the catalog resolves like an id', () => {
    expect(parseArgs(['ask', 'q', '--agent', 'ledger']).agent).toBe('ledger');
    expect(parseArgs(['chat', '--agent', '@credo']).agent).toBe('@credo');
  });

  it('leaves the agent unset when no --agent is given', () => {
    expect(parseArgs(['chat']).agent).toBeUndefined();
  });

  it('refuses --agent without a value', () => {
    expect(() => parseArgs(['chat', '--agent'])).toThrow(/handle or id/);
  });

  it('parses the agents listing command', () => {
    expect(parseArgs(['agents']).command).toBe('agents');
  });

  it('refuses an unknown option', () => {
    expect(() => parseArgs(['chat', '--wat'])).toThrow(/unknown option/);
  });

  it('refuses --resume without a value', () => {
    expect(() => parseArgs(['ask', 'q', '--resume'])).toThrow(/conversation id/);
  });

  it('falls back to help', () => {
    expect(parseArgs([]).command).toBe('help');
  });
});

describe('--quiet', () => {
  it('is read as a flag, and is absent unless asked for', () => {
    expect(parseArgs(['chat', '--quiet']).quiet).toBe(true);
    expect(parseArgs(['chat', '-q']).quiet).toBe(true);
    expect(parseArgs(['chat']).quiet).toBeUndefined();
  });
});

describe('history', () => {
  it('round-trips, oldest first on disk and newest first in readline', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-cli-'));
    const file = path.join(dir, 'cli-history');
    // readline holds it newest-first.
    saveHistory(file, ['newest', 'older', 'oldest']);
    expect(readFileSync(file, 'utf8')).toBe('oldest\nolder\nnewest\n');
    expect(loadHistory(file)).toEqual(['newest', 'older', 'oldest']);
  });

  it('is empty rather than fatal when there is no file', () => {
    expect(loadHistory(path.join(tmpdir(), 'buddi-cli-nothing-here'))).toEqual([]);
  });

  it('keeps at most HISTORY_LIMIT lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-cli-'));
    const file = path.join(dir, 'cli-history');
    writeFileSync(file, Array.from({ length: HISTORY_LIMIT + 50 }, (_, i) => `line ${i}`).join('\n'));
    expect(loadHistory(file)).toHaveLength(HISTORY_LIMIT);
    // The tail is what survives: the most recent lines.
    expect(loadHistory(file)[0]).toBe(`line ${HISTORY_LIMIT + 49}`);
  });

  it('lives beside every other thing the installation writes', () => {
    expect(historyFile({ BUDDI_DATA_DIR: '/tmp/buddi-data' })).toBe('/tmp/buddi-data/cli-history');
  });
});

describe('tab completion', () => {
  const complete = completerFor({
    handles: ['ledger', 'scout'],
    listDir: (dir) => (dir === '/work/docs' ? ['a.pdf', 'b.csv', 'notes/'] : []),
    home: '/home/owner',
    cwd: '/work',
  });

  it('completes slash commands', () => {
    const [hits] = complete('/re');
    expect(hits).toContain('/reminders');
    expect(hits).toContain('/recap');
    expect(hits).not.toContain('/quit');
  });

  it('offers every command for a bare slash', () => {
    const [hits] = complete('/');
    expect(hits.length).toBeGreaterThan(10);
  });

  it('completes agent handles after @ and after /use', () => {
    expect(complete('@sc')[0]).toEqual(['@scout ']);
    expect(complete('/use le')[0]).toEqual(['/use ledger']);
  });

  it('completes paths after /attach', () => {
    const [hits] = complete('/attach docs/');
    expect(hits).toEqual(['/attach docs/a.pdf', '/attach docs/b.csv', '/attach docs/notes/']);
  });

  it('filters a partial filename after /attach', () => {
    expect(complete('/attach docs/a')[0]).toEqual(['/attach docs/a.pdf']);
  });

  it('completes nothing for ordinary prose', () => {
    expect(complete('can I afford')[0]).toEqual([]);
  });
});

describe('paging', () => {
  const tty = { color: true, width: 80, tty: true };
  const pipe = { color: false, width: 80, tty: false };

  it('pages only what does not fit the window', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(shouldPage(long, tty, 24)).toBe(true);
    expect(shouldPage('short', tty, 24)).toBe(false);
  });

  it('never pages into a pipe', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(shouldPage(long, pipe, 24)).toBe(false);
  });
});

describe('buddi ask, for scripts', () => {
  it('reads --json, --file (more than once) and --wait', () => {
    expect(parseArgs(['ask', 'sum it', '--json', '--file', 'a.pdf', '--file', 'b.csv', '--wait', '30'])).toEqual({
      command: 'ask',
      question: 'sum it',
      last: false,
      json: true,
      files: ['a.pdf', 'b.csv'],
      waitSeconds: 30,
    });
  });

  it('keeps those flags to ask', () => {
    expect(() => parseArgs(['chat', '--json'])).toThrow(/unknown option: --json/);
    expect(() => parseArgs(['ask', 'q', '--wait', 'soon'])).toThrow(/--wait needs a number of seconds/);
    expect(() => parseArgs(['ask', 'q', '--file'])).toThrow(/--file needs a path/);
  });

  it('says where to approve and how to finish', () => {
    expect(approvalStopText('act-1', 'conv-1')).toBe(
      'This run is waiting for your approval (action act-1).\n' +
        'Approve it on the dashboard or Telegram, then run buddi ask again with --resume conv-1',
    );
  });

  it('wakes the run with what the decided action returned', () => {
    const base = { id: 'act-1', tool: 'mail.send' } as Parameters<typeof approvalResumeFrom>[0];
    expect(approvalResumeFrom({ ...base, state: 'succeeded', outcome: { attempt: 1, result: { sent: true } } })).toEqual({
      actionId: 'act-1',
      tool: 'mail.send',
      state: 'succeeded',
      result: { sent: true },
    });
    expect(approvalResumeFrom({ ...base, state: 'rejected', outcome: null })).toEqual({
      actionId: 'act-1',
      tool: 'mail.send',
      state: 'rejected',
    });
  });
});
