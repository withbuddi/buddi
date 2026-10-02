/**
 * Restarting buddi: the screen goes up at once, waits for the process that
 * answered to go and a new one to answer, reloads once, says it is still
 * waiting after the patience runs out, and takes the place of a restart the
 * page did not start.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '../api';
import { RestartGate } from './Restarting';
import { STREAM_RECONNECTED } from './freshness';
import {
  READY_PATH,
  beginRestart,
  checkForRestart,
  learnBoot,
  noticeClosing,
  pageBoot,
  pluginWords,
  resetRestart,
  restartDeps,
  restartState,
  restartWhile,
  type RestartAsk,
} from './restart';

/** What `/_buddi/ready` says next: a boot, or nothing (null). The last one repeats. */
let answers: Array<string | null> = [];
let asked = 0;
const ready = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), 'http://127.0.0.1');
  if (url.pathname !== READY_PATH) throw new TypeError('not stubbed');
  expect(url.searchParams.get('challenge')).toMatch(/^[a-f0-9]{64}$/);
  asked += 1;
  const next = answers.length > 1 ? answers.shift()! : answers[0] ?? null;
  if (next === null) throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify({ proof: 'p', boot: next }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

let reload: ReturnType<typeof vi.fn>;
const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  resetRestart();
  answers = [];
  asked = 0;
  vi.stubGlobal('fetch', ready);
  // Reduced motion: the Blob stays its still, and the line stops sliding.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce'), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  reload = vi.fn();
  vi.spyOn(restartDeps, 'reload').mockImplementation(reload as never);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  cleanup();
  resetRestart();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function learnt(boot: string): Promise<void> {
  answers = [boot];
  await act(async () => { await learnBoot(); });
  expect(pageBoot()).toBe(boot);
}

describe('waiting for buddi to come back', () => {
  it('waits for the old process to go, then for a new one, then reloads once', async () => {
    await learnt('old');
    // Still the old process for a while, then nothing, then the new one.
    answers = ['old', 'old', null, null, 'new'];
    act(() => beginRestart({ kind: 'restart' }));
    await tick(500);
    await tick(750);
    expect(reload).not.toHaveBeenCalled();
    await tick(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
    // And it stops asking.
    const after = asked;
    await tick(10_000);
    expect(asked).toBe(after);
  });

  it('backs off from half a second to two seconds between asks', async () => {
    await learnt('old');
    answers = ['old'];
    act(() => beginRestart({ kind: 'restart' }));
    const at: number[] = [];
    const start = Date.now();
    ready.mockClear();
    ready.mockImplementation(async () => { at.push(Date.now() - start); throw new TypeError('Failed to fetch'); });
    await tick(12_000);
    const gaps = at.map((t, i) => t - (at[i - 1] ?? 0));
    expect(gaps[0]).toBe(500);
    expect(gaps[1]).toBe(750);
    expect(Math.max(...gaps)).toBe(2_000);
  });

  it('without the old boot, takes an answer after a silence as the new process', async () => {
    answers = [null];
    await act(async () => { await learnBoot(); });
    expect(pageBoot()).toBeNull();
    answers = ['same', null, 'next'];
    act(() => beginRestart({ kind: 'restart' }));
    await tick(500);
    expect(reload).not.toHaveBeenCalled();
    await tick(5_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('without the old boot, learns it from the first answer and reloads when the boot changes with no silence between', async () => {
    answers = [null];
    await act(async () => { await learnBoot(); });
    expect(pageBoot()).toBeNull();
    // The old process answers, then the new one — the restart fell between two asks.
    answers = ['before', 'before', 'after'];
    act(() => beginRestart({ kind: 'restart' }));
    await tick(500);
    await tick(750);
    expect(reload).not.toHaveBeenCalled();
    await tick(5_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('calls a refused restart off, and keeps waiting when nobody answered the ask', async () => {
    await learnt('old');
    answers = ['old'];
    await expect(restartWhile({ kind: 'restart' }, () => Promise.reject(new ApiError(403, 'no')))).rejects.toThrow('no');
    expect(restartState()).toBeNull();
    await restartWhile({ kind: 'restart' }, () => Promise.reject(new ApiError(0, "buddi isn't answering.")));
    expect(restartState()?.kind).toBe('restart');
  });

  it('names the plugins being loaded', () => {
    expect(pluginWords([])).toBeNull();
    expect(pluginWords([{ name: 'weather', version: '0.1.3' }])).toBe('weather 0.1.3');
    expect(pluginWords([{ name: 'weather', version: '0.1.3' }, { name: 'mail', version: '0.2.0' }])).toBe('weather 0.1.3 and mail 0.2.0');
    expect(pluginWords(['weather', 'mail', 'clock', 'speech', 'notes'].map((name) => ({ name, version: '1.0.0' })))).toBe('weather 1.0.0 and 4 more');
  });
});

describe('the screen', () => {
  const shell = (): JSX.Element => (
    <RestartGate>
      <button type="button">Something on the page</button>
    </RestartGate>
  );
  const up = async (ask: RestartAsk): Promise<void> => {
    render(shell());
    await act(async () => { beginRestart(ask); });
  };

  it('goes up at once over an inert page, says what it is for, and counts after ten seconds', async () => {
    answers = ['old'];
    await up({ kind: 'plugins', line: 'Loading weather 0.1.3 and 4 more…' });
    const dialog = screen.getByRole('dialog', { name: 'Restarting buddi' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading weather 0.1.3 and 4 more…');
    expect(within(dialog).getByText('This page reloads when buddi is back.')).toBeInTheDocument();
    expect(document.querySelector('.rs-host')).toHaveAttribute('inert');
    expect(document.querySelector('.rs-host')).toHaveAttribute('aria-hidden', 'true');
    expect(within(dialog).getByTestId('blob')).toHaveAttribute('data-state', 'working');
    // Never an error: nothing red, no alert.
    expect(screen.queryByRole('alert')).toBeNull();
    await tick(12_000);
    expect(within(dialog).getByText('0:12 · this page reloads when buddi is back')).toBeInTheDocument();
  });

  it('says it is still waiting after ninety seconds, what to check, and offers Reload', async () => {
    answers = ['old'];
    await up({ kind: 'restart' });
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    await tick(89_000);
    expect(screen.queryByText('Still waiting — buddi may need a hand.')).toBeNull();
    await tick(2_000);
    expect(screen.getByRole('status')).toHaveTextContent('Still waiting — buddi may need a hand.');
    expect(screen.getByText('buddi status')).toBeInTheDocument();
    expect(screen.getByText(/1:31 · still checking every few seconds/)).toBeInTheDocument();
    expect(screen.getByTestId('blob')).toHaveAttribute('data-state', 'idle');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('gives an upgrade five minutes, and shows its step', async () => {
    answers = ['old'];
    await up({ kind: 'upgrade', line: 'Upgrading to 0.1.0-pre.30…', step: 'Taking a backup first, so there is a way back.', patienceMs: 5 * 60_000 });
    expect(screen.getByRole('dialog', { name: 'Upgrading buddi' })).toBeInTheDocument();
    expect(screen.getByText('Taking a backup first, so there is a way back.')).toBeInTheDocument();
    await tick(120_000);
    expect(screen.queryByText('Still waiting — buddi may need a hand.')).toBeNull();
    await tick(200_000);
    expect(screen.getByText('Still waiting — buddi may need a hand.')).toBeInTheDocument();
  });

  it('draws a stop still, with the command that starts buddi again', async () => {
    answers = [null];
    await up({ kind: 'stop' });
    expect(screen.getByRole('dialog', { name: 'buddi is stopped' })).toBeInTheDocument();
    expect(screen.getByText('buddi service start')).toBeInTheDocument();
    expect(document.querySelector('.rs-track')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});

describe('a restart the page did not start', () => {
  it('goes up when the gateway says on the live stream that it is closing', async () => {
    await learnt('old');
    answers = [null, 'new'];
    render(<RestartGate><p>page</p></RestartGate>);
    await act(async () => { noticeClosing({ for: 'restart' }); });
    expect(screen.getByRole('dialog', { name: 'Restarting buddi' })).toBeInTheDocument();
    await tick(5_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps what the page itself said when the closing frame follows its own restart', async () => {
    act(() => beginRestart({ kind: 'plugins', line: 'Loading weather 0.1.3…' }));
    noticeClosing({ for: 'restart' });
    expect(restartState()).toMatchObject({ kind: 'plugins', line: 'Loading weather 0.1.3…' });
  });

  it('learns the boot when the stream comes back after a first ask that failed', async () => {
    answers = [null];
    await act(async () => { await learnBoot(); });
    expect(pageBoot()).toBeNull();
    answers = ['first'];
    await act(async () => { await checkForRestart(); });
    expect(pageBoot()).toBe('first');
    expect(restartState()).toBeNull();
    answers = ['second'];
    await act(async () => { await checkForRestart(); });
    expect(restartState()?.kind).toBe('detected');
  });

  it('notices a new boot once the live stream is back, and reloads through the screen', async () => {
    answers = ['old'];
    render(<RestartGate><p>page</p></RestartGate>);
    await tick(0);
    expect(pageBoot()).toBe('old');
    answers = ['new'];
    await act(async () => { window.dispatchEvent(new Event(STREAM_RECONNECTED)); });
    await tick(0);
    expect(restartState()?.kind).toBe('detected');
    await tick(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload over something being typed', async () => {
    await learnt('old');
    document.body.insertAdjacentHTML('beforeend', '<div class="wb-composer" data-busy="true"></div>');
    try {
      answers = ['new'];
      await act(async () => { await checkForRestart(); });
      expect(restartState()).toBeNull();
      expect(pageBoot()).toBe('new');
    } finally {
      document.querySelector('.wb-composer')?.remove();
    }
  });
});
