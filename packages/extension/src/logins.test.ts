/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://www.example.com/signin"}
 *
 * Saving a sign-in in a tab the owner holds (docs/browser.md, "Saving a
 * sign-in"): the page side sees the form go out, the waiting bar asks "Save
 * this login for example.com?", Save posts the pair to the worker, Not now
 * posts nothing, Never posts the site alone and asks no more; the worker
 * believes an answer only from the held tab, with the origin Chrome reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideHeldBar, loginFrame, showHeldBar, watchHeldLogins } from './bar.js';

const PASSWORD = 'fixture-pass-7Qz!';
type Choice = { label: string; primary?: boolean; pick: () => void };
const holder = globalThis as unknown as Record<string, unknown>;

let asked: Array<{ question: string; choices: Choice[] }>;
let posted: unknown[];
beforeEach(() => {
  asked = [];
  posted = [];
  delete holder['__buddiHeldLogins'];
  holder['__buddiHeldAsk'] = (question: string, choices: Choice[]) => { asked.push({ question, choices }); return () => {}; };
  holder['chrome'] = { runtime: { sendMessage: vi.fn(async (message: unknown) => { posted.push(message); }) } };
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

describe('a held tab offers to save a sign-in', () => {
  it('asks in the bar when the form goes out, and Save posts the pair', () => {
    watchHeldLogins('s1', { never: [], saved: [] });
    submit(fill('sam@example.com', PASSWORD));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe('Save this login for example.com?');
    expect(asked[0]!.choices.map((choice) => choice.label)).toEqual(['Save', 'Not now', 'Never for this site']);
    expect(posted).toEqual([]);
    pick('Save');
    expect(posted).toEqual([{ type: 'buddi-login', session: 's1', decision: 'save', username: 'sam@example.com', password: PASSWORD }]);
    // Pressed twice, sent once: the pair is gone after the first.
    pick('Save');
    expect(posted).toHaveLength(1);
  });

  it('Not now posts nothing', () => {
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    pick('Not now');
    expect(posted).toEqual([]);
  });

  it('Never posts the site alone, never the password, and asks no more there', () => {
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    pick('Never for this site');
    expect(posted).toEqual([{ type: 'buddi-login', session: 's1', decision: 'never', username: 'sam@example.com' }]);
    expect(JSON.stringify(posted)).not.toContain(PASSWORD);
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

  it('asks nothing for a site buddi was told never to ask about, a login already kept, or an empty password', () => {
    watchHeldLogins('s1', { never: ['example.com'], saved: [] });
    submit(fill('sam@example.com', PASSWORD));
    expect(asked).toEqual([]);
    delete holder['__buddiHeldLogins'];
    // A new page in the tab: a fresh watch, told about a kept login.
    watchHeldLogins('s1', { never: [], saved: [{ site: 'example.com', username: 'sam@example.com' }] });
    submit(fill('sam@example.com', PASSWORD));
    expect(asked).toEqual([]);
    submit(fill('sam@example.com', ''));
    expect(asked).toEqual([]);
  });

  it('the waiting bar is where it asks, and a tab given back has nowhere to ask', () => {
    delete holder['__buddiHeldAsk'];
    showHeldBar('s1');
    expect(typeof holder['__buddiHeldAsk']).toBe('function');
    hideHeldBar();
    expect(holder['__buddiHeldAsk']).toBeUndefined();
    watchHeldLogins('s1', null);
    submit(fill('sam@example.com', PASSWORD));
    expect(posted).toEqual([]);
  });
});

describe('the worker believes an answer only from the held tab', () => {
  const save = { type: 'buddi-login', session: 's1', decision: 'save', username: 'sam', password: PASSWORD };
  it('takes the origin from Chrome’s sender, not the page', () => {
    expect(loginFrame({ ...save, origin: 'https://evil.test' }, { tab: { id: 4 }, url: 'https://www.example.com/signin?x=1' }, 4))
      .toEqual({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.example.com', username: 'sam', password: PASSWORD });
  });
  it('refuses another tab, no held tab, a non-web page and a Save without a password', () => {
    expect(loginFrame(save, { tab: { id: 5 }, url: 'https://www.example.com/' }, 4)).toBeUndefined();
    expect(loginFrame(save, { tab: { id: 4 }, url: 'https://www.example.com/' }, undefined)).toBeUndefined();
    expect(loginFrame(save, { tab: { id: 4 }, url: 'chrome://settings' }, 4)).toBeUndefined();
    expect(loginFrame({ ...save, password: '' }, { tab: { id: 4 }, url: 'https://www.example.com/' }, 4)).toBeUndefined();
  });
  it('Never carries no password', () => {
    expect(loginFrame({ ...save, decision: 'never' }, { tab: { id: 4 }, url: 'https://www.example.com/' }, 4))
      .toEqual({ type: 'login', session: 's1', decision: 'never', origin: 'https://www.example.com', username: 'sam' });
  });
});
