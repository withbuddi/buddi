import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAR_LINE, FRAMES, Spinner, silentSpinner } from './spinner.js';

function collector(): { writes: string[]; write: (chunk: string) => void } {
  const writes: string[] = [];
  return { writes, write: (chunk: string): void => void writes.push(chunk) };
}

describe('Spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes nothing at all before it is started', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true });
    spinner.noteToolCall('finance.summary');
    expect(out.writes).toEqual([]);
    expect(spinner.running).toBe(false);
  });

  it('draws a first frame the moment it starts', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true, now: () => Date.now() });
    spinner.start('Ledger');
    expect(out.writes).toHaveLength(1);
    expect(out.writes[0]).toBe(`${CLEAR_LINE}${FRAMES[0]} 0s · Ledger is working`);
  });

  it('counts the seconds and advances the frame', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true, intervalMs: 100 });
    spinner.start('Ledger');
    vi.advanceTimersByTime(2500);
    expect(spinner.elapsedSeconds).toBe(2);
    expect(spinner.line()).toContain('2s');
    expect(spinner.line().startsWith(FRAMES[0] as string)).toBe(false);
  });

  it('says what the agent is doing, in the Telegram progress words', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true });
    spinner.start('Ledger');
    spinner.noteToolCall('finance.project_cashflow');
    expect(spinner.line()).toContain('projecting cash flow');
    // An unknown tool degrades to its own name rather than a code identifier.
    spinner.noteToolCall('finance.list_txns');
    expect(spinner.line()).toContain('list txns');
  });

  it('erases the line when it stops, and is idempotent', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true });
    spinner.start('Ledger');
    out.writes.length = 0;
    spinner.stop();
    spinner.stop();
    expect(out.writes).toEqual([CLEAR_LINE]);
    expect(spinner.running).toBe(false);
  });

  it('stops the timer, so a stopped spinner never writes again', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true, intervalMs: 100 });
    spinner.start('Ledger');
    spinner.stop();
    out.writes.length = 0;
    vi.advanceTimersByTime(1000);
    expect(out.writes).toEqual([]);
  });

  it('can be started again after stopping, from zero', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: true, intervalMs: 100 });
    spinner.start('Ledger');
    vi.advanceTimersByTime(3000);
    spinner.stop();
    spinner.start('Scout');
    expect(spinner.elapsedSeconds).toBe(0);
    expect(spinner.line()).toContain('Scout is working');
  });

  it('writes nothing when disabled — a pipe, NO_COLOR, --quiet', () => {
    const out = collector();
    const spinner = new Spinner({ write: out.write, enabled: false, intervalMs: 100 });
    spinner.start('Ledger');
    spinner.noteToolCall('finance.summary');
    vi.advanceTimersByTime(5000);
    // The state machine still ran: only the writing was suppressed.
    expect(spinner.line()).toContain('summarizing spending');
    expect(spinner.line()).toContain('5s');
    spinner.stop();
    expect(out.writes).toEqual([]);
  });

  it('gives buddi ask a spinner that can never write', () => {
    const spinner = silentSpinner();
    spinner.start('Ledger');
    spinner.stop();
    expect(spinner.running).toBe(false);
  });
});
