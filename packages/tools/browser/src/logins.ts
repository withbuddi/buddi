/**
 * A sign-in the owner just made, kept for them by buddi itself
 * (docs/browser.md, "Saving a sign-in"; docs/owner-secrets.md §6).
 *
 * While the owner holds a page — the remote hand on buddi's own browser, or a
 * held tab in their Chrome — the page side watches for a credential form
 * going out: a form with a password field submitted (Enter or a click), or a
 * fetch right after the password changed with the field gone. What it saw, the
 * user name and the password, comes here and nowhere else: not to a model, not
 * to a transcript, not to a tool result, not to a log line.
 *
 * Buddi's own browser asks the owner afterwards: the pair waits in this
 * process for two minutes while the Page tab shows "Save this login for
 * amazon.com?" (the socket carries the site and the user name, never the
 * password), and goes when the owner decides or the two minutes are up. In
 * the owner's Chrome the question is asked in the tab itself, so what arrives
 * here has already been decided.
 *
 * Save hands the pair to the owner-secret store the gateway gave this keeper
 * (`useStore`): the password as the secret `login · amazon.com`, bound as
 * `browser.field` to the origin the form sat on — the same binding the sign-in
 * card's "Save a login for next time" makes, so `secret.fill` finds it — and
 * the user name kept beside it as a label, which is not a secret. Never
 * remembers the site. The labels and the never-list are a small file in the
 * plugin's directory; the password is never written by this module.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { siteListed, siteOf } from './routes.js';
import { canonicalOrigin, FIELD_KIND } from './secrets.js';

/** How long a seen sign-in waits for the owner before its password is dropped. */
export const LOGIN_HOLD_MS = 2 * 60_000;
/** Where a captured login may go: the field kind, first use asks the owner. */
export const LOGIN_RULE = 'first-time' as const;
export { FIELD_KIND as LOGIN_KIND };

export type LoginDecision = 'save' | 'later' | 'never';

/** What the page side saw. The password lives in this object and in the keeper's memory only. */
export interface SeenLogin {
  /** The origin of the frame the form sat on, as the backend read it. */
  origin: string;
  username: string;
  password: string;
}

/** What the owner is asked about: the site and the user name. Never the password. */
export interface LoginPrompt {
  id: string;
  sessionId: string;
  site: string;
  username: string;
  /** A login kept for this site and user name already: the question is "Update the login for amazon.com?", and Save replaces its value. */
  update?: true;
}

/** A login buddi kept for the owner: the secret's name, where it may go, and the label. */
export interface SavedLogin {
  name: string;
  site: string;
  origin: string;
  username: string;
  savedAt: string;
  /**
   * HMAC-SHA256 of the password, hex, under this install's key (`LoginStoreKey`):
   * on disk beside the label, so a sign-in with the same password stays quiet
   * across restarts and a new one asks to update. Never the password; the key
   * lives in the vault, not in this file. Absent on a login saved before it existed.
   */
  mark?: string;
}

/** What the store gets: the secret's name and value, and where it may go. */
export interface LoginStoreInput {
  name: string;
  value: string;
  bindings: Array<{ kind: typeof FIELD_KIND; target: string; rule: typeof LOGIN_RULE }>;
}
/** The owner-secret store, handed in by the gateway. */
export type LoginStore = (input: LoginStoreInput) => Promise<void>;
/** The names the owner-secret store holds now (names only), so a new login never takes one already there. */
export type LoginStoreNames = () => Promise<readonly string[]>;
/** This install's key for the saved passwords' marks, from the vault (made once). Null when there is no vault to keep one. */
export type LoginStoreKey = () => Promise<Buffer | null>;
/** What a sign-in seen in the owner's Chrome should be asked about, if anything. */
export type LoginAsk = 'save' | 'update' | 'none';

export type LoginOutcome = 'saved' | 'dismissed' | 'never' | 'gone';

interface Pending {
  prompt: LoginPrompt;
  origin: string;
  password: string;
  timer: ReturnType<typeof setTimeout>;
}

interface LoginFile { saved: SavedLogin[]; never: string[] }

/**
 * The owner's word for a captured login, and what agents ask for it by. The
 * login already kept for this site and user name keeps its name (Save then
 * replaces its value); otherwise the first name that neither another kept
 * login nor any other secret in the store (`existing`) holds.
 */
export function loginName(site: string, username: string, saved: readonly SavedLogin[], existing: ReadonlySet<string> = new Set()): string {
  const mine = saved.find((login) => login.site === site && login.username === username);
  if (mine) return mine.name;
  const free = (name: string): boolean => !saved.some((login) => login.name === name) && !existing.has(name);
  const plain = `login · ${site}`;
  if (free(plain)) return plain;
  const named = `login · ${site} · ${username}`.slice(0, 120);
  if (free(named)) return named;
  for (let n = 2; n < 100; n++) {
    const numbered = `${named.slice(0, 112)} · ${n}`;
    if (free(numbered)) return numbered;
  }
  return `${named.slice(0, 100)} · ${randomUUID().slice(0, 8)}`;
}

/** A user name as Settings says it: an address's mailbox and "@…", anything long cut short. */
export function shortUsername(username: string): string {
  const at = username.indexOf('@');
  if (at > 0) return `${username.slice(0, Math.min(at, 24))}@…`;
  return username.length > 24 ? `${username.slice(0, 23)}…` : username;
}

const MAX_USERNAME = 200;
const MAX_PASSWORD = 1024;

/** A seen login worth asking about: an http(s) origin, a password, a sane user name. */
function usable(login: SeenLogin): { origin: string; site: string; username: string } | undefined {
  const origin = canonicalOrigin(login.origin);
  if (!origin) return undefined;
  if (typeof login.password !== 'string' || login.password === '' || login.password.length > MAX_PASSWORD) return undefined;
  const username = typeof login.username === 'string' ? login.username.trim().slice(0, MAX_USERNAME) : '';
  if (/[\u0000-\u001f\u007f]/.test(username)) return undefined;
  const site = siteOf(origin);
  return site ? { origin, site, username } : undefined;
}

export class LoginKeeper {
  #pending = new Map<string, Pending>();
  #listeners = new Set<(prompt: LoginPrompt) => void>();
  #store?: LoginStore;
  #names?: LoginStoreNames;
  #state: LoginFile = { saved: [], never: [] };
  #loaded?: Promise<void>;
  #writing: Promise<unknown> = Promise.resolve();
  /** One save at a time per site: the name is picked and stored before the next save there looks. */
  #saving = new Map<string, Promise<unknown>>();
  #keyFor?: LoginStoreKey;
  /** The install's key once read; a key that could not be read is not remembered, so the next sign-in tries again. */
  #key?: Buffer;
  /**
   * Marks made with a key of this process's own, when the vault had none to
   * give: in memory only, so they never pass for the install's.
   */
  #fallbackMarks = new Map<string, Buffer>();
  readonly #fallbackKey = randomBytes(32);
  constructor(readonly file: string | undefined, readonly options: { holdMs?: number; now?: () => number } = {}) {}

  /** The gateway's owner-secret store, the names it holds, and the install's key for the marks; without a store, Save says so. */
  useStore(store: LoginStore, names?: LoginStoreNames, key?: LoginStoreKey): void { this.#store = store; this.#names = names; this.#keyFor = key; this.#key = undefined; }

  async #installKey(): Promise<Buffer | undefined> {
    if (this.#key) return this.#key;
    try {
      const key = await this.#keyFor?.();
      if (key && key.length >= 16) this.#key = key;
    } catch { /* no vault right now: this process's own key, in memory */ }
    return this.#key;
  }

  /** The password's mark: the install's (kept on disk) when there is a key, else this process's (memory only). */
  async #markOf(password: string): Promise<{ mark: Buffer; durable: boolean }> {
    const key = await this.#installKey();
    return { mark: createHmac('sha256', key ?? this.#fallbackKey).update(password).digest(), durable: key !== undefined };
  }

  /** True when this password is the one kept for the login, as far as its mark says; undefined when no mark says either way. */
  async #samePassword(kept: SavedLogin, password: string): Promise<boolean | undefined> {
    const { mark, durable } = await this.#markOf(password);
    const known = durable && typeof kept.mark === 'string' && /^[0-9a-f]{64}$/.test(kept.mark) ? Buffer.from(kept.mark, 'hex') : !durable ? this.#fallbackMarks.get(kept.name) : undefined;
    if (!known) return undefined;
    return timingSafeEqual(known, mark);
  }

  /**
   * What to ask about a sign-in: nothing (no password, a never-listed site,
   * the kept password again), Save (no login kept for this user name), or
   * Update (a kept login whose password differs, or one saved before marks
   * existed — asked once, then its mark is kept on Save).
   */
  async #assess(login: SeenLogin): Promise<{ facts: { origin: string; site: string; username: string }; ask: Exclude<LoginAsk, 'none'> } | undefined> {
    const facts = usable(login);
    if (!facts || siteListed(facts.site, this.#state.never)) return undefined;
    const kept = this.#kept(facts.site, facts.username);
    if (!kept) return { facts, ask: 'save' };
    return (await this.#samePassword(kept, login.password)) === true ? undefined : { facts, ask: 'update' };
  }

  /** The owner's Chrome asking before it asks the owner: what this sign-in is worth asking. The password is compared, never kept. */
  async check(login: SeenLogin): Promise<LoginAsk> {
    await this.load();
    return (await this.#assess(login))?.ask ?? 'none';
  }
  get canSave(): boolean { return this.#store !== undefined; }

  /** Read the labels and the never-list once. A missing or broken file is an empty one. */
  load(): Promise<void> {
    this.#loaded ??= (async () => {
      if (!this.file) return;
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LoginFile>;
        this.#state = {
          saved: Array.isArray(raw.saved) ? raw.saved.filter((login): login is SavedLogin => typeof login?.name === 'string' && typeof login.site === 'string') : [],
          never: Array.isArray(raw.never) ? raw.never.filter((site): site is string => typeof site === 'string') : [],
        };
      } catch { /* none yet */ }
    })();
    return this.#loaded;
  }

  #persist(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify(this.#state);
    const next = this.#writing.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, file);
    });
    this.#writing = next;
    return next;
  }

  /** Hear every new question for the owner. Returns the unsubscribe. */
  onSeen(listener: (prompt: LoginPrompt) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Sites the owner said Never for. */
  never(): string[] { return [...this.#state.never]; }
  /** Logins buddi kept, labels only. */
  saved(): SavedLogin[] { return this.#state.saved.map(({ mark: _mark, ...login }) => ({ ...login })); }

  /** The questions still open, for one page or all. */
  pending(sessionId?: string): LoginPrompt[] {
    return [...this.#pending.values()].filter((entry) => sessionId === undefined || entry.prompt.sessionId === sessionId).map((entry) => ({ ...entry.prompt }));
  }

  /** The login already kept for this site and user name, if any. */
  #kept(site: string, username: string): SavedLogin | undefined {
    return this.#state.saved.find((login) => login.site === site && login.username === username);
  }

  #expire(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.#pending.delete(id); }, this.options.holdMs ?? LOGIN_HOLD_MS);
    timer.unref?.();
    return timer;
  }

  /**
   * The owner's own browser saw a sign-in go out. Held for two minutes; the
   * listeners hear the site and the user name. Undefined when there is
   * nothing to ask: no password, a site on the never-list, or a login kept
   * with this user name and this password (its mark says so). A kept login
   * whose password differs, or one saved before marks existed, is asked about
   * as an update.
   */
  async seen(sessionId: string, login: SeenLogin): Promise<LoginPrompt | undefined> {
    await this.load();
    const assessed = await this.#assess(login);
    if (!assessed) return undefined;
    const { facts } = assessed;
    const kept = assessed.ask === 'update';
    // The same sign-in again (a second click on the button): one question, the newest password, two fresh minutes.
    const again = [...this.#pending.values()].find((entry) => entry.prompt.sessionId === sessionId && entry.prompt.site === facts.site && entry.prompt.username === facts.username);
    if (again) {
      again.password = login.password;
      again.origin = facts.origin;
      clearTimeout(again.timer);
      again.timer = this.#expire(again.prompt.id);
      return { ...again.prompt };
    }
    const prompt: LoginPrompt = { id: randomUUID(), sessionId, site: facts.site, username: facts.username, ...(kept ? { update: true as const } : {}) };
    this.#pending.set(prompt.id, { prompt, origin: facts.origin, password: login.password, timer: this.#expire(prompt.id) });
    for (const listener of this.#listeners) {
      try { listener({ ...prompt }); } catch { /* a listener never decides */ }
    }
    return { ...prompt };
  }

  #take(id: string): Pending | undefined {
    const entry = this.#pending.get(id);
    if (!entry) return undefined;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  /**
   * The owner's answer to one question. `gone` when its two minutes are up. A
   * Save the store refuses throws and leaves the question open, so the owner
   * can try again while the two minutes last.
   */
  async decide(id: string, decision: LoginDecision): Promise<{ outcome: LoginOutcome; saved?: SavedLogin }> {
    await this.load();
    const entry = this.#take(id);
    if (!entry) return { outcome: 'gone' };
    try {
      return await this.#apply(entry.prompt.site, entry.origin, entry.prompt.username, entry.password, decision);
    } catch (error) {
      if (!this.#pending.has(id)) this.#pending.set(id, { ...entry, timer: this.#expire(id) });
      throw error;
    }
  }

  /**
   * A sign-in the owner already answered in their own Chrome's tab: Save
   * with the pair, Never with the site alone.
   */
  async decided(login: Omit<SeenLogin, 'password'> & { password?: string }, decision: 'save' | 'never'): Promise<{ outcome: LoginOutcome; saved?: SavedLogin }> {
    await this.load();
    const facts = usable({ ...login, password: login.password ?? (decision === 'never' ? '-' : '') });
    if (!facts) return { outcome: 'gone' };
    return this.#apply(facts.site, facts.origin, facts.username, login.password ?? '', decision);
  }

  async #apply(site: string, origin: string, username: string, password: string, decision: LoginDecision): Promise<{ outcome: LoginOutcome; saved?: SavedLogin }> {
    if (decision === 'later') return { outcome: 'dismissed' };
    if (decision === 'never') {
      if (!siteListed(site, this.#state.never)) this.#state.never = [...this.#state.never, site].slice(-500);
      for (const [id, entry] of this.#pending) if (entry.prompt.site === site) this.#take(id);
      await this.#persist();
      return { outcome: 'never' };
    }
    const store = this.#store;
    if (!store) throw new Error('This buddi has nowhere to keep a login right now.');
    if (password === '') return { outcome: 'gone' };
    // One site at a time: two accounts saved at once must not pick the same name, or the second replaces the first.
    const before = this.#saving.get(site) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(async () => {
      const existing = new Set(this.#names ? await this.#names() : []);
      const name = loginName(site, username, this.#state.saved, existing);
      await store({ name, value: password, bindings: [{ kind: FIELD_KIND, target: origin, rule: LOGIN_RULE }] });
      const { mark, durable } = await this.#markOf(password);
      if (!durable) this.#fallbackMarks.set(name, mark);
      const saved: SavedLogin = { name, site, origin, username, savedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), ...(durable ? { mark: mark.toString('hex') } : {}) };
      this.#state.saved = [...this.#state.saved.filter((login) => login.name !== name), saved].slice(-500);
      await this.#persist();
      const { mark: _mark, ...label } = saved;
      return { outcome: 'saved' as const, saved: label };
    });
    this.#saving.set(site, run);
    try { return await run; }
    finally { if (this.#saving.get(site) === run) this.#saving.delete(site); }
  }

  /** The secret behind a label is gone (Settings → Remove): drop the label. */
  async forget(name: string): Promise<boolean> {
    await this.load();
    const before = this.#state.saved.length;
    this.#state.saved = this.#state.saved.filter((login) => login.name !== name);
    this.#fallbackMarks.delete(name);
    if (this.#state.saved.length === before) return false;
    await this.#persist();
    return true;
  }

  /** The secret behind a label was renamed (Settings → Rename): the label follows it. */
  async rename(from: string, to: string): Promise<boolean> {
    await this.load();
    const login = this.#state.saved.find((entry) => entry.name === from);
    if (!login || from === to) return false;
    this.#state.saved = [...this.#state.saved.filter((entry) => entry.name !== from && entry.name !== to), { ...login, name: to }];
    const mark = this.#fallbackMarks.get(from);
    this.#fallbackMarks.delete(from);
    if (mark) this.#fallbackMarks.set(to, mark);
    await this.#persist();
    return true;
  }

  /** Every held password goes. */
  clear(): void {
    for (const id of [...this.#pending.keys()]) this.#take(id);
  }
}

/* ---------------- the page side ---------------- */

/**
 * Watch one document for a sign-in going out, and report the pair.
 *
 * Serialised into the page (buddi's own browser runs it in an isolated world
 * the page's scripts cannot see), so it is self-contained: it reads the DOM it
 * shares with the page and touches nothing. A sign-in is a form with a filled
 * password field submitted, Enter in a field of it, a click on its button, or
 * a fetch right after the password changed that left the field gone or empty
 * (a page that signs in without a form). A click on a show-password eye, a
 * Forgot link or Cancel is not one.
 */
export function watchLogins(report: (found: { username: string; password: string }) => void): void {
  const holder = globalThis as unknown as Record<string, { report: typeof report } | undefined>;
  const existing = holder['__buddiLoginWatch'];
  if (existing) { existing.report = report; return; }
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc) return;
  const state = { report, last: '', lastAt: 0, typedAt: 0, cached: undefined as { username: string; password: string } | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  holder['__buddiLoginWatch'] = state;
  const NOT_SUBMIT = /\b(show|hide|reveal|toggle|eye|forgot|reset|cancel|back|close|sign ?up|register|create)\b/i;
  const USER = /user|email|login|account|ident|phone|mail/i;
  const passwords = (root: ParentNode): HTMLInputElement[] => Array.from(root.querySelectorAll('input[type="password" i]')) as HTMLInputElement[];
  const usernameFor = (password: HTMLInputElement): string => {
    const scope: ParentNode = password.form ?? doc;
    const inputs = (Array.from(scope.querySelectorAll('input')) as HTMLInputElement[])
      .filter((input) => ['text', 'email', 'tel', ''].includes((input.getAttribute('type') ?? '').toLowerCase()) && input.value.trim() !== '');
    const marked = inputs.find((input) => (input.getAttribute('autocomplete') ?? '').toLowerCase().includes('username') || (input.getAttribute('type') ?? '').toLowerCase() === 'email');
    if (marked) return marked.value.trim();
    const before = inputs.filter((input) => (input.compareDocumentPosition(password) & 4) !== 0);
    const pick = before[before.length - 1] ?? inputs.find((input) => USER.test(`${input.name} ${input.id} ${input.getAttribute('autocomplete') ?? ''}`));
    return pick ? pick.value.trim() : '';
  };
  const read = (scope: ParentNode | null | undefined): { username: string; password: string } | undefined => {
    const field = passwords(scope ?? doc).find((input) => input.value !== '');
    return field ? { username: usernameFor(field), password: field.value } : undefined;
  };
  const send = (found: { username: string; password: string } | undefined): void => {
    if (!found || found.password === '') return;
    const key = `${found.username}\u0000${found.password}`;
    const now = Date.now();
    if (key === state.last && now - state.lastAt < 5_000) return;
    state.last = key;
    state.lastAt = now;
    state.cached = undefined;
    try { state.report(found); } catch { /* the reporter is buddi's; a failure is not the page's business */ }
  };
  doc.addEventListener('submit', (event) => { send(read(event.target as HTMLFormElement | null) ?? state.cached); }, true);
  doc.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    const target = event.target as HTMLInputElement | null;
    if (!target || target.tagName !== 'INPUT') return;
    send(read(target.form ?? doc));
  }, true);
  doc.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const button = target?.closest?.('button, input[type="submit" i], input[type="image" i], input[type="button" i], [role="button"]') as HTMLButtonElement | null | undefined;
    if (!button) return;
    const words = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('value') ?? ''} ${button.getAttribute('title') ?? ''}`;
    if (NOT_SUBMIT.test(words)) return;
    send(read(button.form ?? doc));
  }, true);
  doc.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | null;
    if ((target?.getAttribute?.('type') ?? '').toLowerCase() !== 'password') return;
    state.typedAt = Date.now();
    state.cached = read(target!.form ?? doc);
  }, true);
  const Observer = (globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof Observer === 'function') {
    try {
      new Observer((list) => {
        if (!state.cached || Date.now() - state.typedAt > 10_000) return;
        const fetched = list.getEntries().some((entry) => ['fetch', 'xmlhttprequest'].includes((entry as PerformanceResourceTiming).initiatorType));
        if (!fetched) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          const still = passwords(doc).some((input) => input.isConnected && input.value !== '' && input.getClientRects().length > 0);
          if (!still) send(state.cached);
        }, 1_500);
      }).observe({ type: 'resource', buffered: false });
    } catch { /* no resource timing here */ }
  }
}

/** The binding the isolated world reports through, and its world's name. */
export const LOGIN_BINDING = '__buddiLoginSeen';
export const LOGIN_WORLD = 'buddi-login-watch';

/** The script buddi's own browser runs in that world: the watcher, reporting through the binding with the frame's own origin. */
export function loginWatchSource(): string {
  return `(${watchLogins.toString()})((found) => { try { globalThis[${JSON.stringify(LOGIN_BINDING)}](JSON.stringify({ origin: location.origin, username: found.username, password: found.password })); } catch {} });`;
}

/** The binding's payload, read strictly. Undefined for anything else. */
export function readLoginPayload(payload: unknown): SeenLogin | undefined {
  if (typeof payload !== 'string' || payload.length > 4096) return undefined;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (typeof parsed.origin !== 'string' || typeof parsed.username !== 'string' || typeof parsed.password !== 'string') return undefined;
    return { origin: parsed.origin, username: parsed.username, password: parsed.password };
  } catch { return undefined; }
}
