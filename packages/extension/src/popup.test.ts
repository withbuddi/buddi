/**
 * @vitest-environment jsdom
 *
 * The popup: copying a code, and the rows of the buddis it works for.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingView } from './background.js';
import { APP_WAIT_MS, COPIED_FOR, REDRAW_MS, SETTINGS_HASH, throttle, appSettingsLink, dashboardUrl, openSettings, render, rowView, settingsWebUrl, summary, triesApp, wireCopy, workingLine, type PopupModel } from './popup.js';
import type { ClientState } from './protocol.js';

let written: string[] = [];

beforeEach(() => {
  written = [];
  document.body.innerHTML = '<p id="code">482 913</p><button id="copy">Copy</button>';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => { written.push(text); }) },
  });
});

const wire = () => {
  const button = document.getElementById('copy') as HTMLButtonElement;
  wireCopy(button, () => document.getElementById('code')!.textContent ?? '');
  return button;
};

describe('copying the pairing code', () => {
  it('writes the code, says so, and takes it back after two seconds', async () => {
    vi.useFakeTimers();
    try {
      const button = wire();
      button.click();
      await vi.waitFor(() => expect(written).toEqual(['482 913']));
      expect(button.textContent).toBe('Copied');
      vi.advanceTimersByTime(COPIED_FOR - 1);
      expect(button.textContent).toBe('Copied');
      vi.advanceTimersByTime(1);
      expect(button.textContent).toBe('Copy');
    } finally { vi.useRealTimers(); }
  });

  it('writes text and never markup, and says nothing when the browser refuses', async () => {
    document.getElementById('code')!.textContent = '<img src=x onerror=alert(1)>';
    const button = wire();
    button.click();
    await vi.waitFor(() => expect(written).toEqual(['<img src=x onerror=alert(1)>']));
    expect(document.getElementById('code')!.querySelector('img')).toBeNull();

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('not allowed'));
    button.textContent = 'Copy';
    button.click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
    expect(button.textContent).toBe('Copy');
  });
});

/*
 * The rows, drawn into the real popup.html. "Visible" means neither the
 * element nor anything around it is `hidden`, and the stylesheet makes
 * `[hidden]` win over every display rule, which is what let the old popup show
 * a placeholder code while it was already paired.
 */
describe('the buddis in the popup, one row each', () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'popup.html'), 'utf8');
  const state = (over: Partial<ClientState> = {}): ClientState =>
    ({ connection: 'offline', code: null, installation: null, error: null, ...over });
  const buddi = (over: Partial<PairingView> = {}): PairingView =>
    ({ id: 'a', origin: 'http://127.0.0.1:4317', name: 'buddi', colour: 'blue', enabled: true, state: state(), tabs: null, ...over });
  const model = (over: Partial<PopupModel> = {}): PopupModel =>
    ({ pairings: [buddi()], adding: false, asked: null, refused: null, ...over });
  const $ = (id: string) => document.getElementById(id)!;
  const rows = () => [...document.querySelectorAll<HTMLElement>('#buddis .buddi')];
  const shown = (element: Element | null) => !!element && element.closest('[hidden]') === null;
  const inRow = (row: Element, name: string) => row.querySelector<HTMLElement>(`.${name}`)!;

  beforeEach(() => {
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  });

  it('hides whatever carries the hidden attribute, whatever else styles it', () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'popup.css'), 'utf8');
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it('no buddi yet: Add a buddi is open on the default address, with nothing to cancel back to', () => {
    render(model({ pairings: [] }), document);
    expect(rows()).toHaveLength(0);
    expect(shown($('add'))).toBe(true);
    expect(($('gateway') as HTMLInputElement).value).toBe('http://127.0.0.1:4317');
    expect(shown($('add-cancel'))).toBe(false);
    expect(shown($('add-open'))).toBe(false);
    expect($('pill').textContent).toBe('Not connected');
  });

  it('not connected after an error: the worker’s sentence in that row, and Try again', () => {
    render(model({ pairings: [buddi({ state: state({ error: 'buddi did not answer at this address. Is it running?' }) })] }), document);
    const [row] = rows();
    expect(inRow(row!, 'buddi-error').textContent).toMatch(/did not answer/);
    expect(shown(inRow(row!, 'buddi-retry'))).toBe(true);
    expect(inRow(row!, 'buddi-pill').dataset['tone']).toBe('bad');
    expect($('pill').dataset['tone']).toBe('bad');
    expect(shown($('add'))).toBe(false);
  });

  it('connecting: says what it waits for, and offers nothing to press but its switch', () => {
    render(model({ pairings: [buddi({ state: state({ connection: 'connecting' }) })] }), document);
    const [row] = rows();
    expect(shown(inRow(row!, 'buddi-asking'))).toBe(true);
    expect(shown(inRow(row!, 'buddi-retry'))).toBe(false);
    expect(inRow(row!, 'buddi-pill').textContent).toBe('Connecting…');
  });

  it('pairing: that buddi’s code, grouped, with Copy and the way to its settings', () => {
    render(model({ pairings: [buddi({ state: state({ connection: 'pairing', code: '482913' }) })] }), document);
    const [row] = rows();
    expect(inRow(row!, 'code').textContent).toBe('482 913');
    expect(shown(inRow(row!, 'buddi-pairing'))).toBe(true);
    expect(shown(inRow(row!, 'buddi-settings'))).toBe(true);
    expect(shown(inRow(row!, 'buddi-open'))).toBe(false);
  });

  it('two buddis: each its own row, name, address, colour and state; the head counts the connected ones', () => {
    render(model({ pairings: [
      buddi({ id: 'a', name: 'buddi', state: state({ connection: 'paired', installation: '127.0.0.1:4317' }), tabs: 2 }),
      buddi({ id: 'b', origin: 'http://127.0.0.1:4327', name: 'buddi-dev', colour: 'purple', state: state({ connection: 'paired' }), tabs: 1 }),
    ] }), document);
    const [first, second] = rows();
    expect(inRow(first!, 'buddi-name').textContent).toBe('buddi');
    expect(inRow(second!, 'buddi-name').textContent).toBe('buddi-dev');
    expect(inRow(second!, 'buddi-address').textContent).toBe('127.0.0.1:4327');
    expect(second!.dataset['colour']).toBe('purple');
    expect(inRow(first!, 'buddi-working').textContent).toBe('Working in 2 tabs');
    expect(inRow(second!, 'buddi-working').textContent).toBe('Working in 1 tab');
    expect(shown(inRow(first!, 'code'))).toBe(false);
    expect($('pill').textContent).toBe('2 connected');
    expect(shown($('add-open'))).toBe(true);
  });

  it('switched off: the switch is off, the row says Off, and no code, error or button shows', () => {
    render(model({ pairings: [buddi({ enabled: false, state: state({ error: 'stale' }) })] }), document);
    const [row] = rows();
    expect((row!.querySelector('.buddi-switch') as HTMLInputElement).checked).toBe(false);
    expect(inRow(row!, 'buddi-pill').textContent).toBe('Off');
    for (const part of ['buddi-error', 'buddi-retry', 'buddi-pairing', 'buddi-open', 'buddi-settings']) expect(shown(inRow(row!, part)), part).toBe(false);
    // Remove is always there: it is how a buddi leaves this browser.
    expect(shown(inRow(row!, 'buddi-remove'))).toBe(true);
  });

  it('keeps a row by its id across redraws, and drops the row of a buddi that went', () => {
    render(model({ pairings: [buddi({ id: 'a' }), buddi({ id: 'b', origin: 'http://127.0.0.1:4327' })] }), document);
    const kept = rows()[1];
    render(model({ pairings: [buddi({ id: 'b', origin: 'http://127.0.0.1:4327' })] }), document);
    expect(rows()).toEqual([kept]);
  });

  it('offers the address of a dashboard that asked to be added', () => {
    render(model({ adding: true, asked: 'http://127.0.0.1:4327' }), document);
    expect(shown($('add'))).toBe(true);
    expect($('hint').textContent).toMatch(/127\.0\.0\.1:4327 asked to be added/);
  });

  it('writes what the gateway sends as text, never as markup', () => {
    render(model({ pairings: [buddi({ name: '<img src=x onerror=alert(1)>', state: state({ connection: 'pairing', code: '<b>1</b>' }) })] }), document);
    expect(document.querySelector('#buddis img, #buddis b')).toBeNull();
    expect(inRow(rows()[0]!, 'buddi-name').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('reads one state per row, never two', () => {
    expect(rowView(buddi({ state: state({ connection: 'pairing', code: null }) }))).toBe('connecting');
    expect(rowView(buddi({ enabled: false, state: state({ connection: 'paired' }) }))).toBe('off');
    expect(summary([buddi({ state: state({ connection: 'pairing', code: '1' }) })])).toEqual({ word: 'Needs pairing', tone: 'waiting' });
    expect(workingLine(0)).toBe('Nothing open right now.');
    expect(dashboardUrl('http://127.0.0.1:4317', SETTINGS_HASH)).toBe('http://127.0.0.1:4317/#/settings/computer');
  });
});

describe('Open buddi settings: buddi.app first, the dashboard otherwise', () => {
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const run = (gateway: string, userAgent: string, lost: boolean, code: string | null = '482 913') => {
    const launch = vi.fn();
    const openTab = vi.fn();
    let later: (() => void) | undefined;
    let waited = 0;
    openSettings({ gateway, code, userAgent, launch, openTab, focusLost: () => lost, wait: (ms, then) => { waited = ms; later = then; } });
    return { launch, openTab, fire: () => later?.(), waited };
  };

  it('tries buddi://settings/browser with the code, and stops there when the app took the focus', () => {
    const { launch, openTab, fire, waited } = run('http://127.0.0.1:4317', MAC, true);
    expect(launch).toHaveBeenCalledWith('buddi://settings/browser?code=482913');
    expect(waited).toBe(APP_WAIT_MS);
    expect(APP_WAIT_MS).toBe(1500);
    fire();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('opens the dashboard as before when nothing answered the link in time', () => {
    const { launch, openTab, fire } = run('http://127.0.0.1:4317', MAC, false);
    expect(launch).toHaveBeenCalledOnce();
    expect(openTab).not.toHaveBeenCalled();
    fire();
    expect(openTab).toHaveBeenCalledWith('http://127.0.0.1:4317/?from=extension#/settings/computer?code=482913');
  });

  it('goes straight to the dashboard off a Mac, or for a buddi on another address', () => {
    for (const [gateway, agent] of [['http://127.0.0.1:4317', LINUX], ['http://127.0.0.1:4327', MAC]] as const) {
      const { launch, openTab } = run(gateway, agent, false, null);
      expect(launch).not.toHaveBeenCalled();
      // No `from=extension` where buddi.app could not have answered: the signed-out page won't lead with it.
      expect(openTab).toHaveBeenCalledWith(`${gateway}/#/settings/computer`);
    }
  });

  it('builds its links from six digits and fixed text only', () => {
    expect(appSettingsLink(null)).toBe('buddi://settings/browser');
    expect(appSettingsLink('48291')).toBe('buddi://settings/browser');
    expect(settingsWebUrl('not a url', '482913')).toBeNull();
    expect(triesApp('http://localhost:4317', MAC)).toBe(true);
    expect(triesApp('https://example.com:4317', MAC)).toBe(false);
  });

  it('never puts the code in the query string, and marks from=extension only where the app could answer', () => {
    const mac = settingsWebUrl('http://127.0.0.1:4317', '482 913', MAC) as string;
    expect(new URL(mac).search).toBe('?from=extension');
    expect(new URL(mac).hash).toBe('#/settings/computer?code=482913');
    for (const [gateway, agent] of [['http://127.0.0.1:4317', LINUX], ['http://127.0.0.1:4391', MAC]] as const) {
      const url = new URL(settingsWebUrl(gateway, '482913', agent) as string);
      expect(url.search).toBe('');
      expect(url.hash).toBe('#/settings/computer?code=482913');
    }
  });
});

describe('no flicker', () => {
  it('redraws at most once a second, the last of a burst at the end of its window', () => {
    let now = 0;
    const later: Array<() => void> = [];
    const run = vi.fn();
    const pushed = throttle(run, REDRAW_MS, { now: () => now, later: (fn) => later.push(fn) });
    pushed();
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) { now += 50; pushed(); }
    expect(run).toHaveBeenCalledTimes(1);
    expect(later).toHaveLength(1);
    now = 1_000;
    later.shift()!();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('says quietly when a buddi is older and has no live view', () => {
    document.documentElement.innerHTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'popup.html'), 'utf8').replace(/^<!doctype html>/i, '');
    render({ adding: false, asked: null, refused: null, pairings: [{ id: 'a', origin: 'http://127.0.0.1:4317', name: '127.0.0.1:4317', colour: 'blue', enabled: true, tabs: 0,
      state: { connection: 'paired', code: null, installation: null, error: null, older: true } }] }, document);
    expect(document.querySelector('.buddi-working')!.textContent).toBe('Nothing open right now · older buddi: live view off');
    // Named by its address: the address shows once.
    expect((document.querySelector('.buddi-address') as HTMLElement).hidden).toBe(true);
  });
});
