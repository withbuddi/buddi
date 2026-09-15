/**
 * One file, from a browser into the artifact store.
 *
 * `multipart/form-data` is parsed here rather than by a dependency, for the
 * same reason the router is forty lines of `node:http`: this endpoint accepts
 * exactly one part, from an authenticated owner, on loopback, and a parser that
 * fits on two screens is easier to audit than a package with a CVE history.
 *
 * Two refusals are the point of the module:
 *
 *  - **Size.** The body is counted as it arrives and abandoned the moment it
 *    crosses the cap, so an oversize upload costs bandwidth and nothing else.
 *  - **Type.** A file the runtime cannot do anything with is refused *at the
 *    door*, with a sentence naming what it can — not saved, not silently
 *    attached to a run that then says it cannot read it.
 *
 * Nothing here decides where bytes live. That is `saveArtifact`, through the
 * same `ArtifactStore` port every other surface uses.
 */
import type { IncomingMessage } from 'node:http';
import { kindForMime } from '@buddi/core';
import { mimeForPath } from '../chat/attach.js';
import { first } from './http.js';

/** The largest attachment the dashboard accepts. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The largest *part header* block we will read before calling it malformed. */
const MAX_PART_HEADER_BYTES = 8 * 1024;

/** What the runtime can actually do something with, said as a sentence. */
export const ACCEPTED_TYPES_NOTE =
  'images (PNG, JPEG, GIF, WebP), PDFs, and text or office documents ' +
  '(TXT, Markdown, CSV, TSV, JSON, XML, HTML, DOC, DOCX, XLS, XLSX)';

export interface UploadedFile {
  filename: string;
  mime: string;
  bytes: Buffer;
}

export type UploadResult =
  | { ok: true; file: UploadedFile }
  | { ok: false; status: number; error: string };

/**
 * The mime this upload should be stored under.
 *
 * A browser sends `application/octet-stream` for anything it does not
 * recognise — a `.md`, an `.ofx`, a `.csv` exported by a bank — so the
 * extension is consulted second. Never the file's own bytes: a wrong
 * `image/png` is worse than an honest `application/octet-stream`.
 */
export function resolveUploadMime(claimed: string, filename: string): string {
  const stated = claimed.split(';')[0]?.trim().toLowerCase() ?? '';
  if (stated !== '' && stated !== 'application/octet-stream') return stated;
  return mimeForPath(filename);
}

/**
 * Is this something a run can use? `image` and `document` are the two kinds
 * core's own mime rules produce for things a model can either see or read
 * through the artifacts tools. Audio is kept by Telegram because Telegram
 * hands it over unasked; a file chosen deliberately in a file picker is a
 * different act, and refusing it with a reason beats saving something the
 * agent will only be able to say it cannot open.
 */
export function acceptedUpload(
  mime: string,
  filename: string,
): { ok: true; mime: string } | { ok: false; error: string } {
  const resolved = resolveUploadMime(mime, filename);
  const kind = kindForMime(resolved);
  if (kind === 'image' || kind === 'document') return { ok: true, mime: resolved };
  return {
    ok: false,
    error: `I cannot use ${filename} (${resolved}). I can read ${ACCEPTED_TYPES_NOTE}.`,
  };
}

/** The boundary this request declares, or undefined when it declares none. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const [type, ...params] = contentType.split(';');
  if ((type ?? '').trim().toLowerCase() !== 'multipart/form-data') return undefined;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    const raw = param.slice(eq + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** `filename="statement.csv"`, RFC 5987 spelling included. */
function filenameFrom(disposition: string): string | undefined {
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      /* fall through to the plain spelling */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/.exec(disposition) ?? /filename\s*=\s*([^;]+)/.exec(disposition);
  const value = plain?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The basename, and only the basename.
 *
 * A filename arrives from another machine and is stored and later shown; every
 * separator and every `..` comes out here, so nothing downstream has to
 * remember that this string is attacker-shaped. It never reaches a path — the
 * store is content-addressed — but a displayed `../../etc/passwd` is its own
 * small lie.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'upload' : cleaned.slice(0, 200);
}

/** Read the whole body, refusing the moment it crosses the cap. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Parse the request as a one-file multipart upload.
 *
 * Every failure is a sentence the page can show the owner, because every one of
 * them is something they can act on: pick a file, pick a smaller one, pick a
 * different kind.
 */
export async function readUpload(
  req: IncomingMessage,
  maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<UploadResult> {
  const boundary = multipartBoundary(first(req.headers['content-type']));
  if (boundary === undefined) {
    return { ok: false, status: 400, error: 'send the file as multipart/form-data' };
  }
  // The cap counts the file; the envelope adds a little. Give it a page.
  const body = await readBody(req, maxBytes + 8 * 1024);
  if (body === null) {
    return {
      ok: false,
      status: 413,
      error: `that file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, which is the most I can take in one upload`,
    };
  }

  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) return { ok: false, status: 400, error: 'the upload is malformed' };

  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    // `--boundary--` closes the body; anything after it is epilogue.
    if (body.slice(start, start + 2).toString('utf8') === '--') break;
    if (body.slice(start, start + 2).toString('utf8') === '\r\n') start += 2;

    const headerEnd = body.indexOf('\r\n\r\n', start, 'utf8');
    if (headerEnd < 0 || headerEnd - start > MAX_PART_HEADER_BYTES) {
      return { ok: false, status: 400, error: 'the upload is malformed' };
    }
    const headerText = body.slice(start, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const next = body.indexOf(delimiter, contentStart);
    if (next < 0) return { ok: false, status: 400, error: 'the upload is malformed' };
    // The CRLF before the delimiter belongs to the delimiter, not to the file.
    const contentEnd = next >= 2 && body.slice(next - 2, next).toString('utf8') === '\r\n' ? next - 2 : next;

    const disposition = headerText
      .split(/\r\n/)
      .find((line) => line.toLowerCase().startsWith('content-disposition:'));
    const filename = disposition === undefined ? undefined : filenameFrom(disposition);
    if (filename !== undefined) {
      const bytes = body.slice(contentStart, contentEnd);
      if (bytes.length === 0) {
        return { ok: false, status: 400, error: 'that file is empty' };
      }
      if (bytes.length > maxBytes) {
        return {
          ok: false,
          status: 413,
          error: `that file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, which is the most I can take in one upload`,
        };
      }
      const claimed =
        headerText
          .split(/\r\n/)
          .find((line) => line.toLowerCase().startsWith('content-type:'))
          ?.slice('content-type:'.length)
          .trim() ?? '';
      const name = safeFilename(filename);
      const accepted = acceptedUpload(claimed, name);
      if (!accepted.ok) return { ok: false, status: 415, error: accepted.error };
      return { ok: true, file: { filename: name, mime: accepted.mime, bytes } };
    }

    cursor = next;
  }

  return { ok: false, status: 400, error: 'the upload carried no file' };
}
