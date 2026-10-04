/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://www.example.com/signin"}
 *
 * Saving a sign-in in a tab the owner holds (docs/browser.md, "Saving a
 * sign-in"): the page side sees the form go out and hands the pair to the
 * worker at once (the form's navigation takes the page away), the waiting bar
 * asks "Save this login for example.com?" — or "Update the login…" for one
 * already kept — Save asks the worker and says what buddi answered, Not now
 * and Never carry no password; a page the tab lands on asks the worker and
 * draws the question again; the worker believes a message only from the held
 * tab, with the address Chrome reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heldLoginRequest, hideHeldBar, showHeldBar, watchHeldLogins, type LoginFrame } from './bar.js';
import { HeldLogins } from './held-logins.js';

const PASSWORD = 'fixture-pass-7Qz!';
type Choice = { label: string; primary?: boolean; pick: () => void };
const holder = globalThis as unknown as Record<string, unknown>;

let asked: Array<{ question: string; choices: Choice[] }>;
let posted: unknown[];
/** What the worker answers the page, by message type. */
let answers: Record<string, unknown>;
beforeEach(() => {
  asked = [];
  posted = [];
  answers = {};
  delete holder['__buddiHeldLogins'];
  holder['__buddiHeldAsk'] = (question: string, choices: Choice[]) => { asked.push({ question, choices }); return () => {}; };
  holder['chrome'] = { runtime: { sendMessage: vi.fn(async (message: { type: string }) => { posted.push(message); return answers[message.type]; }) } };
  document.body.innerHTML = `
    <form id="signin" action="/session" method="post">
      <label>Email <input type="email" name="email" autocomplete="username"></label>
      <label>Password <input type="password" name="password"></label>
      <button type="submit">Sign in</button>
      <button type="button" aria-label="Show password">👁</button>
    </form>`;
  // The page signs in with script, as most do; jsdom has no navigation to submit to.
  document.getElementById('signin')!.addEventListener('submit', (event) => event.preventDefault());
});
afterEach(() => {
  delete holder['__buddiHeldAsk'];
  delete holder['__buddiHeldLogins'];
  delete holder['chrome'];
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function fill(email: string, password: string): HTMLFormElement {
  const form = document.getElementById('signin') as HTMLFormElement;
  (form.querySelector('input[type=email]') as HTMLInputElement).value = email;
  const field = form.querySelector('input[type=password]') as HTMLInputElement;
  field.value = password;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return form;
}
const submit = (form: HTMLFormElement) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const pick = (label: string) => asked.at(-1)!.choices.find((choice) => choice.label === label)!.pick();
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** What the page told the worker, without the page-load question every watch asks. */
const told = () => posted.filter((message) => (message as { type: string }).type !== 'buddi-login-pending');

describe('a held tab offers to save a sign-in', () => {
  it('hands the pair to the worker when the form goes out, asks in the bar, and Save asks the worker without the password', async () => {
    watchHeldLogins('s1', { never: [], saved: [] });
    submit(fill('sam@example.com', PASSWORD));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe('Save this login for example.com?');
    expect(asked[0]!.choices.map((choice) => choice.label)).toEqual(['Save', 'Not now', 'Never for this site']);
    expect(told()).toEqual([{ type: 'buddi-login-seen', session: 's1', username: 'sam@example.com', password: PASSWORD, update: false }]);
    answers['buddi-login'] = { saved: true };
    pick('Save');
    expect(told()[1]).toEqual({ type: 'buddi-login', session: 's1', decision: 'save' });
    // Pressed twice, sent once.
    asked[0]!.choices[0]!.pick();
    expect(told()).toHaveLength(2);
    await settle();
    expect(asked.map((ask) => ask.question)).toEqual(['Save this login for example.com?', 'Saving…', 'Saved the login for example.com']);
  });

  it('says why when buddi could not keep it, with Try again', async () => {
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    answers['buddi-login'] = { saved: false, reason: 'buddi could not keep that login. Try again, or add it in Settings → Keys and secrets.' };
    pick('Save');
    await settle();
    expect(asked.at(-1)!.question).toContain('could not keep that login');
    expect(asked.at(-1)!.choices.map((choice) => choice.label)).toEqual(['Try again', 'Not now']);
    answers['buddi-login'] = { saved: true };
    pick('Try again');
    await settle();
    expect(asked.at(-1)!.question).toBe('Saved the login for example.com');
    expect(told().filter((message) => (message as { decision?: string }).decision === 'save')).toHaveLength(2);
  });

  it('a login already kept with that user name is offered as an update', () => {
    watchHeldLogins('s1', { never: [], saved: [{ site: 'example.com', username: 'sam@example.com' }] });
    submit(fill('sam@example.com', PASSWORD));
    expect(asked[0]!.question).toBe('Update the login for example.com?');
    expect(asked[0]!.choices.map((choice) => choice.label)).toEqual(['Update', 'Not now', 'Never for this site']);
    expect(told()[0]).toMatchObject({ type: 'buddi-login-seen', update: true });
  });

  it('Not now tells the worker to drop the pair', () => {
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    pick('Not now');
    expect(told().at(-1)).toEqual({ type: 'buddi-login', session: 's1', decision: 'later' });
  });

  it('Never carries no password, and asks no more there', () => {
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    pick('Never for this site');
    expect(told().at(-1)).toEqual({ type: 'buddi-login', session: 's1', decision: 'never' });
    submit(fill('other@example.com', 'another-one'));
    expect(asked).toHaveLength(1);
  });

  it('a click on the sign-in button counts; the show-password eye does not', () => {
    watchHeldLogins('s1', null);
    fill('sam@example.com', PASSWORD);
    (document.querySelector('button[aria-label="Show password"]') as HTMLButtonElement).click();
    expect(asked).toEqual([]);
    (document.querySelector('button[type=submit]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(asked).toHaveLength(1);
  });

  it('Enter in a field of the form counts', () => {
    watchHeldLogins('s1', null);
    const form = fill('sam@example.com', PASSWORD);
    form.querySelector('input[type=password]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(asked).toHaveLength(1);
  });

  it('asks nothing for a site buddi was told never to ask about, or an empty password', () => {
    watchHeldLogins('s1', { never: ['example.com'], saved: [] });
    submit(fill('sam@example.com', PASSWORD));
    expect(asked).toEqual([]);
    delete holder['__buddiHeldLogins'];
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', ''));
    expect(asked).toEqual([]);
    expect(told()).toEqual([]);
  });

  it('the waiting bar is where it asks, and a tab given back has nowhere to ask', () => {
    delete holder['__buddiHeldAsk'];
    showHeldBar('s1');
    expect(typeof holder['__buddiHeldAsk']).toBe('function');
    hideHeldBar();
    expect(holder['__buddiHeldAsk']).toBeUndefined();
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    expect(told()).toEqual([]);
  });
});

describe('the question survives the form’s navigation', () => {
  it('submit → navigation → the new page asks the worker, redraws the prompt, and Save goes out with the original origin', async () => {
    // The worker's own pieces: its belief rule and its memory, behind a fake runtime that knows the tab (7) and Chrome's address for it.
    const frames: LoginFrame[] = [];
    const logins = new HeldLogins((frame) => frames.push(frame), { uuid: () => 'ack-1' });
    let pageUrl = 'https://www.example.com/signin';
    const worker = async (message: unknown): Promise<unknown> => {
      const request = heldLoginRequest(message, { tab: { id: 7 }, url: pageUrl }, 7);
      if (!request) return null;
      if (request.kind === 'seen') return logins.capture(request.tabId, request.session, request.url, request) ? { ok: true } : null;
      if (request.kind === 'pending') return logins.pending(request.tabId, request.session, request.url) ?? null;
      if (request.decision === 'save') return logins.save(request.tabId, request.session);
      return null;
    };
    holder['chrome'] = { runtime: { sendMessage: vi.fn(worker) } };
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    await settle();
    expect(asked).toHaveLength(1);

    // The form navigates: the page and everything in it is gone; the tab lands on another host of the same site.
    delete holder['__buddiHeldLogins'];
    document.body.innerHTML = '<p>Welcome back</p>';
    pageUrl = 'https://accounts.example.com/home';
    asked = [];
    watchHeldLogins('s1', null);
    await settle();
    expect(asked.map((ask) => ask.question)).toEqual(['Save this login for example.com?']);

    pick('Save');
    await settle();
    expect(frames).toEqual([{ type: 'login', session: 's1', decision: 'save', origin: 'https://www.example.com', username: 'sam@example.com', password: PASSWORD, id: 'ack-1' }]);
    logins.ack('ack-1', { saved: true });
    await settle();
    expect(asked.at(-1)!.question).toBe('Saved the login for example.com');
  });
});

describe('the worker believes a sign-in message only from the held tab', () => {
  const seen = { type: 'buddi-login-seen', session: 's1', username: 'sam', password: PASSWORD };
  it('takes the address from Chrome’s sender, not the page', () => {
    expect(heldLoginRequest({ ...seen, origin: 'https://evil.test' }, { tab: { id: 4 }, url: 'https://www.example.com/signin?x=1' }, 4))
      .toEqual({ kind: 'seen', session: 's1', tabId: 4, url: 'https://www.example.com/signin?x=1', username: 'sam', password: PASSWORD, update: false });
  });
  it('refuses another tab, no held tab, an empty password and an unknown answer', () => {
    expect(heldLoginRequest(seen, { tab: { id: 5 }, url: 'https://www.example.com/' }, 4)).toBeUndefined();
    expect(heldLoginRequest(seen, { tab: { id: 4 }, url: 'https://www.example.com/' }, undefined)).toBeUndefined();
    expect(heldLoginRequest({ ...seen, password: '' }, { tab: { id: 4 }, url: 'https://www.example.com/' }, 4)).toBeUndefined();
    expect(heldLoginRequest({ type: 'buddi-login', session: 's1', decision: 'maybe' }, { tab: { id: 4 }, url: 'https://www.example.com/' }, 4)).toBeUndefined();
  });
  it('a non-web page keeps nothing', () => {
    const logins = new HeldLogins(() => undefined);
    expect(logins.capture(4, 's1', 'chrome://settings', { username: 'sam', password: PASSWORD })).toBeUndefined();
    expect(logins.size).toBe(0);
  });
  it('Never sends the site alone, never the password', () => {
    const frames: LoginFrame[] = [];
    const logins = new HeldLogins((frame) => frames.push(frame));
    logins.capture(4, 's1', 'https://www.example.com/', { username: 'sam', password: PASSWORD });
    expect(logins.never(4, 's1')).toBe(true);
    expect(frames).toEqual([{ type: 'login', session: 's1', decision: 'never', origin: 'https://www.example.com', username: 'sam' }]);
    expect(JSON.stringify(frames)).not.toContain(PASSWORD);
  });
  it('drops the pair after two minutes', () => {
    vi.useFakeTimers();
    const logins = new HeldLogins(() => undefined);
    logins.capture(4, 's1', 'https://www.example.com/', { username: 'sam', password: PASSWORD });
    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(logins.size).toBe(0);
  });
});
