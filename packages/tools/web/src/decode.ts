/**
 * Bytes off the wire, to the text of a page.
 *
 * Three things stand between a response body and its words, and each one went
 * wrong at least once:
 *
 *  - **Content encoding.** A site may compress its answer — some (Amazon)
 *    whether or not they were asked to. Read as UTF-8, a gzip body is a page
 *    of `��t��j�@`, and the agent quotes it. So the reader advertises exactly
 *    the encodings it can unpack, unpacks whatever arrives under one of them,
 *    and refuses an encoding it cannot unpack rather than guessing.
 *  - **Charset.** A page in Latin-1 or Windows-1252 read as UTF-8 loses every
 *    accent. The header's `charset` wins, then a byte-order mark, then the
 *    page's own `<meta charset>`, then UTF-8.
 *  - **Garbage.** Whatever still decodes to mostly replacement characters or
 *    control bytes is not a page, and is refused as unreadable.
 *
 * Unpacking is bounded too: a 2 MiB gzip can inflate to gigabytes, so the
 * output has its own ceiling, and crossing it is "too large", not a crash.
 */
import zlib from 'node:zlib';

type Unpack = (input: Buffer, options: { maxOutputLength: number }) => Buffer;

const zstd = (zlib as unknown as { zstdDecompressSync?: Unpack }).zstdDecompressSync;

const UNPACK: Record<string, Unpack> = {
  gzip: (input, options) => zlib.gunzipSync(input, options),
  'x-gzip': (input, options) => zlib.gunzipSync(input, options),
  // `deflate` is meant to be zlib-wrapped; some servers send it raw.
  deflate: (input, options) => {
    try {
      return zlib.inflateSync(input, options);
    } catch (err) {
      if (err instanceof RangeError) throw err;
      return zlib.inflateRawSync(input, options);
    }
  },
  br: (input, options) => zlib.brotliDecompressSync(input, options),
  ...(zstd ? { zstd } : {}),
};

/** The `accept-encoding` the reader sends: what `UNPACK` can undo, no more. */
export const ACCEPT_ENCODING = ['gzip', 'deflate', 'br', ...(zstd ? ['zstd'] : [])].join(', ');

export type Unpacked =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too-large' | 'unreadable'; message: string };

/**
 * Undo `content-encoding`, last-applied first. A gzip body that arrives with no
 * header at all (its magic bytes say what it is) is unpacked too.
 */
export function unpack(raw: Buffer, contentEncoding: string | null, maxOutput: number): Unpacked {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '' && part !== 'identity');
  if (codings.length === 0 && raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b && raw[2] === 0x08) {
    codings.push('gzip');
  }
  let body = raw;
  for (const coding of codings.reverse()) {
    const undo = UNPACK[coding];
    if (undo === undefined) {
      return { ok: false, reason: 'unreadable', message: `the site sent the page compressed as "${coding}", which this reader cannot unpack` };
    }
    try {
      body = undo(body, { maxOutputLength: maxOutput });
    } catch (err) {
      if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        return { ok: false, reason: 'too-large', message: `that page unpacks to more than this reader will accept (${maxOutput} bytes) — I stopped` };
      }
      return { ok: false, reason: 'unreadable', message: `the site sent compressed data (${coding}) that would not unpack, so there was no readable page` };
    }
  }
  return { ok: true, body };
}

/** The charset a response is in: header, then BOM, then `<meta>`, then UTF-8. */
export function charsetOf(body: Buffer, contentType: string): string {
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (header && known(header)) return header.toLowerCase();
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  // The head of an HTML page, read as Latin-1 so no byte is lost to decoding.
  const head = body.subarray(0, 4096).toString('latin1');
  const meta =
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
  if (meta && known(meta)) return meta.toLowerCase();
  return 'utf-8';
}

function known(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/** The body as text, in its own charset. Malformed bytes become U+FFFD. */
export function decodeText(body: Buffer, contentType: string): string {
  return new TextDecoder(charsetOf(body, contentType)).decode(body);
}

/**
 * Mostly replacement characters or control bytes: binary data (or a body
 * still compressed) decoded as if it were text. Real pages, in any language,
 * have next to none of either.
 */
export function looksUnreadable(text: string): boolean {
  const sample = text.slice(0, 8000);
  if (sample.length < 20) return false;
  let bad = 0;
  let total = 0;
  for (const ch of sample) {
    total += 1;
    const code = ch.codePointAt(0)!;
    if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) || (code >= 0x7f && code < 0xa0)) bad += 1;
  }
  return bad / total > 0.1;
}

/**
 * A robot check or captcha wall where the page should be. Amazon's has a
 * sentence nobody else writes; the generic ones are only believed on a short
 * page, so an article *about* captchas is still read.
 */
export function looksTurnedAway(text: string): boolean {
  const head = text.slice(0, 20_000);
  if (/To discuss automated access to Amazon data/i.test(head)) return true;
  if (/<title>\s*(Robot Check|Attention Required!|Just a moment\.\.\.|Access Denied|Are you a robot\??)\s*<\/title>/i.test(head)) return true;
  if (text.length > 60_000) return false;
  return /Enter the characters you see below|Type the characters you see in this image|verify (that )?you are (a )?human|make sure you're not a robot|captcha-delivery\.com|px-captcha/i.test(head);
}
