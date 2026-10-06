/**
 * Downloading what buddi runs locally — the ONNX engine and shared models —
 * with one set of safety rules (docs/plugin-host-api.md §4.2 `onnx`, 1.32):
 *
 *  - Everything is written under a `.tmp-*` name in the folder it will end up
 *    in, so the final move is a same-filesystem `rename`, atomic.
 *  - The sha256 and the length are checked against the pin while the bytes
 *    arrive; a mismatch deletes the temporary file and nothing is moved.
 *  - A download that dies half-way deletes what it wrote; one from a process
 *    that died is swept by the next download into that folder.
 *  - Nothing downloaded is opened, executed or loaded before its hash matched.
 *
 * The tarball reader is the smallest that reads an npm tarball (ustar, with
 * pax and GNU long names): it streams through gunzip and writes only the
 * entries asked for, hashing each as it goes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, rm, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { guardedLookup, type LookupAll } from '../host/http.js';
import { DEFAULT_POLICY, checkUrl, type AddressPolicy } from '../plugin/url.js';
import { scrubText } from '../secrets/scrub.js';

/** An answer whose body is read as it arrives, never buffered whole. */
export interface DownloadResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

/** How a download asks for a URL: tests hand in one over a local server. */
export type DownloadGet = (url: string, opts?: { signal?: AbortSignal }) => Promise<DownloadResponse>;

/** How `nodeGet` dials: tests point it at a local server and a resolver of their own. */
export interface NodeGetOptions {
  request?: typeof httpsRequest;
  /** Where a checked URL is actually sent. Tests only: the checks run on the URL before it. */
  rewrite?: (url: string) => string;
  /** The address rules; `DEFAULT_POLICY` in shipped code. */
  policy?: AddressPolicy;
  /** How a name is resolved before the guard judges it. */
  resolve?: LookupAll;
}

/** The most redirects one download follows. */
export const DOWNLOAD_MAX_REDIRECTS = 5;

/**
 * GET over `node:https`, one connection per request and no pool (the reason
 * the shared transport exists; it buffers whole answers, and an engine is a
 * hundred megabytes). The same guards as the shared transport: every URL —
 * the first and every redirect — goes through `checkUrl` (no credentials, the
 * web's own ports, no private or local host), https only, and the socket
 * resolves through `guardedLookup`, so a name that answers a private address
 * is refused before anything is sent. Five redirects at most.
 */
export function nodeGet(options: NodeGetOptions = {}): DownloadGet {
  const request = options.request ?? httpsRequest;
  const rewrite = options.rewrite ?? ((url: string) => url);
  const policy = options.policy ?? DEFAULT_POLICY;
  const lookup = guardedLookup(options.resolve, policy);
  const once = (url: string, signal: AbortSignal | undefined): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = request(
        rewrite(url),
        { method: 'GET', agent: false, lookup, headers: { 'user-agent': 'buddi', accept: '*/*' }, ...(signal ? { signal } : {}) },
        resolve,
      );
      req.setTimeout(60_000, () => req.destroy(new Error('the server went quiet for a minute')));
      req.on('error', reject);
      req.end();
    });
  return async (url, opts = {}) => {
    let current = url;
    for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop += 1) {
      const checked = checkUrl(current, policy);
      if (checked.url.protocol !== 'https:') throw new Error(`refusing ${checked.url.host}: downloads are https only`);
      const res = await once(current, opts.signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && typeof location === 'string') {
        res.resume();
        current = new URL(location, current).toString();
        continue;
      }
      if (status < 200 || status >= 300) res.resume();
      return { status, body: res };
    }
    throw new Error('too many redirects');
  };
}

/** A file pinned by its hash and length. */
export interface PinnedDownload {
  url: string;
  sha256: string;
  bytes: number;
}

/** Why a download was refused or failed, in a sentence for the owner. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

/**
 * A fresh temporary name in `dir`: `.tmp-<random><suffix>`, or
 * `.tmp-<owner>+<random><suffix>` when an owner (a model id) is named, so a
 * sweep for one owner never touches another's download in the same folder.
 * `+` is not a character an id may hold, so `.tmp-a+` never matches `a-b`'s.
 */
export function tempName(dir: string, suffix = '', owner?: string): string {
  return path.join(dir, `.tmp-${owner === undefined ? '' : `${owner}+`}${randomBytes(6).toString('hex')}${suffix}`);
}

/** The prefix of an owner's temporaries (`tempName`'s third argument). */
export function tempPrefix(owner?: string): string {
  return owner === undefined ? '.tmp-' : `.tmp-${owner}+`;
}

/**
 * Delete every `.tmp-*` entry in `dir` (or only an owner's, `.tmp-<owner>+*`):
 * what a download that died left. `keep` spares the entries a running download
 * owns. Never throws.
 */
export async function sweepTemp(dir: string, owner?: string, keep: (name: string) => boolean = () => false): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let swept = 0;
  const prefix = tempPrefix(owner);
  for (const name of names) {
    if (!name.startsWith(prefix) || keep(name)) continue;
    await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    swept += 1;
  }
  return swept;
}

/**
 * Fetch `file.url` into `dest`, checking the length and sha256 as the bytes
 * arrive. On any failure `dest` is deleted and a `DownloadError` thrown; on
 * success `dest` holds exactly the pinned bytes.
 */
export async function downloadVerified(
  get: DownloadGet,
  file: PinnedDownload,
  dest: string,
  opts: { signal?: AbortSignal; onProgress?: (received: number) => void } = {},
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    let response: DownloadResponse;
    try {
      response = await get(file.url, opts.signal ? { signal: opts.signal } : {});
    } catch (err) {
      throw new DownloadError(`Could not reach ${hostOf(file.url)}: ${safeReason(err instanceof Error ? err.message : String(err))}${errorCode(err)}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DownloadError(`${hostOf(file.url)} answered ${response.status} for ${path.posix.basename(new URL(file.url).pathname)}.`);
    }
    handle = await open(dest, 'wx');
    const hash = createHash('sha256');
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > file.bytes) {
          throw new DownloadError(`${path.posix.basename(new URL(file.url).pathname)} is larger than the ${file.bytes} bytes pinned for it.`);
        }
        hash.update(chunk);
        await handle.write(chunk);
        opts.onProgress?.(received);
      }
    } catch (err) {
      if (err instanceof DownloadError) throw err;
      throw new DownloadError(`The download from ${hostOf(file.url)} broke off after ${received} bytes: ${safeReason(err instanceof Error ? err.message : String(err))}${errorCode(err)}`);
    }
    if (received !== file.bytes) {
      throw new DownloadError(`The download from ${hostOf(file.url)} ended after ${received} of ${file.bytes} bytes.`);
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256.toLowerCase()) {
      throw new DownloadError(`The file from ${hostOf(file.url)} does not match its pinned checksum (sha256 ${digest.slice(0, 12)}…, expected ${file.sha256.slice(0, 12)}…).`);
    }
    await handle.close();
    handle = undefined;
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  }
}

/** One entry to keep from a tarball. */
export interface TarWanted {
  entry: string;
  dest: string;
  sha256: string;
  bytes: number;
}

/**
 * Stream a `.tgz` and write only the wanted entries, each to its `dest`,
 * checking each one's length and sha256. Throws a `DownloadError` naming the
 * first entry that is missing, the wrong size or the wrong hash; the caller
 * deletes the folder the entries went into.
 */
export async function extractVerified(tgz: string, wanted: readonly TarWanted[]): Promise<void> {
  const byEntry = new Map(wanted.map((w) => [w.entry, w]));
  const done = new Set<string>();
  let pending: Buffer = Buffer.alloc(0);
  // The entry being read: how much of its body is left, the padding after it,
  // and where its bytes go (a file, a pax/long-name buffer, or nowhere).
  let body: {
    remaining: number;
    pad: number;
    file?: { handle: FileHandle; hash: ReturnType<typeof createHash>; want: TarWanted };
    meta?: { kind: 'pax' | 'longname'; parts: Buffer[] };
  } | null = null;
  let nextName: string | undefined;
  let zeros = 0;
  let ended = false;

  const finishEntry = async (): Promise<void> => {
    if (body === null) return;
    if (body.file) {
      const { handle, hash, want } = body.file;
      await handle.close();
      const digest = hash.digest('hex');
      if (digest !== want.sha256.toLowerCase()) {
        throw new DownloadError(`${want.entry} does not match its pinned checksum.`);
      }
      done.add(want.entry);
    }
    if (body.meta) {
      const text = Buffer.concat(body.meta.parts);
      if (body.meta.kind === 'longname') nextName = text.toString('utf8').replace(/\0.*$/s, '');
      else {
        const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text.toString('utf8'));
        if (found) nextName = found[1];
      }
    }
  };

  const gunzip = createReadStream(tgz).pipe(createGunzip());
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      if (ended) break;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (!ended) {
        if (body !== null) {
          if (body.remaining > 0) {
            if (pending.length === 0) break;
            const take = Math.min(body.remaining, pending.length);
            const slice = pending.subarray(0, take);
            if (body.file) {
              body.file.hash.update(slice);
              await body.file.handle.write(slice);
            } else if (body.meta) {
              body.meta.parts.push(Buffer.from(slice));
            }
            body.remaining -= take;
            pending = pending.subarray(take);
            if (body.remaining > 0) break;
          }
          if (pending.length < body.pad) break;
          pending = pending.subarray(body.pad);
          await finishEntry();
          body = null;
          continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every((byte) => byte === 0)) {
          zeros += 1;
          if (zeros >= 2) ended = true;
          continue;
        }
        zeros = 0;
        const field = (start: number, length: number): string =>
          header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        if (!Number.isFinite(size) || size < 0) throw new DownloadError('The tarball has an entry whose size cannot be read.');
        const type = String.fromCharCode(header[156] ?? 0);
        const prefix = field(345, 155);
        const name = nextName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        const pad = (512 - (size % 512)) % 512;
        if (type === 'x' || type === 'L') {
          body = { remaining: size, pad, meta: { kind: type === 'x' ? 'pax' : 'longname', parts: [] } };
          continue;
        }
        nextName = undefined;
        const want = (type === '0' || type === '\0') ? byEntry.get(name) : undefined;
        if (want !== undefined && !done.has(name)) {
          if (size !== want.bytes) {
            throw new DownloadError(`${want.entry} is ${size} bytes, not the ${want.bytes} pinned for it.`);
          }
          const handle = await open(want.dest, 'wx');
          body = { remaining: size, pad, file: { handle, hash: createHash('sha256'), want } };
        } else {
          body = { remaining: size, pad };
        }
      }
    }
  } catch (err) {
    if (body?.file) await body.file.handle.close().catch(() => {});
    gunzip.destroy();
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(`The tarball could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (body?.file) {
    await body.file.handle.close().catch(() => {});
    throw new DownloadError(`The tarball ended inside ${body.file.want.entry}.`);
  }
  const missing = wanted.find((w) => !done.has(w.entry));
  if (missing) throw new DownloadError(`The tarball has no ${missing.entry}.`);
}

/** The sha256 of a file on disk, streamed. */
export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'the server';
  } catch {
    return 'the server';
  }
}

/** ` (ECONNRESET)`: a system error's short code, when it has one. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code) && !(err instanceof Error && err.message.includes(code)) ? ` (${code})` : '';
}

/** The longest failure reason kept, logged or shown. */
export const REASON_MAX = 300;

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`]+/gi;

/**
 * A failure reason safe to log, keep on disk and show in Settings: every
 * stored secret scrubbed, every URL cut to its host (no credentials, path or
 * query, where a signed link keeps its key), one line, at most 300 characters.
 */
export function safeReason(text: string): string {
  const scrubbed = scrubText(String(text)).replace(URL_IN_TEXT, (found) => hostOf(found));
  const line = scrubbed.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/** Bytes as the owner reads them: `114 MB`, `850 KB`, `1.2 GB`. */
export function formatDownloadSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}
