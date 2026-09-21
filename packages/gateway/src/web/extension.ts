/**
 * "Your browser": the owner's own Chrome, reached through the buddi extension.
 *
 * One WebSocket, loopback only, spoken by a Manifest V3 extension the owner
 * loaded unpacked. The gateway is the server; the extension connects, says
 * hello, and is either recognised by its token or asked to show a six-digit
 * code the owner types into Settings. Commands go out as JSON text frames and
 * results come back on the same socket, which is all the browser plugin's
 * `ExtensionDriver` needs to look exactly like the Playwright one.
 *
 * The token is never stored in the clear: `<data>/extension.json` keeps a
 * SHA-256 of it, so a readable data directory does not hand anyone the ability
 * to drive the owner's browser.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { BrowserPreconditionError, NOT_CONNECTED, type ExtensionBridge, type ExtensionCommand, type ExtensionResult } from '@buddi/tool-browser';
import { REPO_ROOT } from '../agents/catalog.js';
import { dataDir } from './config.js';
import { isLoopbackAddress } from './http.js';

/** The one path this gateway ever upgrades. */
export const EXTENSION_SOCKET_PATH = '/api/extension/socket';
/** A Chrome extension ID: thirty-two letters, a to p. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PAIR_TTL_MS = 5 * 60_000;
const PING_MS = 20_000;
const MISSED_PONGS = 3;
const COMMAND_TIMEOUT_MS = 60_000;
/** A hello that never arrives is a socket that never becomes anything. */
const HELLO_TIMEOUT_MS = 15_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** What `<data>/extension.json` holds. Never the token itself. */
export interface ExtensionRecord {
  tokenHash: string;
  pairedAt: string;
  extension: string;
  lastSeenAt: string;
}

/** What the Settings page draws. */
export interface ExtensionView {
  connected: boolean;
  pending: boolean;
  path: string;
  pairedAt?: string;
  extension?: string;
  lastSeenAt?: string;
}

export function extensionFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), 'extension.json');
}

/** Where the unpacked extension is, for the four words on the Settings page. */
export async function extensionDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = (env.BUDDI_EXTENSION_DIR ?? '').trim();
  if (explicit !== '') return path.resolve(explicit);
  const shipped = path.join(REPO_ROOT, 'extension');
  try { await access(shipped); return shipped; } catch { /* a development checkout, then */ }
  return path.join(REPO_ROOT, 'packages', 'extension', 'dist');
}

/** The paired extension, or undefined when this buddi has never been paired. */
export async function readExtensionRecord(env: NodeJS.ProcessEnv = process.env): Promise<ExtensionRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(extensionFile(env), 'utf8')) as Partial<ExtensionRecord>;
    if (typeof parsed?.tokenHash !== 'string' || parsed.tokenHash === '') return undefined;
    return { tokenHash: parsed.tokenHash, pairedAt: String(parsed.pairedAt ?? ''), extension: String(parsed.extension ?? ''), lastSeenAt: String(parsed.lastSeenAt ?? '') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** "482 913": six digits, read out loud once. */
function pairCode(): string {
  const digits = Array.from(randomBytes(6), (byte) => String(byte % 10)).join('');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/**
 * The endpoint, which is also the plugin's bridge.
 *
 * One extension at a time: a second hello carrying a valid token replaces the
 * first, because that is what a reloaded extension looks like from here.
 */
export class ExtensionEndpoint implements ExtensionBridge {
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  #socket?: WebSocket;
  #pair?: { code: string; expiresAt: number; socket: WebSocket; extension: string };
  #pending = new Map<string, { resolve: (value: ExtensionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #record?: ExtensionRecord;
  #loaded = false;
  #ping?: NodeJS.Timeout;
  #missed = 0;
  #server?: Server;
  /** The three intervals are options so a test does not have to wait a minute. */
  constructor(readonly options: { env?: NodeJS.ProcessEnv; now?: () => number; log?: (line: string) => void;
    pingMs?: number; commandTimeoutMs?: number; helloTimeoutMs?: number } = {}) {}

  #env(): NodeJS.ProcessEnv { return this.options.env ?? process.env; }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  #log(line: string): void { this.options.log?.(line); }

  /**
   * Take over this server's `upgrade` event.
   *
   * Everything that is not the extension socket is answered and destroyed
   * here: once a listener exists Node stops closing unhandled upgrades itself,
   * and a hanging half-open socket is worse than a 404.
   */
  attach(server: Server): void {
    if (this.#server === server) return;
    this.#server = server;
    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket as Duplex, head));
  }

  #refuse(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '').split('?')[0]?.replace(/\/+$/, '') || '/';
    if (pathname !== EXTENSION_SOCKET_PATH) return this.#refuse(socket, 404, 'Not Found');
    // Loopback by the socket, never by a header: a proxy in front of this is
    // not this machine, whatever it says about itself.
    if (!isLoopbackAddress(req.socket.remoteAddress)) return this.#refuse(socket, 403, 'Forbidden');
    if (Object.keys(req.headers).some((key) => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-'))) return this.#refuse(socket, 403, 'Forbidden');
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) return this.#refuse(socket, 403, 'Forbidden');
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws));
  }

  #accept(ws: WebSocket): void {
    const hello = setTimeout(() => { if (this.#socket !== ws && this.#pair?.socket !== ws) ws.close(1002, 'no hello'); }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    hello.unref?.();
    ws.on('message', (data) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(String(data)) as Record<string, unknown>; }
      catch { ws.close(1003, 'not json'); return; }
      void this.#frame(ws, frame).catch((error: unknown) => this.#log(`extension: ${error instanceof Error ? error.message : String(error)}`));
    });
    ws.on('close', () => {
      clearTimeout(hello);
      if (this.#pair?.socket === ws) this.#pair = undefined;
      if (this.#socket === ws) this.#drop('The buddi extension disconnected.');
    });
    ws.on('error', () => { /* a closed socket reports itself through `close` */ });
  }

  async #frame(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'pong') { this.#missed = 0; return; }
    if (frame.type === 'hello') return this.#hello(ws, frame);
    if (frame.type === 'result') return this.#result(ws, frame);
  }

  async #hello(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const version = typeof frame.extension === 'string' ? frame.extension.slice(0, 40) : '';
    const token = typeof frame.token === 'string' ? frame.token : '';
    const record = await this.#read();
    if (record && token !== '' && sameHash(record.tokenHash, hashToken(token))) {
      this.#adopt(ws, { ...record, extension: version || record.extension, lastSeenAt: new Date(this.#now()).toISOString() });
      ws.send(JSON.stringify({ type: 'paired', installation: this.#installation() }));
      await this.#write(this.#record!);
      return;
    }
    // No token, or one this buddi has forgotten: ask for the owner instead.
    const code = pairCode();
    this.#pair = { code, expiresAt: this.#now() + PAIR_TTL_MS, socket: ws, extension: version };
    ws.send(JSON.stringify({ type: 'pair', code }));
  }

  #result(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws !== this.#socket) return;
    const id = typeof frame.id === 'string' ? frame.id : '';
    const waiting = this.#pending.get(id);
    if (!waiting) return;
    this.#pending.delete(id);
    clearTimeout(waiting.timer);
    if (frame.ok === true) {
      waiting.resolve({ observation: frame.observation, screenshot: typeof frame.screenshot === 'string' ? frame.screenshot : null });
      return;
    }
    const message = typeof frame.error === 'string' && frame.error.trim() !== '' ? frame.error.slice(0, 2000) : 'Your browser refused the action without saying why.';
    waiting.reject(frame.precondition === true ? new BrowserPreconditionError(message) : new Error(message));
  }

  /** What the extension popup calls this buddi: the port it is listening on. */
  #installation(): string {
    const address = this.#server?.address() as AddressInfo | null;
    return address?.port ? `127.0.0.1:${address.port}` : 'buddi';
  }

  #adopt(ws: WebSocket, record: ExtensionRecord): void {
    if (this.#socket && this.#socket !== ws) {
      const previous = this.#socket;
      this.#socket = undefined;
      previous.close(1000, 'replaced by a newer connection');
    }
    this.#socket = ws;
    this.#record = record;
    this.#loaded = true;
    this.#pair = undefined;
    this.#missed = 0;
    clearInterval(this.#ping);
    this.#ping = setInterval(() => {
      if (this.#socket !== ws) return;
      if (++this.#missed > MISSED_PONGS) { this.#drop('Your browser stopped answering.'); ws.close(1001, 'no pong'); return; }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, this.options.pingMs ?? PING_MS);
    this.#ping.unref?.();
  }

  /** Every command still waiting fails with one sentence, never silently. */
  #drop(reason: string): void {
    this.#socket = undefined;
    clearInterval(this.#ping);
    this.#ping = undefined;
    for (const [id, waiting] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
  }

  async #read(): Promise<ExtensionRecord | undefined> {
    if (!this.#loaded) { this.#record = await readExtensionRecord(this.#env()); this.#loaded = true; }
    return this.#record;
  }

  async #write(record: ExtensionRecord): Promise<void> {
    const file = extensionFile(this.#env());
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, file);
    this.#record = record;
    this.#loaded = true;
  }

  /* ---------------- the three routes ---------------- */

  async view(): Promise<ExtensionView> {
    const record = await this.#read();
    const pending = !!this.#pair && this.#pair.expiresAt > this.#now();
    return { connected: this.connected(), pending, path: await extensionDir(this.#env()),
      ...(record ? { pairedAt: record.pairedAt, extension: record.extension, lastSeenAt: record.lastSeenAt } : {}) };
  }

  /** The owner typed the code the popup showed. Spaces and dashes are theirs. */
  async pair(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const typed = typeof input === 'string' ? input : '';
    const digits = typed.replace(/[^0-9]/g, '');
    if (digits.length !== 6) return { status: 400, body: { error: 'Type the six digits the buddi extension is showing.' } };
    const pending = this.#pair;
    if (!pending || pending.expiresAt <= this.#now()) {
      this.#pair = undefined;
      return { status: 409, body: { error: 'No browser is waiting to be paired. Press Connect in the buddi extension, then type the code it shows.' } };
    }
    if (pending.code.replace(/[^0-9]/g, '') !== digits) return { status: 403, body: { error: 'That code does not match the one the extension is showing.' } };
    const token = randomBytes(32).toString('base64url');
    const now = new Date(this.#now()).toISOString();
    this.#adopt(pending.socket, { tokenHash: hashToken(token), pairedAt: now, extension: pending.extension, lastSeenAt: now });
    await this.#write(this.#record!);
    pending.socket.send(JSON.stringify({ type: 'paired', token, installation: this.#installation() }));
    return { status: 200, body: await this.view() as unknown as Record<string, unknown> };
  }

  /** Forget this browser: the record goes, and so does the live socket. */
  async unpair(): Promise<{ status: number; body: Record<string, unknown> }> {
    await rm(extensionFile(this.#env()), { force: true });
    this.#record = undefined;
    this.#loaded = true;
    this.#pair = undefined;
    this.close();
    return { status: 200, body: await this.view() as unknown as Record<string, unknown> };
  }

  /* ---------------- the bridge ---------------- */

  connected(): boolean { return !!this.#socket && this.#socket.readyState === this.#socket.OPEN; }

  send(command: ExtensionCommand): Promise<ExtensionResult> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== socket.OPEN) return Promise.reject(new Error(NOT_CONNECTED));
    const id = randomUUID();
    return new Promise<ExtensionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Your browser did not answer within a minute. Check the buddi extension in Chrome, then observe again before retrying.'));
      }, this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'command', id, name: command.name, session: command.session, args: command.args }));
    });
  }

  /** Close the live connection. The pairing on disk survives it. */
  close(): void {
    const socket = this.#socket;
    this.#drop('The buddi extension was disconnected.');
    socket?.close(1000, 'closed by buddi');
  }

  /** The server is going down: sockets, timers and the upgrade listener. */
  shutdown(): void {
    this.close();
    this.#pair?.socket.close(1000, 'closed by buddi');
    this.#pair = undefined;
    for (const client of this.#wss.clients) client.terminate();
    this.#wss.close();
    this.#server = undefined;
  }
}

const endpoints = new Map<string, ExtensionEndpoint>();
/** One endpoint per data dir, like the host browser it feeds. */
export function extensionEndpoint(env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): ExtensionEndpoint {
  const key = extensionFile(env);
  let endpoint = endpoints.get(key);
  if (!endpoint) {
    endpoint = new ExtensionEndpoint({ env, ...(log ? { log } : {}) });
    endpoints.set(key, endpoint);
  }
  return endpoint;
}
