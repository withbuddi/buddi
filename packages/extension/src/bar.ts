/*
 * "buddi is working here" — the in-tab bar (docs/browser.md, "Work in view").
 *
 * The owner's active tab is never typed into behind their back. When an agent
 * needs a buddi tab the owner is looking at, the worker waits for them to
 * leave it, up to 30 seconds. After 3 seconds it shows a thin bar in the tab:
 * "buddi is working here · Take over · Let it continue". Let it continue lets
 * the agent act in view; Take over hands the tab to the owner exactly like
 * the Canvas button (the worker tells the gateway, which pauses the page).
 *
 * The wait is pure (`waitForOwner`, with the probes handed in) so it is
 * testable without Chrome; the three page functions are serialised into the
 * tab by `chrome.scripting` and touch nothing but their own element.
 */

/** Where the page side keeps the owner's choice until the worker reads it. */
export const BAR_KEY = '__buddiBar';
export const BAR_ID = 'buddi-working-bar';
export type BarChoice = 'continue' | 'takeover';
export type WaitOutcome = 'left' | BarChoice | 'timeout';

/** The longest wait for the owner to leave the tab. */
export const OWNER_WAIT_MS = 30_000;
/** The bar appears after this, so the owner knows why nothing moved. */
export const BAR_AFTER_MS = 3_000;
export const BAR_POLL_MS = 500;

export interface WaitProbes {
  /** The owner is looking at the tab right now (active in a focused window). */
  watched(): Promise<boolean>;
  show(): Promise<void>;
  hide(): Promise<void>;
  /** The owner's tap on the bar, once; undefined until they tap. */
  choice(): Promise<BarChoice | undefined>;
  wait(ms: number): Promise<void>;
  now(): number;
}

/** Wait for the owner to leave the tab, or to answer the bar. Hides the bar whatever happens. */
export async function waitForOwner(probes: WaitProbes, limits: { waitMs?: number; barAfterMs?: number; pollMs?: number } = {}): Promise<WaitOutcome> {
  const waitMs = limits.waitMs ?? OWNER_WAIT_MS;
  const barAfter = limits.barAfterMs ?? BAR_AFTER_MS;
  const poll = limits.pollMs ?? BAR_POLL_MS;
  const start = probes.now();
  let shown = false;
  // Counted as well as timed: a clock that does not move must not hold the command forever.
  const maxPolls = Math.ceil(waitMs / poll);
  try {
    for (let polls = 0; ; polls++) {
      if (!(await probes.watched())) return 'left';
      const elapsed = Math.max(probes.now() - start, polls * poll);
      if (!shown && elapsed >= barAfter) { shown = true; await probes.show().catch(() => undefined); }
      if (shown) { const choice = await probes.choice().catch(() => undefined); if (choice) return choice; }
      if (elapsed >= waitMs || polls >= maxPolls) return 'timeout';
      await probes.wait(poll);
    }
  } finally {
    if (shown) await probes.hide().catch(() => undefined);
  }
}

/* ---- page side: serialised into the tab, so self-contained ---- */

/** Draw the bar at the top of the page. Idempotent. */
export function showBar(agent: string): void {
  const holder = globalThis as unknown as Record<string, { choice?: string } | undefined>;
  holder['__buddiBar'] = { choice: undefined };
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc || doc.getElementById('buddi-working-bar')) return;
  const host = doc.createElement('div');
  host.id = 'buddi-working-bar';
  host.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;all:initial;');
  const root = host.attachShadow({ mode: 'closed' });
  const bar = doc.createElement('div');
  bar.setAttribute('role', 'status');
  bar.setAttribute('style', 'position:fixed;top:0;left:0;right:0;display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:6px 16px;font:13px/1.4 system-ui,-apple-system,sans-serif;background:#1f2a44;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);');
  const label = doc.createElement('span');
  label.textContent = `${agent || 'buddi'} is working here`;
  label.setAttribute('style', 'margin-right:auto;');
  const button = (text: string, choice: string, primary: boolean) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('style', `font:inherit;cursor:pointer;border-radius:6px;padding:3px 10px;border:1px solid #fff;${primary ? 'background:#fff;color:#1f2a44;' : 'background:transparent;color:#fff;'}`);
    b.addEventListener('click', () => { holder['__buddiBar'] = { choice }; });
    return b;
  };
  bar.append(label, button('Take over', 'takeover', false), button('Let it continue', 'continue', true));
  root.append(bar);
  (doc.documentElement ?? doc.body).append(host);
}

/** The owner's tap, read once. */
export function readBar(): string | undefined {
  const holder = globalThis as unknown as Record<string, { choice?: string } | undefined>;
  const choice = holder['__buddiBar']?.choice;
  if (choice) holder['__buddiBar'] = { choice: undefined };
  return choice;
}

export function hideBar(): void {
  const doc = (globalThis as unknown as { document?: Document }).document;
  doc?.getElementById('buddi-working-bar')?.remove();
  const holder = globalThis as unknown as Record<string, unknown>;
  delete holder['__buddiBar'];
}

/* ---- the held tab: the owner has it, buddi waits ---- */

export const HELD_BAR_ID = 'buddi-held-bar';
/** What the held bar's Give it back sends the worker (runtime message). */
export const GIVE_BACK_MESSAGE = 'buddi-give-back';

/**
 * "buddi is waiting · Give it back" — drawn while the owner holds a tab they
 * took over from the Canvas or the working bar. Give it back tells the worker
 * (a runtime message, which only this extension's own scripts can send), and
 * the worker tells the gateway. Serialised into the tab: self-contained.
 */
export function showHeldBar(session: string): void {
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc || doc.getElementById('buddi-held-bar')) return;
  const host = doc.createElement('div');
  host.id = 'buddi-held-bar';
  host.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;all:initial;');
  const root = host.attachShadow({ mode: 'closed' });
  const bar = doc.createElement('div');
  bar.setAttribute('role', 'status');
  bar.setAttribute('style', 'position:fixed;top:0;left:0;right:0;display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:6px 16px;font:13px/1.4 system-ui,-apple-system,sans-serif;background:#1f2a44;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);');
  const label = doc.createElement('span');
  label.textContent = 'buddi is waiting';
  label.setAttribute('style', 'margin-right:auto;');
  const give = doc.createElement('button');
  give.type = 'button';
  give.textContent = 'Give it back';
  give.setAttribute('style', 'font:inherit;cursor:pointer;border-radius:6px;padding:3px 10px;border:1px solid #fff;background:#fff;color:#1f2a44;');
  give.addEventListener('click', () => {
    const runtime = (globalThis as unknown as { chrome?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } } }).chrome?.runtime;
    void runtime?.sendMessage({ type: 'buddi-give-back', session })?.catch?.(() => undefined);
    host.remove();
  });
  bar.append(label, give);
  root.append(bar);
  (doc.documentElement ?? doc.body).append(host);
  /*
   * The bar asks a question in place of "buddi is waiting" (the save-login
   * prompt, `watchHeldLogins`): the question, its buttons, and back to waiting
   * once one is pressed. Kept on this world's global, which only buddi's own
   * injected scripts share.
   */
  const asking: HTMLButtonElement[] = [];
  const restore = (): void => {
    for (const button of asking.splice(0)) button.remove();
    label.textContent = 'buddi is waiting';
    give.style.display = '';
  };
  (globalThis as unknown as Record<string, unknown>)['__buddiHeldAsk'] = (question: string, choices: Array<{ label: string; primary?: boolean; pick: () => void }>): () => void => {
    restore();
    label.textContent = question;
    give.style.display = 'none';
    for (const choice of choices) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = choice.label;
      b.setAttribute('style', `font:inherit;cursor:pointer;border-radius:6px;padding:3px 10px;border:1px solid #fff;${choice.primary ? 'background:#fff;color:#1f2a44;' : 'background:transparent;color:#fff;'}`);
      b.addEventListener('click', () => { restore(); choice.pick(); });
      asking.push(b);
      bar.insertBefore(b, give);
    }
    return restore;
  };
}

export function hideHeldBar(): void {
  const doc = (globalThis as unknown as { document?: Document }).document;
  doc?.getElementById('buddi-held-bar')?.remove();
  // A tab given back asks nothing more: the save prompt has no bar to ask in.
  delete (globalThis as unknown as Record<string, unknown>)['__buddiHeldAsk'];
}

/** The frame the worker sends the gateway when the owner pressed Take over in the working bar, or Give it back in the held one. */
export interface OwnerEventMessage { type: 'event'; name: 'takeover' | 'giveback'; session: string }

/** What the worker sends the gateway when the owner answers the save prompt: the password only with Save. */
export const LOGIN_MESSAGE = 'buddi-login';
/** How long the tab holds a seen sign-in waiting for Save; then the pair is dropped and the bar goes back to waiting. */
export const LOGIN_PROMPT_MS = 2 * 60_000;
/** What the gateway says the tab need not ask about. */
export interface HeldLoginFacts { never: string[]; saved: Array<{ site: string; username: string }> }

/**
 * Watch a held tab for a sign-in going out, and ask in its bar: "Save this
 * login for amazon.com?" Save · Not now · Never for this site — or, for a
 * login already kept with that user name, "Update the login for amazon.com?"
 * with Update (docs/browser.md, "Saving a sign-in").
 *
 * Serialised into the tab beside `showHeldBar`, in the same isolated world,
 * so it is self-contained; the detection is the browser plugin's
 * `watchLogins`, written out again here because a serialised function can
 * call nothing outside itself. The pair goes to the worker the moment the
 * form goes out (a runtime message only this extension's scripts can send)
 * and waits there, because the form's own navigation takes this page away;
 * the page the tab lands on asks the worker and asks the owner again. Save
 * tells the worker, which sends the pair to buddi on its authenticated
 * socket and says what became of it: "Saved" for two seconds, or why not
 * with Try again. Never sends the site alone; Not now drops the pair.
 * Nothing is logged, and two minutes after the sign-in the pair is dropped
 * whatever happened.
 */
export function watchHeldLogins(session: string, facts: HeldLoginFacts | null): void {
  const holder = globalThis as unknown as Record<string, unknown>;
  const known: HeldLoginFacts = { never: [...(facts?.never ?? [])], saved: [...(facts?.saved ?? [])] };
  const existing = holder['__buddiHeldLogins'] as { session: string; facts: HeldLoginFacts } | undefined;
  if (existing) { existing.session = session; existing.facts = known; return; }
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc) return;
  const state = { session, facts: known, last: '', lastAt: 0, typedAt: 0, cached: undefined as { username: string; password: string } | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined, drop: undefined as ReturnType<typeof setTimeout> | undefined };
  holder['__buddiHeldLogins'] = state;
  const runtime = (): { sendMessage(message: unknown): Promise<unknown> } | undefined =>
    (globalThis as unknown as { chrome?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } } }).chrome?.runtime;
  const call = async (message: unknown): Promise<unknown> => {
    try { return await runtime()?.sendMessage(message); } catch { return undefined; /* the worker is gone; nothing is kept */ }
  };
  const site = (): string => ((globalThis as unknown as { location?: Location }).location?.hostname ?? '').toLowerCase().replace(/^www\./, '');
  const listed = (where: string): boolean => state.facts.never.some((entry) => { const bare = entry.toLowerCase().replace(/^www\./, ''); return where === bare || where.endsWith(`.${bare}`); });
  type Choice = { label: string; primary?: boolean; pick: () => void };
  const bar = (): ((question: string, choices: Choice[]) => () => void) | undefined => {
    const question = holder['__buddiHeldAsk'];
    return typeof question === 'function' ? question as (question: string, choices: Choice[]) => () => void : undefined;
  };
  /** The question, as the worker holds it: the site the form sat on, the user name, whether it updates a kept login. */
  const prompt = (where: string, update: boolean): void => {
    const question = bar();
    if (!question) return;
    if (state.drop) clearTimeout(state.drop);
    let answered = false;
    const save = (): void => {
      if (answered) return;
      answered = true;
      const asking = bar();
      asking?.(update ? 'Updating…' : 'Saving…', []);
      void call({ type: 'buddi-login', session: state.session, decision: 'save' }).then((reply) => {
        const answer = reply as { saved?: unknown; reason?: unknown } | undefined;
        const now = bar();
        if (!now) return;
        if (answer?.saved === true) {
          const restore = now(update ? `Updated the login for ${where}` : `Saved the login for ${where}`, []);
          if (state.drop) clearTimeout(state.drop);
          state.drop = setTimeout(restore, 2_000);
          return;
        }
        const reason = typeof answer?.reason === 'string' && answer.reason !== '' ? answer.reason : 'buddi did not answer. Try again.';
        now(reason, [
          { label: 'Try again', primary: true, pick: () => { answered = false; save(); } },
          { label: 'Not now', pick: () => { void call({ type: 'buddi-login', session: state.session, decision: 'later' }); } },
        ]);
      });
    };
    const restore = question(update ? `Update the login for ${where}?` : `Save this login for ${where}?`, [
      { label: update ? 'Update' : 'Save', primary: true, pick: save },
      { label: 'Not now', pick: () => { answered = true; void call({ type: 'buddi-login', session: state.session, decision: 'later' }); } },
      { label: 'Never for this site', pick: () => {
        answered = true;
        state.facts.never.push(where);
        void call({ type: 'buddi-login', session: state.session, decision: 'never' });
      } },
    ]);
    state.drop = setTimeout(() => { if (!answered) restore(); }, 2 * 60_000);
  };
  const ask = (found: { username: string; password: string }): void => {
    const where = site();
    if (where === '' || listed(where) || !bar()) return;
    const update = state.facts.saved.some((login) => login.site === where && login.username === found.username);
    // The pair goes to the worker now (the form's navigation is about to take this page away), and buddi
    // says whether it is worth asking: nothing for the password it keeps already, Update for a new one.
    void call({ type: 'buddi-login-seen', session: state.session, username: found.username, password: found.password, update }).then((reply) => {
      const asked = reply as { update?: unknown } | null | undefined;
      if (holder['__buddiHeldLogins'] !== state || !asked || typeof asked !== 'object') return;
      prompt(where, asked.update === true);
    });
  };
  // A page the tab landed on after the form went out: the question the worker still holds, asked again here.
  void call({ type: 'buddi-login-pending', session: state.session }).then((reply) => {
    const waiting = reply as { site?: unknown; update?: unknown } | null | undefined;
    if (holder['__buddiHeldLogins'] !== state || !waiting || typeof waiting.site !== 'string') return;
    prompt(waiting.site, waiting.update === true);
  });
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
    // A watch that was replaced (the page's world reset under it) goes quiet.
    if (holder['__buddiHeldLogins'] !== state) return;
    if (!found || found.password === '') return;
    const key = `${found.username}\u0000${found.password}`;
    const now = Date.now();
    if (key === state.last && now - state.lastAt < 5_000) return;
    state.last = key;
    state.lastAt = now;
    state.cached = undefined;
    ask(found);
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

/**
 * The frame the worker sends the gateway when the owner answered the save
 * prompt in a held tab. The password only with Save, which carries an id the
 * gateway's `loginAck` names.
 */
export interface LoginFrame { type: 'login'; session: string; decision: 'save' | 'never' | 'check'; origin: string; username: string; password?: string; id?: string }

/** The tab told the worker a sign-in went out: kept in the worker until the owner answers. */
export const LOGIN_SEEN_MESSAGE = 'buddi-login-seen';
/** A page of a held tab asking whether a question is still waiting for it. */
export const LOGIN_PENDING_MESSAGE = 'buddi-login-pending';

/** What a held tab may ask the worker about a sign-in, read strictly. */
export type HeldLoginRequest =
  | { kind: 'seen'; session: string; tabId: number; url: string; username: string; password: string; update: boolean }
  | { kind: 'pending'; session: string; tabId: number; url: string }
  | { kind: 'answer'; session: string; tabId: number; decision: 'save' | 'later' | 'never' };

/**
 * A sign-in message from a tab, as the worker believes it: only from the tab
 * the session holds, with the page address Chrome reports for the sender
 * (never the page's claim). Undefined for anything else.
 */
export function heldLoginRequest(message: unknown, sender: { tab?: { id?: number }; url?: string } | undefined, heldTab: number | undefined): HeldLoginRequest | undefined {
  const request = message as { type?: unknown; session?: unknown; decision?: unknown; username?: unknown; password?: unknown; update?: unknown } | null;
  if (!request || typeof request.session !== 'string' || request.session === '') return undefined;
  if (heldTab === undefined || sender?.tab?.id !== heldTab) return undefined;
  const session = request.session;
  const url = sender.url ?? '';
  if (request.type === LOGIN_SEEN_MESSAGE) {
    if (typeof request.password !== 'string' || request.password === '' || request.password.length > 1024) return undefined;
    const username = typeof request.username === 'string' ? request.username.slice(0, 200) : '';
    return { kind: 'seen', session, tabId: heldTab, url, username, password: request.password, update: request.update === true };
  }
  if (request.type === LOGIN_PENDING_MESSAGE) return { kind: 'pending', session, tabId: heldTab, url };
  if (request.type === LOGIN_MESSAGE && (request.decision === 'save' || request.decision === 'later' || request.decision === 'never')) {
    return { kind: 'answer', session, tabId: heldTab, decision: request.decision };
  }
  return undefined;
}
