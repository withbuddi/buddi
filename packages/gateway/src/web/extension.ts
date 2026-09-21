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
 *
 * Both ends prove themselves, in that order. The extension's `hello` carries a
 * nonce and no token; this endpoint signs the nonce with the stored hash, which
 * is the only secret it has, and only then does the extension send the token,
 * which is checked against that hash. Until both halves are done the socket is
 * not adopted, and a socket that is not adopted is never sent a command. A
 * process that merely answers this port therefore learns nothing and drives
 * nothing.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { BrowserPreconditionError, NOT_CONNECTED, type ExtensionBridge, type ExtensionCommand, type ExtensionResult, type HandFrame } from '@buddi/tool-browser';
import { REPO_ROOT } from '../agents/catalog.js';
import { dataDir } from './config.js';
import { isLoopbackAddress } from './http.js';

/** The one path this gateway ever upgrades. */
export const EXTENSION_SOCKET_PATH = '/api/extension/socket';
/** A Chrome extension ID: thirty-two letters, a to p. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PAIR_TTL_MS = 5 * 60_000;
/** Six digits are guessable; five tries are not enough to guess them. */
const MAX_PAIR_ATTEMPTS = 5;
/** A hello answered with a challenge that is never answered back. */
const AUTH_TIMEOUT_MS = 15_000;
/** How long a cancelled command is given to say it stopped. */
const CANCEL_GRACE_MS = 10_000;
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
  /** The `chrome-extension://<id>` this buddi was paired with, once it is known. */
  extensionId?: string;
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
    return { tokenHash: parsed.tokenHash, pairedAt: String(parsed.pairedAt ?? ''), extension: String(parsed.extension ?? ''), lastSeenAt: String(parsed.lastSeenAt ?? ''),
      ...(typeof parsed.extensionId === 'string' && parsed.extensionId ? { extensionId: parsed.extensionId } : {}) };
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

/**
 * "482 913": six digits, read out loud once.
 *
 * `randomInt` rather than a byte modulo ten, which would make 0 to 5 more
 * likely than 6 to 9 and hand a guesser most of a digit for free.
 */
function pairCode(): string {
  const digits = Array.from({ length: 6 }, () => String(randomInt(10))).join('');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/**
 * What the extension checks before it sends its token: the socket's nonce,
 * signed with the token's hash.
 *
 * Keyed by the hash because that is all this side keeps. The extension holds
 * the token, hashes it the same way, and gets the same signature.
 */
export function pairingProof(tokenHash: string, nonce: string): string {
  return createHmac('sha256', tokenHash).update(nonce).digest('hex');
}

/** The `<id>` of a `chrome-extension://<id>` origin, which the upgrade checked. */
function extensionIdOf(origin: string): string {
  return origin.slice('chrome-extension://'.length);
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
  #pair?: { code: string; expiresAt: number; socket: WebSocket; extension: string; extensionId: string; attempts: number; timer: NodeJS.Timeout };
  /** A socket that was sent a proof and owes this buddi its token. */
  #challenge?: { socket: WebSocket; nonce: string; extension: string; extensionId: string; timer: NodeJS.Timeout };
  #pending = new Map<string, { resolve: (value: ExtensionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  /** Screencast listeners, by browser session. Frames are never kept here. */
  #frames = new Map<string, (frame: HandFrame) => void>();
  /** Other upgrade paths on this server's one listener; see `attachPath`. */
  #routes = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>();
  /** Commands the extension was told to abandon, until it says it has. */
  #cancelling = new Map<string, NodeJS.Timeout>();
  #idle: Array<() => void> = [];
  #record?: ExtensionRecord;
  /** True once the `paired` frame is on the wire, and not one moment earlier. */
  #live = false;
  #loaded = false;
  #ping?: NodeJS.Timeout;
  #missed = 0;
  #server?: Server;
  /** The three intervals are options so a test does not have to wait a minute. */
  constructor(readonly options: { env?: NodeJS.ProcessEnv; now?: () => number; log?: (line: string) => void;
    pingMs?: number; commandTimeoutMs?: number; helloTimeoutMs?: number; authTimeoutMs?: number; cancelGraceMs?: number } = {}) {}

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

  /**
   * Lend this server's `upgrade` listener to a second path.
   *
   * Node stops closing unhandled upgrades once any listener exists, so there
   * is exactly one, here. The remote hand is a different socket with different
   * authentication, and it gets the request untouched — this only decides
   * which of the two paths it was.
   */
  attachPath(pathname: string, handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
    this.#routes.set(pathname, handle);
  }

  #refuse(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '').split('?')[0]?.replace(/\/+$/, '') || '/';
    const route = this.#routes.get(pathname);
    if (route) return route(req, socket, head);
    if (pathname !== EXTENSION_SOCKET_PATH) return this.#refuse(socket, 404, 'Not Found');
    // Loopback by the socket, never by a header: a proxy in front of this is
    // not this machine, whatever it says about itself.
    if (!isLoopbackAddress(req.socket.remoteAddress)) return this.#refuse(socket, 403, 'Forbidden');
    if (Object.keys(req.headers).some((key) => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-'))) return this.#refuse(socket, 403, 'Forbidden');
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) return this.#refuse(socket, 403, 'Forbidden');
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, extensionIdOf(origin)));
  }

  #accept(ws: WebSocket, extensionId: string): void {
    const hello = setTimeout(() => { if (this.#socket !== ws && this.#pair?.socket !== ws && this.#challenge?.socket !== ws) ws.close(1002, 'no hello'); }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    hello.unref?.();
    ws.on('message', (data) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(String(data)) as Record<string, unknown>; }
      catch { ws.close(1003, 'not json'); return; }
      void this.#frame(ws, frame, extensionId).catch((error: unknown) => this.#log(`extension: ${error instanceof Error ? error.message : String(error)}`));
    });
    ws.on('close', () => {
      clearTimeout(hello);
      if (this.#pair?.socket === ws) this.#clearPair();
      if (this.#challenge?.socket === ws) this.#clearChallenge();
      if (this.#socket === ws) this.#drop('The buddi extension disconnected.');
    });
    ws.on('error', () => { /* a closed socket reports itself through `close` */ });
  }

  async #frame(ws: WebSocket, frame: Record<string, unknown>, extensionId: string): Promise<void> {
    // Liveness belongs to one socket: a pong from anything else says nothing
    // about whether the browser this buddi is talking to is still there.
    if (frame.type === 'pong') { if (ws === this.#socket) this.#missed = 0; return; }
    if (frame.type === 'hello') return this.#hello(ws, frame, extensionId);
    if (frame.type === 'auth') return this.#auth(ws, frame, extensionId);
    if (frame.type === 'result') return this.#result(ws, frame);
    if (frame.type === 'frame') return this.#screencast(ws, frame);
  }

  /**
   * A screencast frame, which nobody asked for by id.
   *
   * It is handed straight to whoever is driving that session and kept
   * nowhere: not in a field here, not in a log line. A frame for a session
   * with no hand on it is dropped — the extension acks its own frames, so
   * there is nothing to answer.
   */
  #screencast(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws !== this.#socket) return;
    const onFrame = this.#frames.get(typeof frame.session === 'string' ? frame.session : '');
    if (!onFrame) return;
    const data = typeof frame.data === 'string' ? frame.data : '';
    if (data === '') return;
    const raw = (frame.metadata ?? {}) as Record<string, unknown>;
    const number = (key: string): number => { const value = raw[key]; return typeof value === 'number' && Number.isFinite(value) ? value : 0; };
    onFrame({ jpeg: Buffer.from(data, 'base64'), metadata: { deviceWidth: number('deviceWidth'), deviceHeight: number('deviceHeight'),
      pageScaleFactor: number('pageScaleFactor') || 1, offsetTop: number('offsetTop'), scrollOffsetX: number('scrollOffsetX'), scrollOffsetY: number('scrollOffsetY') } });
  }

  #clearPair(): void {
    if (!this.#pair) return;
    clearTimeout(this.#pair.timer);
    this.#pair = undefined;
  }

  #clearChallenge(): void {
    if (!this.#challenge) return;
    clearTimeout(this.#challenge.timer);
    this.#challenge = undefined;
  }

  /** A newer hello wins, but the older candidate is told so rather than dropped silently. */
  #displace(ws: WebSocket, reason: string): void {
    if (this.#pair && this.#pair.socket !== ws) { const older = this.#pair.socket; this.#clearPair(); older.close(1000, reason); }
    if (this.#challenge && this.#challenge.socket !== ws) { const older = this.#challenge.socket; this.#clearChallenge(); older.close(1000, reason); }
  }

  async #hello(ws: WebSocket, frame: Record<string, unknown>, extensionId: string): Promise<void> {
    const version = typeof frame.extension === 'string' ? frame.extension.slice(0, 40) : '';
    const nonce = typeof frame.nonce === 'string' ? frame.nonce.slice(0, 128) : '';
    const record = await this.#read();
    // One browser per buddi: a different unpacked copy is a different browser,
    // and it pairs only after the owner has forgotten this one.
    if (record?.extensionId && record.extensionId !== extensionId) {
      ws.close(1008, 'this buddi is paired with another browser');
      return;
    }
    this.#displace(ws, 'replaced by a newer connection');
    if (record && frame.paired === true && nonce !== '') {
      const timer = setTimeout(() => {
        if (this.#challenge?.socket !== ws) return;
        this.#clearChallenge();
        // It saw the proof and said nothing: start the handshake over rather
        // than leave a half-open socket nobody can use.
        ws.send(JSON.stringify({ type: 'rehello', reason: 'That handshake went unanswered.' }));
      }, this.options.authTimeoutMs ?? AUTH_TIMEOUT_MS);
      timer.unref?.();
      this.#challenge = { socket: ws, nonce, extension: version, extensionId, timer };
      ws.send(JSON.stringify({ type: 'challenge', proof: pairingProof(record.tokenHash, nonce), installation: this.#installation() }));
      return;
    }
    // No pairing, or one this buddi has forgotten: ask for the owner instead.
    const code = pairCode();
    const timer = setTimeout(() => {
      if (this.#pair?.socket !== ws) return;
      this.#clearPair();
      ws.close(1000, 'pairing timed out');
    }, PAIR_TTL_MS);
    timer.unref?.();
    this.#pair = { code, expiresAt: this.#now() + PAIR_TTL_MS, socket: ws, extension: version, extensionId, attempts: 0, timer };
    ws.send(JSON.stringify({ type: 'pair', code }));
  }

  /** The second half of the handshake: the token, now that the proof was accepted. */
  async #auth(ws: WebSocket, frame: Record<string, unknown>, extensionId: string): Promise<void> {
    const challenge = this.#challenge;
    if (!challenge || challenge.socket !== ws || challenge.extensionId !== extensionId) return;
    const token = typeof frame.token === 'string' ? frame.token : '';
    const record = await this.#read();
    if (!record || token === '' || !sameHash(record.tokenHash, hashToken(token))) {
      this.#clearChallenge();
      ws.close(1008, 'that token is not this buddi’s');
      return;
    }
    this.#clearChallenge();
    this.#adopt(ws, { ...record, extension: challenge.extension || record.extension, extensionId,
      lastSeenAt: new Date(this.#now()).toISOString() });
    await this.#announce(ws, { type: 'paired', installation: this.#installation() });
    await this.#write(this.#record!);
  }

  #result(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws !== this.#socket) return;
    const id = typeof frame.id === 'string' ? frame.id : '';
    // The answer to a command this buddi had already given up on: nobody is
    // waiting for it, but the driver is waiting to know the browser stopped.
    if (this.#cancelling.has(id)) { this.#settled(id); return; }
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

  /**
   * Say "paired", and only count the browser as connected once it is written.
   *
   * The extension is not paired until it has read that frame, so a driver that
   * asked `connected()` in the window between adopting the socket and writing
   * to it would send a command the extension would rightly refuse. The window
   * is small and the first command after pairing lands in it, which is the
   * worst possible moment to tell an owner their browser is not paired.
   */
  #announce(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      ws.send(JSON.stringify(frame), () => {
        if (this.#socket === ws) this.#live = true;
        resolve();
      });
    });
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
    this.#live = false;
    this.#record = record;
    this.#loaded = true;
    this.#clearPair();
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
    const socket = this.#socket;
    this.#socket = undefined;
    this.#live = false;
    clearInterval(this.#ping);
    this.#ping = undefined;
    for (const [id, waiting] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(waiting.timer);
      // Tell the browser to stop before it acts on a command nobody is waiting
      // for. No answer is waited for here, unlike a timeout: this socket is
      // ending, and a browser whose socket ends forgets the session anyway.
      if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'cancel', id }));
      waiting.reject(new Error(reason));
    }
  }

  /*
   * Cancelling, and what the driver waits for.
   *
   * A command that timed out may still be half-done in the browser, and the
   * next one would be acting on a page nobody has seen since. So the extension
   * is told to abandon it and answers when it has; until then `idle()` does not
   * resolve and the driver holds the session. Ten seconds is the limit, because
   * a browser that cannot even say it stopped is a browser to give up on.
   */
  #cancel(socket: WebSocket, id: string): void {
    socket.send(JSON.stringify({ type: 'cancel', id }));
    const timer = setTimeout(() => this.#settled(id), this.options.cancelGraceMs ?? CANCEL_GRACE_MS);
    timer.unref?.();
    this.#cancelling.set(id, timer);
  }

  #settled(id: string): void {
    const timer = this.#cancelling.get(id);
    if (timer) clearTimeout(timer);
    this.#cancelling.delete(id);
    if (this.#cancelling.size > 0) return;
    for (const waiter of this.#idle.splice(0)) waiter();
  }

  /** Resolves once nothing is still being cancelled. */
  idle(): Promise<void> {
    if (this.#cancelling.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#idle.push(resolve); });
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
      this.#clearPair();
      return { status: 409, body: { error: 'No browser is waiting to be paired. Press Connect in the buddi extension, then type the code it shows.' } };
    }
    if (pending.code.replace(/[^0-9]/g, '') !== digits) {
      pending.attempts += 1;
      // Five guesses out of a million, and then this code is spent: whoever is
      // typing has to go back to the browser and press Connect again.
      if (pending.attempts >= MAX_PAIR_ATTEMPTS) {
        const socket = pending.socket;
        this.#clearPair();
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'rehello', reason: 'Too many wrong pairing codes.' }));
        return { status: 429, body: { error: 'Too many wrong codes. Press Connect in the buddi extension for a new one.' } };
      }
      return { status: 403, body: { error: 'That code does not match the one the extension is showing.' } };
    }
    const token = randomBytes(32).toString('base64url');
    const now = new Date(this.#now()).toISOString();
    this.#adopt(pending.socket, { tokenHash: hashToken(token), pairedAt: now, extension: pending.extension, extensionId: pending.extensionId, lastSeenAt: now });
    await this.#write(this.#record!);
    await this.#announce(pending.socket, { type: 'paired', token, installation: this.#installation() });
    return { status: 200, body: await this.view() as unknown as Record<string, unknown> };
  }

  /** Forget this browser: the record goes, and so does the live socket. */
  async unpair(): Promise<{ status: number; body: Record<string, unknown> }> {
    await rm(extensionFile(this.#env()), { force: true });
    this.#record = undefined;
    this.#loaded = true;
    // A browser waiting to be paired is waiting on a pairing this buddi no
    // longer has; the same goes for one half-way through the handshake.
    const waiting = [this.#pair?.socket, this.#challenge?.socket].filter((socket): socket is WebSocket => !!socket);
    this.#clearPair();
    this.#clearChallenge();
    for (const socket of waiting) socket.close(1000, 'this buddi forgot its browser');
    this.close();
    return { status: 200, body: await this.view() as unknown as Record<string, unknown> };
  }

  /* ---------------- the bridge ---------------- */

  connected(): boolean { return this.#live && !!this.#socket && this.#socket.readyState === this.#socket.OPEN; }

  send(command: ExtensionCommand): Promise<ExtensionResult> {
    const socket = this.#socket;
    if (!this.connected() || !socket) return Promise.reject(new Error(NOT_CONNECTED));
    const id = randomUUID();
    return new Promise<ExtensionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (socket.readyState === socket.OPEN) this.#cancel(socket, id);
        reject(new Error('Your browser did not answer within a minute. Check the buddi extension in Chrome, then observe again before retrying.'));
      }, this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'command', id, name: command.name, session: command.session, args: command.args, ...(command.owner ? { owner: true } : {}) }));
    });
  }

  /** One hand per session: a second subscription replaces the first. */
  frames(session: string, onFrame: (frame: HandFrame) => void): () => void {
    this.#frames.set(session, onFrame);
    return () => { if (this.#frames.get(session) === onFrame) this.#frames.delete(session); };
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
    this.#challenge?.socket.close(1000, 'closed by buddi');
    this.#clearPair();
    this.#clearChallenge();
    for (const timer of this.#cancelling.values()) clearTimeout(timer);
    this.#cancelling.clear();
    for (const waiter of this.#idle.splice(0)) waiter();
    this.#frames.clear();
    this.#routes.clear();
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
