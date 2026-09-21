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
import type { WorkerChrome } from './chrome.js';
import { Protocol, type ClientState } from './protocol.js';

declare const chrome: WorkerChrome & {
  runtime: WorkerChrome['runtime'] & { onInstalled: { addListener(fn: () => void): void }; onStartup: { addListener(fn: () => void): void } };
};

export const DEFAULT_GATEWAY = 'http://127.0.0.1:4317';
const GATEWAY_KEY = 'gateway';
const MAX_BACKOFF = 30_000;
/** Three missed pings and the gateway is gone; reconnecting is cheap. */
const SILENCE = 70_000;

/** Loopback only. This extension talks to a buddi on this machine, never to a host on the internet. */
export function socketUrl(address: string): string {
  const parsed = new URL(address);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) throw new Error('A buddi address has to be on this machine.');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('A buddi address starts with http.');
  return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}/api/extension/socket`;
}

const commands = new BrowserCommands(chrome);
let socket: WebSocket | undefined;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let silence: ReturnType<typeof setTimeout> | undefined;
let last: ClientState = { connection: 'offline', code: null, installation: null, error: null };

const protocol = new Protocol({
  chrome,
  version: chrome.runtime.getManifest().version,
  send: (frame) => socket?.send(JSON.stringify(frame)),
  execute: (command) => commands.run(command),
  onState: (state) => {
    last = state;
    // The popup may not be open; nobody is listening then, and that is fine.
    void chrome.runtime.sendMessage({ type: 'buddi-state', state }).catch(() => undefined);
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

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (timer) { clearTimeout(timer); timer = undefined; }
  let url: string;
  try { url = socketUrl(await gateway()); }
  catch (error) { protocol.closed(error instanceof Error ? error.message : String(error)); return; }
  const opening = new WebSocket(url);
  socket = opening;
  opening.addEventListener('open', () => { attempt = 0; quiet(); void protocol.open(); });
  opening.addEventListener('message', (event) => { quiet(); void protocol.receive(String(event.data)); });
  opening.addEventListener('error', () => undefined);
  opening.addEventListener('close', () => {
    if (socket === opening) socket = undefined;
    if (silence) { clearTimeout(silence); silence = undefined; }
    protocol.closed('Not connected to buddi.');
    schedule();
  });
}

function schedule(): void {
  if (timer) return;
  const wait = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(attempt, 5));
  attempt += 1;
  timer = setTimeout(() => { timer = undefined; void connect(); }, wait);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const request = message as { type?: string; gateway?: string } | null;
  if (!request || typeof request.type !== 'string') return;
  if (request.type === 'buddi-get-state') { respond({ state: last }); return; }
  if (request.type === 'buddi-connect') {
    void (async () => {
      if (request.gateway) {
        try { socketUrl(request.gateway); } catch (error) { respond({ error: error instanceof Error ? error.message : String(error) }); return; }
        await chrome.storage.local.set({ [GATEWAY_KEY]: request.gateway });
      }
      attempt = 0;
      socket?.close();
      await connect();
      respond({ state: last });
    })();
    return true;
  }
  if (request.type === 'buddi-forget') {
    void protocol.forget().then(() => respond({ state: last }));
    return true;
  }
  if (request.type === 'buddi-gateway') { void gateway().then((address) => respond({ gateway: address })); return true; }
  return;
});

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
void connect();
