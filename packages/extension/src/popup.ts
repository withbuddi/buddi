/*
 * The popup: where the owner points this browser at their buddi, reads the
 * pairing code, and sees what it is connected to.
 *
 * It holds no connection of its own. Everything it shows comes from the
 * service worker, which is the only thing that speaks to a buddi.
 *
 * One of four states is on screen, never two:
 *
 *   Not connected  the address and Connect (Try again after an error)
 *   Connecting     the address, disabled, while the buddi mints a code
 *   Pairing        the six digits, Copy, and a way to the settings page
 *   Connected      which buddi, what it is doing here, and Forget
 *
 * `render` is the whole decision and takes a plain model, so the test drives
 * it against the real `popup.html` with no Chrome in the room.
 */

import type { ClientState } from './protocol.js';

/** What the popup draws from: the worker's state and the little it keeps itself. */
export interface PopupModel {
  state: ClientState;
  /** The address the worker is pointed at. */
  gateway: string;
  /** "Not this buddi" was pressed: show the address even while a code is up. */
  editing: boolean;
  /** Tabs in the `buddi` group, when they could be counted. */
  tabs: number | null;
  /** The worker refused the address itself (not on this machine, not http). */
  refused: string | null;
}

export type View = 'address' | 'pairing' | 'paired';

/** Where the dashboard keeps Settings → Browser & apps (route id `computer`, `packages/web/src/routes.ts`). */
export const SETTINGS_HASH = '#/settings/computer';

const PILL: Record<ClientState['connection'], { word: string; tone: string }> = {
  offline: { word: 'Not connected', tone: 'idle' },
  connecting: { word: 'Connecting…', tone: 'waiting' },
  pairing: { word: 'Pairing', tone: 'waiting' },
  paired: { word: 'Connected', tone: 'good' },
};

export function viewOf(model: Pick<PopupModel, 'state' | 'editing'>): View {
  const { connection, code } = model.state;
  if (connection === 'paired') return 'paired';
  if (connection === 'pairing' && code && !model.editing) return 'pairing';
  return 'address';
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

/**
 * Draws the model. `textContent` only: the code and the installation name come
 * from the gateway over a socket, and this page never builds markup out of
 * anything it was sent.
 */
export function render(model: PopupModel, doc: Document = document): void {
  const { state } = model;
  const view = viewOf(model);
  const pill = byId(doc, 'pill');
  const { word, tone } = PILL[state.connection] ?? PILL.offline;
  const failure = model.refused ?? (state.connection === 'offline' ? state.error : null);
  pill.textContent = word;
  pill.dataset['tone'] = failure ? 'bad' : tone;

  // The newly shown view fades in (the CSS animation runs on `hidden` → shown);
  // the others go at once.
  for (const section of doc.querySelectorAll<HTMLElement>('.view')) section.hidden = section.dataset['view'] !== view;
  doc.body.dataset['view'] = view;

  // Not connected / Connecting.
  const connecting = view === 'address' && state.connection === 'connecting' && !model.editing;
  const field = byId<HTMLInputElement>(doc, 'gateway');
  field.disabled = connecting;
  const notice = byId(doc, 'notice');
  notice.hidden = !failure || connecting;
  notice.textContent = failure ?? '';
  byId(doc, 'asking').hidden = !connecting;
  byId(doc, 'address-actions').hidden = connecting;
  byId(doc, 'connect').textContent = failure ? 'Try again' : 'Connect';

  // Pairing. Nothing is left in the code's place when there is no code to show.
  byId(doc, 'code').textContent = view === 'pairing' ? groupCode(state.code ?? '') : '';

  // Connected.
  byId(doc, 'paired-to').textContent = view === 'paired' ? `Your buddi at ${state.installation ?? hostOf(model.gateway)}` : '';
  byId(doc, 'working').textContent = workingLine(model.tabs);
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
export function wireCopy(button: HTMLButtonElement, read: () => string): void {
  let restore: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    void (async () => {
      try { await navigator.clipboard.writeText(read()); } catch { return; }
      button.textContent = 'Copied';
      if (restore) clearTimeout(restore);
      restore = setTimeout(() => { button.textContent = 'Copy'; restore = undefined; }, COPIED_FOR);
    })();
  });
}

interface PopupChrome {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(fn: (message: unknown) => void): void };
  };
  tabs: {
    create(properties: { url: string }): Promise<unknown>;
    query(query: Record<string, unknown>): Promise<Array<{ groupId?: number }>>;
  };
  tabGroups: { query(query: { title?: string }): Promise<Array<{ id: number; title?: string }>> };
}

declare const chrome: PopupChrome;

/** The tabs in the `buddi` group (the name `commands.ts` gives it), in every window. */
export async function countBuddiTabs(api: Pick<PopupChrome, 'tabs' | 'tabGroups'>): Promise<number | null> {
  try {
    const groups = new Set((await api.tabGroups.query({ title: 'buddi' })).map((group) => group.id));
    if (groups.size === 0) return 0;
    return (await api.tabs.query({})).filter((tab) => tab.groupId !== undefined && groups.has(tab.groupId)).length;
  } catch { return null; }
}

async function ask<T>(message: unknown): Promise<T | undefined> {
  try { return await chrome.runtime.sendMessage(message) as T; } catch { return undefined; }
}

async function main(): Promise<void> {
  const field = byId<HTMLInputElement>(document, 'gateway');
  const model: PopupModel = {
    state: { connection: 'offline', code: null, installation: null, error: null },
    gateway: field.value, editing: false, tabs: null, refused: null,
  };
  const draw = () => render(model, document);
  const recount = async () => {
    if (model.state.connection !== 'paired') return;
    model.tabs = await countBuddiTabs(chrome);
    draw();
  };

  const address = await ask<{ gateway: string }>({ type: 'buddi-gateway' });
  if (address?.gateway) { model.gateway = address.gateway; field.value = address.gateway; }
  const current = await ask<{ state: ClientState }>({ type: 'buddi-get-state' });
  if (current?.state) model.state = current.state;
  draw();
  void recount();

  chrome.runtime.onMessage.addListener((message) => {
    const frame = message as { type?: string; state?: ClientState } | null;
    if (frame?.type !== 'buddi-state' || !frame.state) return;
    model.state = frame.state;
    draw();
    void recount();
  });

  /*
   * Ask again every few seconds while the popup is open. A worker Chrome
   * stopped cannot push its last word, and a code left on screen after its
   * socket went is a code buddi no longer waits for; asking also wakes the
   * worker, which reconnects and shows a fresh one.
   */
  setInterval(() => {
    void ask<{ state: ClientState }>({ type: 'buddi-get-state' }).then((answer) => {
      if (!answer?.state || JSON.stringify(answer.state) === JSON.stringify(model.state)) return;
      model.state = answer.state;
      draw();
      void recount();
    });
  }, 3000);

  wireCopy(byId<HTMLButtonElement>(document, 'copy'), () => byId(document, 'code').textContent ?? '');

  byId(document, 'connect').addEventListener('click', async () => {
    const gateway = field.value.trim();
    model.refused = null;
    model.editing = false;
    const answer = await ask<{ state?: ClientState; error?: string }>({ type: 'buddi-connect', gateway });
    if (answer?.error) model.refused = answer.error;
    else model.gateway = gateway || model.gateway;
    if (answer?.state) model.state = answer.state;
    draw();
  });
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') byId(document, 'connect').click(); });
  byId(document, 'not-this').addEventListener('click', () => {
    model.editing = true;
    draw();
    field.focus();
    field.select();
  });
  const open = (hash: string) => {
    const url = dashboardUrl(model.gateway, hash);
    if (url) void chrome.tabs.create({ url });
  };
  byId(document, 'open-settings').addEventListener('click', () => {
    let lost = false;
    const away = () => { lost = true; };
    window.addEventListener('blur', away, { once: true });
    document.addEventListener('visibilitychange', away, { once: true });
    openSettings({
      gateway: model.gateway, code: model.state.connection === 'pairing' ? model.state.code : null, userAgent: navigator.userAgent,
      // A link clicked in this page: Chrome hands buddi:// to the app registered for it, or does nothing.
      launch: (url) => { const link = document.createElement('a'); link.href = url; link.rel = 'noopener'; link.click(); },
      openTab: (url) => { void chrome.tabs.create({ url }); },
      focusLost: () => lost || !document.hasFocus(),
    });
  });
  byId(document, 'open-buddi').addEventListener('click', () => open(''));
  byId(document, 'forget').addEventListener('click', async () => {
    const answer = await ask<{ state: ClientState }>({ type: 'buddi-forget' });
    if (answer?.state) { model.state = answer.state; model.tabs = null; draw(); }
  });
}

/*
 * The worker pushes every state change; the popup only listens while it is
 * open. Guarded on `chrome` existing so that importing this file outside an
 * extension page — which is what its test does — wires nothing up and runs
 * nothing.
 */
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) void main();
