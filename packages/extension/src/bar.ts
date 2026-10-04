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
}

export function hideHeldBar(): void {
  const doc = (globalThis as unknown as { document?: Document }).document;
  doc?.getElementById('buddi-held-bar')?.remove();
}

/** The frame the worker sends the gateway when the owner pressed Take over in the working bar, or Give it back in the held one. */
export interface OwnerEventMessage { type: 'event'; name: 'takeover' | 'giveback'; session: string }
