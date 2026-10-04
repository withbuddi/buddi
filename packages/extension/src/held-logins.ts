/*
 * A sign-in seen in a held tab, waiting in the worker for the owner's answer
 * (docs/browser.md, "Saving a sign-in").
 *
 * The form that carried the sign-in usually navigates or redirects the moment
 * it goes out, and that takes the page — and anything kept in it — away
 * before the owner can press Save. So the pair waits here, in the worker's
 * memory, keyed by the tab: one per held tab, for two minutes, gone when the
 * tab is given back or closed. The page the tab lands on asks for it and
 * draws the question again on any page of the same site, still naming the
 * site the form sat on; Save sends the pair with that original origin.
 *
 * Before the tab asks anything, buddi's login keeper is asked whether the
 * sign-in is worth a question (`check`): a login it keeps with this password
 * already is not, one with a different password is an Update. The keeper
 * compares a keyed hash and keeps nothing; this worker does not know the key.
 *
 * Nothing here is written down or logged. A Save is answered by buddi with
 * what became of it (`loginAck`), which the page is told: Saved, or why not.
 */

import type { LoginFrame } from './bar.js';

/** How long a seen sign-in waits for the owner. */
export const HELD_LOGIN_MS = 2 * 60_000;
/** How long a Save waits for buddi to say what became of it. */
export const LOGIN_ACK_MS = 20_000;
/** How long the tab waits for buddi's word on whether to ask at all; then it asks as the hold said. */
export const LOGIN_CHECK_MS = 5_000;
export const NO_ANSWER = 'buddi did not answer. Try again.';
const GONE = 'That question is gone; add the login in Settings → Keys and secrets.';

/** What the page is told: the question to draw, never the password. */
export interface HeldLoginQuestion { site: string; username: string; update: boolean }
export type HeldLoginAnswer = { saved: true } | { saved: false; reason: string };
/** What buddi says back, by the id a frame carried. */
export type LoginAckAnswer = HeldLoginAnswer | { ask: 'save' | 'update' | 'none' };

interface Entry {
  tabId: number;
  session: string;
  origin: string;
  site: string;
  username: string;
  password: string;
  update: boolean;
  timer: ReturnType<typeof setTimeout>;
  /** buddi's word on whether to ask; settled once, and a page that lands while it is on the way waits for it. */
  checked: Promise<boolean>;
}

/** The site a page belongs to, as the bar names it: the host without `www.`. */
export function siteName(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Two hosts of one site: the last two labels, or three under a two-letter
 * country code with a short second level (`co.uk`, `com.au`). A heuristic —
 * the extension has no public-suffix list — used only to decide whether a
 * page may show a question the same tab asked a moment ago.
 */
export function siteKey(host: string): string {
  const labels = siteName(host).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [second, top] = labels.slice(-2) as [string, string];
  const keep = top.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function webOrigin(url: string | undefined): URL | undefined {
  try {
    const parsed = new URL(url ?? '');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : undefined;
  } catch { return undefined; }
}

export class HeldLogins {
  #byTab = new Map<number, Entry>();
  /** Frames waiting for buddi's answer, by id. */
  #waiting = new Map<string, { tabId: number; resolve: (answer: LoginAckAnswer | undefined) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly send: (frame: LoginFrame) => void, private readonly options: { holdMs?: number; ackMs?: number; checkMs?: number; uuid?: () => string } = {}) {}

  #id(): string { return (this.options.uuid ?? (() => crypto.randomUUID()))(); }

  /** Send a frame and wait for buddi's answer to it; undefined when none comes in time or the tab's pair goes. */
  #ask(tabId: number, frame: LoginFrame, ms: number): Promise<LoginAckAnswer | undefined> {
    const id = this.#id();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#waiting.delete(id); resolve(undefined); }, ms);
      this.#waiting.set(id, { tabId, resolve, timer });
      this.send({ ...frame, id });
    });
  }

  /**
   * A sign-in went out in a held tab: keep the pair, with the origin Chrome
   * reports for the page (never the page's claim), and ask buddi whether it
   * is worth a question. Replaces whatever this tab was waiting on. Resolves
   * to the question to draw, or undefined: a page not on the web, or nothing
   * to ask (the pair is dropped then). With no word from buddi in time, the
   * tab asks as the hold's facts said (`pair.update`).
   */
  async capture(tabId: number, session: string, url: string | undefined, pair: { username: string; password: string; update?: boolean }): Promise<HeldLoginQuestion | undefined> {
    const where = webOrigin(url);
    if (!where || pair.password === '' || pair.password.length > 1024) return undefined;
    this.clearTab(tabId);
    let settle: (ask: boolean) => void = () => {};
    const entry: Entry = {
      tabId, session, origin: where.origin, site: siteName(where.hostname), username: pair.username.slice(0, 200), password: pair.password,
      update: pair.update === true, timer: setTimeout(() => this.clearTab(tabId), this.options.holdMs ?? HELD_LOGIN_MS),
      checked: new Promise<boolean>((resolve) => { settle = resolve; }),
    };
    this.#byTab.set(tabId, entry);
    const word = await this.#ask(tabId, { type: 'login', session, decision: 'check', origin: entry.origin, username: entry.username, password: entry.password }, this.options.checkMs ?? LOGIN_CHECK_MS);
    if (this.#byTab.get(tabId) !== entry) { settle(false); return undefined; }
    if (word && 'ask' in word) {
      if (word.ask === 'none') { this.clearTab(tabId); settle(false); return undefined; }
      entry.update = word.ask === 'update';
    }
    settle(true);
    return { site: entry.site, username: entry.username, update: entry.update };
  }

  /** The question still waiting in this tab, for a page of the same site (once buddi said it is worth asking). */
  async pending(tabId: number, session: string, url: string | undefined): Promise<HeldLoginQuestion | undefined> {
    const entry = this.#byTab.get(tabId);
    const where = webOrigin(url);
    if (!entry || entry.session !== session || !where || siteKey(where.hostname) !== siteKey(entry.site)) return undefined;
    if (!(await entry.checked) || this.#byTab.get(tabId) !== entry) return undefined;
    return { site: entry.site, username: entry.username, update: entry.update };
  }

  /** Save: the pair goes to buddi with the original origin; the answer is what buddi says became of it. */
  async save(tabId: number, session: string): Promise<HeldLoginAnswer> {
    const entry = this.#byTab.get(tabId);
    if (!entry || entry.session !== session) return { saved: false, reason: GONE };
    const answer = await this.#ask(tabId, { type: 'login', session: entry.session, decision: 'save', origin: entry.origin, username: entry.username, password: entry.password }, this.options.ackMs ?? LOGIN_ACK_MS);
    if (!answer || !('saved' in answer)) return { saved: false, reason: NO_ANSWER };
    // Saved: the pair goes. Not saved: it stays for another try while the two minutes last.
    if (answer.saved && this.#byTab.get(tabId) === entry) this.clearTab(tabId);
    return answer;
  }

  /** Never for this site: the site alone goes to buddi, and the pair is dropped. */
  never(tabId: number, session: string): boolean {
    const entry = this.#byTab.get(tabId);
    if (!entry || entry.session !== session) return false;
    this.clearTab(tabId);
    this.send({ type: 'login', session: entry.session, decision: 'never', origin: entry.origin, username: entry.username });
    return true;
  }

  /** Not now: nothing goes anywhere. */
  dismiss(tabId: number, session: string): void {
    const entry = this.#byTab.get(tabId);
    if (entry && entry.session === session) this.clearTab(tabId);
  }

  /** buddi's answer to a frame this worker sent. */
  ack(id: string, answer: LoginAckAnswer): void {
    const waiting = this.#waiting.get(id);
    if (!waiting) return;
    this.#waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(answer);
  }

  clearTab(tabId: number): void {
    const entry = this.#byTab.get(tabId);
    if (entry) {
      this.#byTab.delete(tabId);
      clearTimeout(entry.timer);
      entry.password = '';
    }
    for (const [id, waiting] of this.#waiting) {
      if (waiting.tabId !== tabId) continue;
      this.#waiting.delete(id);
      clearTimeout(waiting.timer);
      waiting.resolve(undefined);
    }
  }

  clearSession(session: string): void {
    for (const entry of [...this.#byTab.values()]) if (entry.session === session) this.clearTab(entry.tabId);
  }

  clear(): void {
    for (const tabId of [...this.#byTab.keys()]) this.clearTab(tabId);
  }

  get size(): number { return this.#byTab.size; }
}
