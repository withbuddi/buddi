/**
 * @vitest-environment jsdom
 *
 * The popup: copying the code, and the four states it can be in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_FOR, SETTINGS_HASH, countBuddiTabs, dashboardUrl, render, wireCopy, workingLine, type PopupModel } from './popup.js';
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
 * The four states, drawn into the real popup.html. "Visible" means neither the
 * element nor anything around it is `hidden`, and the stylesheet makes
 * `[hidden]` win over every display rule, which is what let the old popup show
 * a placeholder code while it was already paired.
 */
describe('the four states of the popup', () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'popup.html'), 'utf8');
  const state = (over: Partial<ClientState> = {}): ClientState =>
    ({ connection: 'offline', code: null, installation: null, error: null, ...over });
  const model = (over: Partial<PopupModel> = {}): PopupModel =>
    ({ state: state(), gateway: 'http://127.0.0.1:4317', editing: false, tabs: null, refused: null, ...over });
  const $ = (id: string) => document.getElementById(id)!;
  const shown = (id: string) => $(id).closest('[hidden]') === null;
  const views = () => [...document.querySelectorAll<HTMLElement>('.view')].filter((v) => !v.hidden).map((v) => v.dataset['view']);

  beforeEach(() => {
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  });

  it('hides whatever carries the hidden attribute, whatever else styles it', () => {
    expect(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'popup.css'), 'utf8'))
      .toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it('not connected: the address, prefilled, and Connect', () => {
    render(model());
    expect(views()).toEqual(['address']);
    expect(($('gateway') as HTMLInputElement).value).toBe('http://127.0.0.1:4317');
    expect(($('gateway') as HTMLInputElement).disabled).toBe(false);
    expect($('pill').textContent).toBe('Not connected');
    expect($('connect').textContent).toBe('Connect');
    expect(shown('connect')).toBe(true);
    expect(shown('notice')).toBe(false);
    expect(shown('code')).toBe(false);
    expect(shown('forget')).toBe(false);
  });

  it('not connected after an error: the worker’s sentence, and Try again', () => {
    render(model({ state: state({ error: 'Not connected to buddi.' }) }));
    expect(shown('notice')).toBe(true);
    expect($('notice').textContent).toBe('Not connected to buddi.');
    expect($('pill').dataset['tone']).toBe('bad');
    expect($('connect').textContent).toBe('Try again');

    render(model({ refused: 'A buddi address has to be on this machine.' }));
    expect($('notice').textContent).toBe('A buddi address has to be on this machine.');
    expect($('connect').textContent).toBe('Try again');
  });

  it('connecting: the field is disabled and it says what it is waiting for', () => {
    render(model({ state: state({ connection: 'connecting' }) }));
    expect(views()).toEqual(['address']);
    expect($('pill').textContent).toBe('Connecting…');
    expect(($('gateway') as HTMLInputElement).disabled).toBe(true);
    expect(shown('asking')).toBe(true);
    expect($('asking').textContent).toBe('Asking your buddi for a code…');
    expect(shown('connect')).toBe(false);
  });

  it('pairing: the code, grouped, with Copy and the way to the settings page', () => {
    render(model({ state: state({ connection: 'pairing', code: '482913' }) }));
    expect(views()).toEqual(['pairing']);
    expect($('code').textContent).toBe('482 913');
    expect(shown('copy')).toBe(true);
    expect(shown('open-settings')).toBe(true);
    expect(shown('gateway')).toBe(false);
    expect(document.body.textContent).toMatch(/Settings → Computer\u00a0&\u00a0browser, within five minutes/);
    expect(dashboardUrl('http://127.0.0.1:4317', SETTINGS_HASH)).toBe('http://127.0.0.1:4317/#/settings/computer');
  });

  it('pairing, then "Not this buddi": back to the address, the code gone', () => {
    render(model({ state: state({ connection: 'pairing', code: '482 913' }), editing: true }));
    expect(views()).toEqual(['address']);
    expect($('code').textContent).toBe('');
    expect(($('gateway') as HTMLInputElement).disabled).toBe(false);
  });

  it('connected: which buddi and what it is doing, and no code shown', () => {
    render(model({ state: state({ connection: 'pairing', code: '482 913' }) }));
    render(model({ state: state({ connection: 'paired', installation: '127.0.0.1:4317' }), tabs: 3 }));
    expect(views()).toEqual(['paired']);
    expect($('pill').textContent).toBe('Connected');
    expect($('pill').dataset['tone']).toBe('good');
    expect($('paired-to').textContent).toBe('Your buddi at 127.0.0.1:4317');
    expect($('working').textContent).toBe('Working in 3 tabs');
    expect(shown('open-buddi')).toBe(true);
    expect(shown('forget')).toBe(true);
    // No code, no placeholder, no Connect.
    expect(shown('code')).toBe(false);
    expect($('code').textContent).toBe('');
    expect(document.body.textContent).not.toMatch(/\d{3} \d{3}/);
    expect(shown('connect')).toBe(false);
    expect(shown('gateway')).toBe(false);
  });

  it('connected with nothing open, and named by its address when the buddi gave no name', () => {
    render(model({ state: state({ connection: 'paired' }), gateway: 'http://localhost:4400', tabs: 0 }));
    expect($('paired-to').textContent).toBe('Your buddi at localhost:4400');
    expect($('working').textContent).toBe('Nothing open right now.');
    expect(workingLine(1)).toBe('Working in 1 tab');
    expect(workingLine(null)).toBe('Nothing open right now.');
  });

  it('writes what the gateway sends as text, never as markup', () => {
    render(model({ state: state({ connection: 'paired', installation: '<img src=x onerror=alert(1)>' }) }));
    expect($('paired-to').querySelector('img')).toBeNull();
    expect($('paired-to').textContent).toContain('<img');
  });

  it('counts the tabs in the buddi group, in every window', async () => {
    const api = {
      tabGroups: { query: vi.fn(async () => [{ id: 7, title: 'buddi' }]) },
      tabs: { create: vi.fn(), query: vi.fn(async () => [{ groupId: 7 }, { groupId: 7 }, { groupId: -1 }, {}]) },
    };
    expect(await countBuddiTabs(api)).toBe(2);
    api.tabGroups.query.mockResolvedValueOnce([]);
    expect(await countBuddiTabs(api)).toBe(0);
    api.tabGroups.query.mockRejectedValueOnce(new Error('no'));
    expect(await countBuddiTabs(api)).toBeNull();
  });
});
