/*
 * The service worker: one socket to one buddi, for as long as Chrome runs.
 *
 * A Manifest V3 worker is killed when it goes idle, but WebSocket traffic
 * counts as activity, so the gateway's 20-second ping is what keeps this alive
 * as well as what proves the link. When the worker is killed anyway (Chrome
 * restarts, the machine sleeps), `onStartup` and the popup both bring it back,
 * and the reconnect loop backs off to at most 30 seconds so a buddi that is
 * simply not running costs nothing.
 *
 * Tabs are deliberately not cleaned up when the socket drops. They are the
 * owner's browser, and an agent losing its connection is not a reason for the
 * window to change under their hands.
 */

import { BrowserCommands } from './commands.js';
import { AgentDownloads, DOWNLOADS_PERMISSION, type DownloadsApi } from './downloads.js';
import { GIVE_BACK_MESSAGE, LOGIN_MESSAGE, LOGIN_PENDING_MESSAGE, LOGIN_SEEN_MESSAGE } from './bar.js';
import type { WorkerChrome } from './chrome.js';
import { handleExternal, type ExtensionStatus } from './external.js';
import { Protocol, type ClientState } from './protocol.js';

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

export const DEFAULT_GATEWAY = 'http://127.0.0.1:4317';
const GATEWAY_KEY = 'gateway';
const MAX_BACKOFF = 30_000;
/** How long a knock waits for buddi before the socket is left alone this round. */
const KNOCK_MS = 3000;
/** Three missed pings and the gateway is gone; reconnecting is cheap. */
const SILENCE = 70_000;
/**
 * Chrome stops a Manifest V3 worker after thirty seconds without an event,
 * an open WebSocket or not; only traffic on the socket counts as one. The
 * gateway pings a paired socket every twenty seconds, but a socket waiting for
 * its code heard nothing from an older gateway, and the worker died half a
 * minute into pairing with the code still on the popup. So the worker speaks
 * first, every twenty seconds, whatever state the socket is in. The gateway
 * ignores the frame.
 */
export const KEEPALIVE_MS = 20_000;

/** Loopback only. This extension talks to a buddi on this machine, never to a host on the internet. */
export function socketUrl(address: string): string {
  const parsed = new URL(address);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) throw new Error('A buddi address has to be on this machine.');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('A buddi address starts with http.');
  return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}/api/extension/socket`;
}

/**
 * Nothing that escapes a promise may reach Chrome as an unhandled rejection:
 * the worker logs one line and carries on, because a background task that
 * failed is not a reason to lose the socket.
 */
const LOST = 'buddi: a background task did not finish.';
function safely(work: () => unknown): void {
  try {
    void Promise.resolve(work()).catch(() => console.warn(LOST));
  } catch { console.warn(LOST); }
}

let socket: WebSocket | undefined;

/**
 * Frames the handshake cannot do without.
 *
 * A pong or a screencast frame that missed its socket is stale by the time the
 * next one opens, and sending it at a gateway that never asked is worse than
 * dropping it. A `hello`, an `auth` or a `result` is one half of a conversation
 * the other end is waiting on, so it waits for the socket instead.
 */
const DURABLE = new Set(['hello', 'auth', 'result']);
/** Text frames waiting for the socket that is still connecting; discarded if it never opens. */
let pending: string[] = [];

const frameType = (frame: unknown): string =>
  frame && typeof frame === 'object' ? String((frame as { type?: unknown }).type ?? '') : '';

/**
 * One way out for everything this worker says, so a frame and a result travel
 * the same socket.
 *
 * A socket that is still CONNECTING throws on `send`, and the worker reconnects
 * often enough — an alarm, a pong, a screencast that outlived the last socket —
 * that something always arrives early. So this is the only place that decides:
 * send it, queue it, or let it go.
 */
export const send = (frame: unknown): void => {
  const live = socket;
  const text = JSON.stringify(frame);
  if (live && live.readyState === WebSocket.OPEN) {
    try { live.send(text); } catch { /* The socket died between the check and the send. */ }
    return;
  }
  if (live && live.readyState === WebSocket.CONNECTING && DURABLE.has(frameType(frame))) pending.push(text);
};

/** Everything that waited for this socket, in the order it was said. */
function flush(open: WebSocket): void {
  const queued = pending;
  pending = [];
  for (const text of queued) {
    if (open.readyState !== WebSocket.OPEN) return;
    try { open.send(text); } catch { return; }
  }
}

// Screencast frames are not answers to anything: they arrive while the owner
// is driving and go straight out, outside the command/result pairing.
/*
 * Agents' downloads: watched only once the owner allowed the optional
 * `downloads` permission (the popup's Allow downloads), and only for what an
 * agent's command started (downloads.ts). A finished one goes to buddi as a
 * frame; it is a report, not an answer, so a socket that is not open drops it.
 */
const downloads = new AgentDownloads({ send });
const attachDownloads = (): void => { if (chrome.downloads) downloads.attach(chrome.downloads); };
attachDownloads();
chrome.permissions?.onAdded?.addListener((added) => { if (added.permissions?.includes(DOWNLOADS_PERMISSION)) attachDownloads(); });
const commands = new BrowserCommands(chrome, { onFrame: send, onEvent: send, onLogin: send, downloads });
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let silence: ReturnType<typeof setTimeout> | undefined;
let keepalive: ReturnType<typeof setInterval> | undefined;
let last: ClientState = { connection: 'offline', code: null, installation: null, error: null };
/** The tail of the frame queue: every frame waits for the one before it. */
let incoming: Promise<void> = Promise.resolve();

const protocol = new Protocol({
  chrome,
  version: chrome.runtime.getManifest().version,
  send,
  execute: (command, cancel) => commands.run(command, cancel),
  // The socket ended: sessions and refs go with it. The tabs do not.
  onReset: () => commands.reset(),
  onLoginAck: (id, answer) => commands.logins.ack(id, answer),
  onState: (state) => {
    last = state;
    // The popup may not be open; nobody is listening then, and that is fine.
    safely(() => chrome.runtime.sendMessage({ type: 'buddi-state', state }).catch(() => undefined));
  },
  disconnect: () => socket?.close(),
});

async function gateway(): Promise<string> {
  const stored = await chrome.storage.local.get([GATEWAY_KEY]);
  const address = stored[GATEWAY_KEY];
  return typeof address === 'string' && address ? address : DEFAULT_GATEWAY;
}

function quiet(): void {
  if (silence) clearTimeout(silence);
  silence = setTimeout(() => socket?.close(), SILENCE);
}

export async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (timer) { clearTimeout(timer); timer = undefined; }
  // The last socket is gone. A screencast it left running would paint frames at
  // a socket that never asked for them, and whatever it queued was for a
  // conversation that ended, so both stop here rather than on the new socket.
  socket = undefined;
  pending = [];
  commands.reset();
  let url: string;
  try { url = socketUrl(await gateway()); }
  catch (error) { protocol.closed(error instanceof Error ? error.message : String(error)); return; }
  /*
   * On a reconnect, knock first. A refused WebSocket is logged by Chrome as
   * an extension error every time, and a buddi that is restarting or off
   * would fill that page with them; a refused fetch is not logged. The first
   * connect (and the owner's Connect click) still opens the socket at once.
   */
  if (attempt > 0 && !(await answering(url))) {
    protocol.closed('buddi did not answer at this address. Is it running?');
    schedule();
    return;
  }
  const opening = new WebSocket(url);
  socket = opening;
  opening.addEventListener('open', () => {
    attempt = 0; quiet(); flush(opening);
    if (keepalive) clearInterval(keepalive);
    keepalive = setInterval(() => { if (socket === opening) send({ type: 'keepalive' }); }, KEEPALIVE_MS);
    safely(() => protocol.open());
  });
  // One frame at a time, in the order they arrived. A WebSocket delivers them
  // in order and the protocol is written as if they were handled that way: a
  // command that follows `paired` must not overtake it, and two commands must
  // not interleave their dispatches in the owner's browser.
  opening.addEventListener('message', (event) => {
    quiet();
    const text = String(event.data);
    incoming = incoming.then(() => protocol.receive(text)).catch(() => { console.warn(LOST); });
  });
  // A socket that errors before it opens takes everything queued for it with
  // it: the gateway never heard the hello those frames belonged to.
  opening.addEventListener('error', () => { if (socket === opening) pending = []; });
  opening.addEventListener('close', () => {
    if (socket === opening) { socket = undefined; pending = []; if (keepalive) { clearInterval(keepalive); keepalive = undefined; } }
    if (silence) { clearTimeout(silence); silence = undefined; }
    protocol.closed('buddi did not answer at this address. Is it running?');
    schedule();
  });
}

/** Does anything answer on buddi's HTTP side? Any status counts; only no answer at all is a no. */
async function answering(socket: string): Promise<boolean> {
  let http: URL;
  try {
    http = new URL(socket);
    http.protocol = http.protocol === 'wss:' ? 'https:' : 'http:';
    http.pathname = '/api/version';
    http.search = '';
  } catch { return false; }
  try {
    await fetch(http.toString(), { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(KNOCK_MS) });
    return true;
  } catch {
    return false;
  }
}

function schedule(): void {
  if (timer) return;
  const wait = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(attempt, 5));
  attempt += 1;
  timer = setTimeout(() => { timer = undefined; safely(() => connect()); }, wait);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const request = message as { type?: string; gateway?: string; session?: string } | null;
  if (!request || typeof request.type !== 'string') return;
  // Give it back, from the bar in a tab the owner holds: only for the session holding that very tab.
  if (request.type === GIVE_BACK_MESSAGE) {
    const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
    if (typeof request.session === 'string') safely(() => commands.giveBack(request.session!, tabId).then(() => undefined));
    return;
  }
  /*
   * "Save this login?" in a held tab: the pair seen (kept here, in memory,
   * until the owner answers or two minutes pass — the form's navigation takes
   * the page away), a new page asking whether a question still waits, and the
   * answer. Only from the tab that session holds, with the origin Chrome
   * reported when the pair was seen; Save goes to buddi on this worker's
   * authenticated socket and the page hears what became of it. Never logged.
   */
  if (request.type === LOGIN_MESSAGE || request.type === LOGIN_SEEN_MESSAGE || request.type === LOGIN_PENDING_MESSAGE) {
    const reply = commands.loginMessage(message, sender as { tab?: { id?: number }; url?: string } | undefined);
    if (!reply) { respond(null); return; }
    safely(() => reply.then((answer) => respond(answer), () => respond(null)));
    return true;
  }
  if (request.type === 'buddi-get-state') { respond({ state: last }); return; }
  if (request.type === 'buddi-connect') {
    safely(async () => {
      if (request.gateway) {
        try { socketUrl(request.gateway); } catch (error) { respond({ error: error instanceof Error ? error.message : String(error) }); return; }
        await chrome.storage.local.set({ [GATEWAY_KEY]: request.gateway });
      }
      attempt = 0;
      socket?.close();
      await connect();
      respond({ state: last });
    });
    return true;
  }
  if (request.type === 'buddi-forget') {
    safely(() => protocol.forget().then(() => respond({ state: last })));
    return true;
  }
  if (request.type === 'buddi-gateway') { safely(() => gateway().then((address) => respond({ gateway: address }))); return true; }
  return;
});

/*
 * The dashboard asking whether this browser has the extension in it.
 *
 * It cannot find out any other way, and an owner who has to be told to look in
 * the popup for a code the page could have filled in for them is an owner
 * doing the computer's work. `handleExternal` decides; this only hands it the
 * three things it needs and Chrome's own `sender`.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, respond) =>
  handleExternal(message, { origin: sender.origin, state: () => last, gateway, version: chrome.runtime.getManifest().version }, respond));

chrome.runtime.onInstalled.addListener(() => safely(() => connect()));
chrome.runtime.onStartup.addListener(() => safely(() => connect()));

/*
 * The backoff timer lives in the worker, and an idle worker is evicted, which
 * would leave a browser that never reconnects until the owner opened the popup.
 * An alarm outlives the worker: it wakes it up once a minute, and `connect`
 * returns immediately when a socket is already open, so a connected browser
 * pays nothing for it.
 */
const RECONNECT_ALARM = 'buddi-reconnect';
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RECONNECT_ALARM) safely(() => connect()); });

safely(() => connect());
