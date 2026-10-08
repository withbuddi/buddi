/*
 * The popup: the buddis this browser works for, one row each, and Add a buddi.
 *
 * It holds no connection of its own. Everything it shows comes from the
 * service worker, which is the only thing that speaks to a buddi.
 *
 * Each row is one of four states, never two at once:
 *
 *   Not connected  the address, and Try again after an error
 *   Connecting     "Asking this buddi for a code…"
 *   Pairing        the six digits, Copy, and a way to that buddi's settings
 *   Connected      how many tabs it is working in, and Open buddi
 *
 * plus its switch (off: no socket, nothing done in this browser for it) and
 * Remove. `render` is the whole decision and takes a plain model, so the test
 * drives it against the real `popup.html` with no Chrome in the room.
 */

import type { PairingView } from './background.js';
import { DOWNLOADS_PERMISSION } from './downloads.js';

/** What the popup draws from: the worker's list and the little it keeps itself. */
export interface PopupModel {
  pairings: PairingView[];
  /** Add a buddi is open. */
  adding: boolean;
  /** A dashboard on this machine asked about itself and this browser has no pairing for it: offered in Add a buddi. */
  asked: string | null;
  /** The worker refused the address itself (not on this machine, not http). */
  refused: string | null;
}

export type RowView = 'off' | 'address' | 'connecting' | 'pairing' | 'paired';

/** Where the dashboard keeps Settings → Browser & apps (route id `computer`, `packages/web/src/routes.ts`). */
export const SETTINGS_HASH = '#/settings/computer';

const PILL: Record<RowView, { word: string; tone: string }> = {
  off: { word: 'Off', tone: 'idle' },
  address: { word: 'Not connected', tone: 'idle' },
  connecting: { word: 'Connecting…', tone: 'waiting' },
  pairing: { word: 'Needs pairing', tone: 'waiting' },
  paired: { word: 'Connected', tone: 'good' },
};

/** Which state one row is in. */
export function rowView(entry: Pick<PairingView, 'enabled' | 'state'>): RowView {
  if (!entry.enabled) return 'off';
  const { connection, code } = entry.state;
  if (connection === 'paired') return 'paired';
  if (connection === 'pairing' && code) return 'pairing';
  if (connection === 'connecting' || connection === 'pairing') return 'connecting';
  return 'address';
}

/** The one word in the head: the best any buddi is doing. */
export function summary(pairings: readonly PairingView[]): { word: string; tone: string } {
  const views = pairings.map(rowView);
  const connected = views.filter((view) => view === 'paired').length;
  if (connected > 1) return { word: `${connected} connected`, tone: 'good' };
  if (connected === 1) return PILL.paired;
  if (views.includes('pairing')) return PILL.pairing;
  if (views.includes('connecting')) return PILL.connecting;
  const failed = pairings.some((entry) => entry.enabled && entry.state.connection === 'offline' && entry.state.error);
  return { word: 'Not connected', tone: failed ? 'bad' : 'idle' };
}

/** `http://127.0.0.1:4317/`, or null for an address that is not one. */
export function dashboardUrl(gateway: string, hash = ''): string | null {
  try {
    const url = new URL(gateway);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}/${hash}`;
  } catch { return null; }
}

/** The host and port, for "Your buddi at …". */
function hostOf(gateway: string): string {
  try { return new URL(gateway).host; } catch { return gateway; }
}

/** Six digits read in two groups of three, whichever way the gateway spaced them. */
export function groupCode(code: string): string {
  const digits = code.replace(/[^0-9]/g, '');
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : code;
}

export function workingLine(tabs: number | null): string {
  if (!tabs) return 'Nothing open right now.';
  return tabs === 1 ? 'Working in 1 tab' : `Working in ${tabs} tabs`;
}

const byId = <T extends HTMLElement>(doc: Document, id: string): T => doc.getElementById(id) as T;

const part = <T extends HTMLElement>(row: Element, name: string): T => row.querySelector(`.${name}`) as T;

/**
 * Draws the model. `textContent` only: the codes and the names come from the
 * buddis over sockets, and this page never builds markup out of anything it
 * was sent.
 */
export function render(model: PopupModel, doc: Document = document): void {
  const pill = byId(doc, 'pill');
  const { word, tone } = summary(model.pairings);
  pill.textContent = word;
  pill.dataset['tone'] = tone;

  const list = byId(doc, 'buddis');
  const template = byId<HTMLTemplateElement>(doc, 'buddi-row');
  // Rows are kept by id, so a redraw every few seconds does not steal the focus from a switch.
  const existing = new Map([...list.querySelectorAll<HTMLElement>('.buddi')].map((row) => [row.dataset['id'] ?? '', row]));
  const wanted = new Set(model.pairings.map((entry) => entry.id));
  for (const [id, row] of existing) if (!wanted.has(id)) row.remove();
  for (const entry of model.pairings) {
    let row = existing.get(entry.id);
    if (!row) {
      row = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
      row.dataset['id'] = entry.id;
    }
    list.appendChild(row);
    drawRow(row, entry);
  }
  list.hidden = model.pairings.length === 0;

  // Add a buddi: open when asked for, and always when there is no buddi at all.
  const adding = model.adding || model.pairings.length === 0;
  byId(doc, 'add').hidden = !adding;
  byId(doc, 'add-open').hidden = adding;
  byId(doc, 'add-cancel').hidden = model.pairings.length === 0;
  const notice = byId(doc, 'notice');
  notice.hidden = !model.refused;
  notice.textContent = model.refused ?? '';
  byId(doc, 'hint').textContent = model.asked
    ? `The buddi at ${hostOf(model.asked)} asked to be added. Each buddi you add gets its own tab group.`
    : 'A buddi running on this machine. Each buddi you add gets its own tab group.';
}

function drawRow(row: HTMLElement, entry: PairingView): void {
  const view = rowView(entry);
  row.dataset['state'] = view;
  row.dataset['enabled'] = entry.enabled ? 'true' : 'false';
  row.dataset['colour'] = entry.colour;
  part(row, 'buddi-name').textContent = entry.name;
  // A buddi named by its address until it says a name of its own: the address once, not twice.
  const address = part(row, 'buddi-address');
  address.textContent = hostOf(entry.origin);
  address.hidden = entry.name === hostOf(entry.origin);
  const failure = view === 'address' ? entry.state.error : null;
  const pill = part(row, 'buddi-pill');
  pill.textContent = PILL[view].word;
  pill.dataset['tone'] = failure ? 'bad' : PILL[view].tone;
  const toggle = part<HTMLInputElement>(row, 'buddi-switch');
  toggle.checked = entry.enabled;
  toggle.setAttribute('aria-label', `Work for ${entry.name}`);
  part(row, 'buddi-pairing').hidden = view !== 'pairing';
  part(row, 'code').textContent = view === 'pairing' ? groupCode(entry.state.code ?? '') : '';
  part(row, 'buddi-pairing-hint').hidden = view !== 'pairing';
  part(row, 'buddi-asking').hidden = view !== 'connecting';
  const working = part(row, 'buddi-working');
  working.hidden = view !== 'paired';
  working.textContent = view === 'paired' ? (entry.state.older ? `${workingLine(entry.tabs).replace(/\.$/, '')} · older buddi: live view off` : workingLine(entry.tabs)) : '';
  const error = part(row, 'buddi-error');
  error.hidden = !failure;
  error.textContent = failure ?? '';
  part(row, 'buddi-retry').hidden = view !== 'address';
  part(row, 'buddi-settings').hidden = view !== 'pairing';
  part(row, 'buddi-open').hidden = view !== 'paired';
}


/** How long "Open buddi settings" waits for buddi.app to take over before opening the dashboard in a tab. */
export const APP_WAIT_MS = 1500;

/** Six digits, or null: whatever spacing the gateway gave the code. */
function digitsOf(code: string | null | undefined): string | null {
  const digits = (code ?? '').replace(/[^0-9]/g, '');
  return digits.length === 6 ? digits : null;
}

/** `buddi://settings/browser`, with the code while one is showing (apps/mac/App/BuddiLink.swift reads it). */
export function appSettingsLink(code: string | null | undefined): string {
  const digits = digitsOf(code);
  return digits ? `buddi://settings/browser?code=${digits}` : 'buddi://settings/browser';
}

/**
 * The dashboard's Browser & apps page in a tab, as before. The code rides only
 * in the fragment (`#/settings/computer?code=…`, which the dashboard's router
 * reads and no server ever sees). `?from=extension` is added only where
 * buddi.app could have answered (`triesApp`), so the signed-out page offers
 * the app only there.
 */
export function settingsWebUrl(gateway: string, code: string | null | undefined, userAgent = ''): string | null {
  const digits = digitsOf(code);
  const base = dashboardUrl(gateway);
  if (!base) return null;
  const search = triesApp(gateway, userAgent) ? '?from=extension' : '';
  return `${base}${search}${SETTINGS_HASH}${digits ? `?code=${digits}` : ''}`;
}

/**
 * buddi.app answers only for the buddi it runs, which listens on the default
 * address; a popup pointed anywhere else (a checkout on 4327, a moved port)
 * goes straight to that address. And only on a Mac, where the app exists.
 */
export function triesApp(gateway: string, userAgent: string): boolean {
  if (!/Macintosh|Mac OS X/.test(userAgent)) return false;
  try {
    const url = new URL(gateway);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && (url.port || (url.protocol === 'https:' ? '443' : '80')) === '4317';
  } catch { return false; }
}

/**
 * "Open buddi settings": buddi.app first, the dashboard in a tab otherwise.
 *
 * There is no way to ask whether a scheme has an app behind it. So the link is
 * followed, and if this popup still has the focus a second and a half later,
 * nothing took it: the tab opens as it always did. When buddi.app does open,
 * Chrome closes the popup as it loses focus, and the fallback never runs.
 */
export function openSettings(options: {
  gateway: string; code: string | null; userAgent: string;
  launch(url: string): void; openTab(url: string): void; focusLost(): boolean;
  wait?: (ms: number, then: () => void) => void;
}): void {
  const web = settingsWebUrl(options.gateway, options.code, options.userAgent);
  const fallback = () => { if (web) options.openTab(web); };
  if (!triesApp(options.gateway, options.userAgent)) { fallback(); return; }
  try { options.launch(appSettingsLink(options.code)); } catch { fallback(); return; }
  (options.wait ?? ((ms, then) => { setTimeout(then, ms); }))(APP_WAIT_MS, () => { if (!options.focusLost()) fallback(); });
}

/** How long the button admits to having copied before going back to offering it. */
export const COPIED_FOR = 2000;

/**
 * The code is six digits read off one screen and typed into another, which is
 * exactly the errand a clipboard is for.
 *
 * A clipboard write can be refused (no permission, no focus), and a button that
 * then lied would be worse than one that says nothing, so a refusal leaves the
 * word alone.
 */
const restores = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
export function copyInto(button: HTMLButtonElement, read: () => string): void {
  void (async () => {
    try { await navigator.clipboard.writeText(read()); } catch { return; }
    button.textContent = 'Copied';
    const pending = restores.get(button);
    if (pending) clearTimeout(pending);
    restores.set(button, setTimeout(() => { button.textContent = 'Copy'; restores.delete(button); }, COPIED_FOR));
  })();
}

/** The same, on a button of its own: every click copies. */
export function wireCopy(button: HTMLButtonElement, read: () => string): void {
  button.addEventListener('click', () => copyInto(button, read));
}

interface PopupChrome {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(fn: (message: unknown) => void): void };
  };
  tabs: { create(properties: { url: string }): Promise<unknown> };
  permissions?: {
    contains(permissions: { permissions: string[] }): Promise<boolean>;
    request(permissions: { permissions: string[] }): Promise<boolean>;
  };
}

declare const chrome: PopupChrome;

/**
 * Allow downloads: the optional permission agents' downloads need
 * (downloads.ts). Chrome asks only from a click in an extension page, which
 * is why it lives here. Shown until it is granted; gone once it is.
 */
export async function wireDownloads(doc: Document, permissions: PopupChrome['permissions']): Promise<void> {
  const box = byId(doc, 'downloads-box');
  const button = byId<HTMLButtonElement>(doc, 'allow-downloads');
  if (!permissions || !box || !button) return;
  const show = (granted: boolean) => { box.hidden = granted; button.hidden = granted; };
  show(await permissions.contains({ permissions: [DOWNLOADS_PERMISSION] }).catch(() => true));
  button.addEventListener('click', () => {
    void permissions.request({ permissions: [DOWNLOADS_PERMISSION] }).then(show, () => undefined);
  });
}

/** The least time between two redraws of the list. */
export const REDRAW_MS = 1_000;

/**
 * At most one call per `ms`: the first at once, the last of a burst at the end
 * of its window, nothing in between.
 */
export function throttle(run: () => void, ms: number, clock: { now(): number; later(fn: () => void, ms: number): unknown } = { now: () => Date.now(), later: (fn, wait) => setTimeout(fn, wait) }): () => void {
  let last = -Infinity;
  let waiting = false;
  return () => {
    const now = clock.now();
    if (now - last >= ms && !waiting) { last = now; run(); return; }
    if (waiting) return;
    waiting = true;
    clock.later(() => { waiting = false; last = clock.now(); run(); }, Math.max(0, ms - (now - last)));
  };
}

async function ask<T>(message: unknown): Promise<T | undefined> {
  try { return await chrome.runtime.sendMessage(message) as T; } catch { return undefined; }
}

interface ListAnswer { pairings?: PairingView[]; asked?: string | null; error?: string; added?: string }

/** The row a click landed in, and its buddi. */
function rowOf(target: EventTarget | null, model: PopupModel): { row: HTMLElement; entry: PairingView } | null {
  const row = (target as HTMLElement | null)?.closest?.('.buddi') as HTMLElement | null;
  const entry = row ? model.pairings.find((candidate) => candidate.id === row.dataset['id']) : undefined;
  return row && entry ? { row, entry } : null;
}

async function main(): Promise<void> {
  const field = byId<HTMLInputElement>(document, 'gateway');
  const model: PopupModel = { pairings: [], adding: false, asked: null, refused: null };
  const draw = () => render(model, document);
  const take = (answer: ListAnswer | undefined) => {
    if (!answer) return;
    if (answer.pairings) model.pairings = answer.pairings;
    if (answer.asked !== undefined) model.asked = answer.asked;
    // A dashboard asked to be added: its address is what the field offers.
    if (model.asked && !model.adding && document.activeElement !== field) field.value = model.asked;
  };
  const refresh = async () => { take(await ask<ListAnswer>({ type: 'buddi-get-state' })); draw(); };
  // The worker says every change; the popup redraws at most once a second, so a buddi that keeps
  // coming and going cannot make it flicker.
  const pushed = throttle(() => { void refresh(); }, REDRAW_MS);
  await refresh();
  // A dashboard asked to be added: Add a buddi opens on its address, for the owner to accept.
  if (model.asked) model.adding = true;
  draw();

  chrome.runtime.onMessage.addListener((message) => {
    if ((message as { type?: string } | null)?.type === 'buddi-state') pushed();
  });

  /*
   * Ask again every few seconds while the popup is open. A worker Chrome
   * stopped cannot push its last word, and a code left on screen after its
   * socket went is a code buddi no longer waits for; asking also wakes the
   * worker, which reconnects and shows a fresh one.
   */
  setInterval(() => { pushed(); }, 3000);

  const list = byId(document, 'buddis');
  list.addEventListener('change', (event) => {
    const hit = rowOf(event.target, model);
    if (!hit || !(event.target as HTMLElement).classList.contains('buddi-switch')) return;
    void ask<ListAnswer>({ type: 'buddi-enable', id: hit.entry.id, enabled: (event.target as HTMLInputElement).checked }).then((answer) => { take(answer); draw(); });
  });
  list.addEventListener('click', (event) => {
    const hit = rowOf(event.target, model);
    const button = (event.target as HTMLElement | null)?.closest?.('button') as HTMLButtonElement | null;
    if (!hit || !button) return;
    const { entry, row } = hit;
    if (button.classList.contains('buddi-copy')) { copyInto(button, () => part(row, 'code').textContent ?? ''); return; }
    if (button.classList.contains('buddi-retry')) { void ask<ListAnswer>({ type: 'buddi-retry', id: entry.id }).then((answer) => { take(answer); draw(); }); return; }
    if (button.classList.contains('buddi-remove')) { void ask<ListAnswer>({ type: 'buddi-remove', id: entry.id }).then((answer) => { take(answer); draw(); }); return; }
    if (button.classList.contains('buddi-open')) { const url = dashboardUrl(entry.origin); if (url) void chrome.tabs.create({ url }); return; }
    if (button.classList.contains('buddi-settings')) {
      let lost = false;
      const away = () => { lost = true; };
      window.addEventListener('blur', away, { once: true });
      document.addEventListener('visibilitychange', away, { once: true });
      openSettings({
        gateway: entry.origin, code: entry.state.connection === 'pairing' ? entry.state.code : null, userAgent: navigator.userAgent,
        // A link clicked in this page: Chrome hands buddi:// to the app registered for it, or does nothing.
        launch: (url) => { const link = document.createElement('a'); link.href = url; link.rel = 'noopener'; link.click(); },
        openTab: (url) => { void chrome.tabs.create({ url }); },
        focusLost: () => lost || !document.hasFocus(),
      });
    }
  });

  const connect = async () => {
    model.refused = null;
    const answer = await ask<ListAnswer>({ type: 'buddi-add', gateway: field.value.trim() });
    if (answer?.error) model.refused = answer.error;
    else { model.adding = false; model.asked = null; }
    take(answer);
    draw();
  };
  byId(document, 'connect').addEventListener('click', () => { void connect(); });
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') void connect(); });
  byId(document, 'add-open').addEventListener('click', () => {
    model.adding = true; model.refused = null;
    draw();
    field.focus();
    field.select();
  });
  byId(document, 'add-cancel').addEventListener('click', () => { model.adding = false; model.refused = null; draw(); });
  void wireDownloads(document, chrome.permissions);
}

/*
 * The worker pushes every state change; the popup only listens while it is
 * open. Guarded on `chrome` existing so that importing this file outside an
 * extension page — which is what its test does — wires nothing up and runs
 * nothing.
 */
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) void main();
