/*
 * The service worker: one link (link.ts) per buddi the owner has switched on,
 * for as long as Chrome runs.
 *
 * The list lives in `chrome.storage.local` (pairings.ts); this file keeps the
 * links in step with it, answers the popup, routes a message from a tab to the
 * one buddi whose tab it is, and answers the dashboard's one question.
 */

import { DOWNLOADS_PERMISSION, type DownloadsApi } from './downloads.js';
import { GIVE_BACK_MESSAGE, LOGIN_MESSAGE, LOGIN_PENDING_MESSAGE, LOGIN_SEEN_MESSAGE } from './bar.js';
import type { WorkerChrome } from './chrome.js';
import { handleExternal, type ExtensionStatus } from './external.js';
import { Link, safely } from './link.js';
import { DEFAULT_GATEWAY, GroupRegistry, PairingStore, displayName, sameBuddi, type Colour, type Pairing } from './pairings.js';
import type { ClientState } from './protocol.js';

export { DEFAULT_GATEWAY };
export { KEEPALIVE_MS, socketUrl } from './link.js';

declare const chrome: WorkerChrome & {
  /** Present only once the owner granted the optional permission. */
  downloads?: DownloadsApi;
  permissions?: {
    contains(permissions: { permissions: string[] }): Promise<boolean>;
    onAdded?: { addListener(fn: (permissions: { permissions?: string[] }) => void): void };
  };
  runtime: WorkerChrome['runtime'] & {
    onInstalled: { addListener(fn: () => void): void };
    onStartup: { addListener(fn: () => void): void };
    /** Only loopback pages may reach this, per `externally_connectable` in the manifest. */
    onMessageExternal: {
      addListener(fn: (message: unknown, sender: { origin?: string }, respond: (answer: ExtensionStatus) => void) => boolean | void): void;
    };
  };
};

/** One buddi as the popup draws it. */
export interface PairingView {
  id: string;
  origin: string;
  /** Its own name, or its address while it said none. */
  name: string;
  colour: Colour;
  enabled: boolean;
  state: ClientState;
  /** Tabs it is working in, while connected. */
  tabs: number | null;
}

const store = new PairingStore(chrome.storage.local);
const groups = new GroupRegistry();
const links = new Map<string, Link>();
/** The entries as last read, so a group's title and colour are known without a storage read. */
let entries: Pairing[] = [];
/** A loopback dashboard this browser has no pairing for asked about itself: the popup offers its address. */
let asked: string | null = null;

const version = chrome.runtime.getManifest().version;

function entryOf(id: string): Pairing | undefined { return entries.find((entry) => entry.id === id); }

function pushState(): void {
  // The popup may not be open; nobody is listening then, and that is fine.
  safely(() => chrome.runtime.sendMessage({ type: 'buddi-state' }).catch(() => undefined));
}

function linkFor(entry: Pairing): Link {
  const link = new Link({
    chrome, id: entry.id, origin: entry.origin, store, groups, version,
    title: () => { const current = entryOf(entry.id); return current ? displayName(current, entries) : 'buddi'; },
    colour: () => entryOf(entry.id)?.colour,
    onState: () => pushState(),
    onName: (id, name) => safely(async () => { await store.update(id, { name }); entries = await store.list(); pushState(); }),
  });
  if (chrome.downloads) link.attachDownloads(chrome.downloads);
  return link;
}

/**
 * Bring the links in step with the list: a link for every buddi switched on,
 * none for one switched off or removed. Connecting is idempotent, so this is
 * also what the alarm and a wake-up call.
 */
export async function sync(): Promise<void> {
  entries = await store.list();
  for (const [id, link] of links) {
    const entry = entryOf(id);
    if (!entry || !entry.enabled || !sameBuddi(entry.origin, link.origin)) {
      link.dispose();
      links.delete(id);
      if (!entry) groups.release(id);
    }
  }
  for (const entry of entries) {
    if (!entry.enabled) continue;
    let link = links.get(entry.id);
    if (!link) { link = linkFor(entry); links.set(entry.id, link); }
    await link.connect();
  }
}

/** What the popup draws: every buddi, in the order they were added. */
export async function views(): Promise<PairingView[]> {
  entries = await store.list();
  const out: PairingView[] = [];
  for (const entry of entries) {
    const link = links.get(entry.id);
    const state = link?.state() ?? { connection: 'offline' as const, code: null, installation: null, error: null };
    out.push({ id: entry.id, origin: entry.origin, name: displayName(entry, entries), colour: entry.colour, enabled: entry.enabled, state,
      tabs: link && state.connection === 'paired' ? await link.commands.tabCount().catch(() => null) : null });
  }
  return out;
}

/** The first link, for the frames and messages that predate several buddis. */
function firstLink(): Link | undefined { return links.values().next().value; }

chrome.permissions?.onAdded?.addListener((added) => {
  if (added.permissions?.includes(DOWNLOADS_PERMISSION) && chrome.downloads) for (const link of links.values()) link.attachDownloads(chrome.downloads);
});

/** Which link holds this session: the one whose tab the owner holds, else any that knows it. */
function holders(session: string): Link[] {
  const holding = [...links.values()].filter((link) => link.commands.heldTab(session) !== undefined);
  return holding.length > 0 ? holding : [...links.values()];
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const request = message as { type?: string; gateway?: string; session?: string; id?: string; enabled?: boolean } | null;
  if (!request || typeof request.type !== 'string') return;
  // Give it back, from the bar in a tab the owner holds: only for the session holding that very tab.
  if (request.type === GIVE_BACK_MESSAGE) {
    const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
    const session = request.session;
    // The buddi holding that tab hears it; a worker restarted since (and so holding nothing) passes it on to
    // every buddi, and only the one whose session it is resumes anything.
    if (typeof session === 'string') safely(async () => { for (const link of holders(session)) await link.commands.giveBack(session, tabId); });
    return;
  }
  /*
   * "Save this login?" in a held tab: the pair seen (kept here, in memory,
   * until the owner answers or two minutes pass — the form's navigation takes
   * the page away), a new page asking whether a question still waits, and the
   * answer. Only from the tab that session holds, with the origin Chrome
   * reported when the pair was seen; Save goes to the buddi holding that tab,
   * on its authenticated socket, and the page hears what became of it. Never
   * logged.
   */
  if (request.type === LOGIN_MESSAGE || request.type === LOGIN_SEEN_MESSAGE || request.type === LOGIN_PENDING_MESSAGE) {
    const from = sender as { tab?: { id?: number }; url?: string } | undefined;
    let reply: Promise<unknown> | undefined;
    for (const link of links.values()) { reply = link.commands.loginMessage(message, from); if (reply) break; }
    if (!reply) { respond(null); return; }
    safely(() => reply!.then((answer) => respond(answer), () => respond(null)));
    return true;
  }
  if (request.type === 'buddi-get-state') {
    safely(async () => respond({ pairings: await views(), asked }));
    return true;
  }
  // Add a buddi (or Connect, from a popup older than the list): the entry, then its link, then the list.
  if (request.type === 'buddi-add' || request.type === 'buddi-connect') {
    safely(async () => {
      let entry: Pairing;
      const before = new Set(links.keys());
      try { entry = await store.add(request.gateway?.trim() || DEFAULT_GATEWAY); }
      catch (error) { respond({ error: error instanceof Error ? error.message : String(error) }); return; }
      if (asked && sameBuddi(asked, entry.origin)) asked = null;
      await sync();
      // A buddi that was already on and is waiting out its backoff: try it now. A new one has just connected.
      if (before.has(entry.id)) await links.get(entry.id)?.retry();
      respond({ pairings: await views(), added: entry.id });
    });
    return true;
  }
  if (request.type === 'buddi-enable' && typeof request.id === 'string') {
    safely(async () => { await store.update(request.id!, { enabled: request.enabled !== false }); await sync(); respond({ pairings: await views() }); });
    return true;
  }
  if (request.type === 'buddi-retry' && typeof request.id === 'string') {
    safely(async () => { await links.get(request.id!)?.retry(); respond({ pairings: await views() }); });
    return true;
  }
  // Pair this one again from a fresh code: its token goes, the entry stays.
  if (request.type === 'buddi-forget') {
    safely(async () => {
      const link = typeof request.id === 'string' ? links.get(request.id) : firstLink();
      await link?.forget();
      respond({ pairings: await views() });
    });
    return true;
  }
  // Remove it from this browser: its link, its entry and its token go; its tabs stay, they are the owner's.
  if (request.type === 'buddi-remove' && typeof request.id === 'string') {
    safely(async () => { await store.remove(request.id!); await sync(); respond({ pairings: await views() }); });
    return true;
  }
  return;
});

/*
 * The dashboard asking whether this browser has the extension in it, and how
 * it stands with that buddi.
 *
 * It cannot find out any other way, and an owner who has to be told to look in
 * the popup for a code the page could have filled in for them is an owner
 * doing the computer's work. `handleExternal` decides; this only hands it what
 * it needs and Chrome's own `sender`.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, respond) =>
  handleExternal(message, {
    origin: sender.origin, version,
    known: async () => {
      entries = await store.list().catch(() => entries);
      return entries.map((entry) => ({ origin: entry.origin, name: displayName(entry, entries), enabled: entry.enabled,
        state: links.get(entry.id)?.state() ?? { connection: 'offline' as const, code: null, installation: null, error: null } }));
    },
    unknown: (origin) => { asked = origin; },
  }, respond));

chrome.runtime.onInstalled.addListener(() => safely(() => sync()));
chrome.runtime.onStartup.addListener(() => safely(() => sync()));

/*
 * The backoff timers live in the worker, and an idle worker is evicted, which
 * would leave a browser that never reconnects until the owner opened the popup.
 * An alarm outlives the worker: it wakes it up once a minute, and `connect`
 * returns immediately when a socket is already open, so a connected browser
 * pays nothing for it.
 */
const RECONNECT_ALARM = 'buddi-reconnect';
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RECONNECT_ALARM) safely(() => sync()); });

safely(() => sync());
