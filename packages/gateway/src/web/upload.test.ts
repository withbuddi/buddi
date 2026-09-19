/**
 * The upload parser, without a socket.
 *
 * The routes are asserted over HTTP in `chat.web.db.test.ts`; what is here is
 * the part that has to be right about *bytes* — a boundary, a filename that
 * arrived from another machine, and the decision about what the runtime can
 * actually use.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  acceptedUpload,
  multipartBoundary,
  readUpload,
  resolveUploadMime,
  safeFilename,
} from './upload.js';

/** A request carrying one multipart body, as a browser would send it. */
function request(
  parts: Array<{ name: string; filename?: string; type?: string; body: Buffer | string }>,
  boundary = 'X-BOUNDARY',
  contentType = `multipart/form-data; boundary=${boundary}`,
): IncomingMessage {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename === undefined
      ? `form-data; name="${part.name}"`
      : `form-data; name="${part.name}"; filename="${part.filename}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
          (part.type ? `Content-Type: ${part.type}\r\n` : '') +
          '\r\n',
        'utf8',
      ),
      Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const stream = Readable.from([Buffer.concat(chunks)]) as unknown as IncomingMessage;
  stream.headers = { 'content-type': contentType };
  return stream;
}

describe('multipartBoundary', () => {
  it('reads the boundary, quoted or not, and refuses anything else', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc');
    expect(multipartBoundary('multipart/form-data; boundary="a b c"')).toBe('a b c');
    expect(multipartBoundary('MULTIPART/FORM-DATA; BOUNDARY=abc')).toBe('abc');
    expect(multipartBoundary('application/json')).toBeUndefined();
    expect(multipartBoundary('multipart/form-data')).toBeUndefined();
    expect(multipartBoundary(undefined)).toBeUndefined();
  });
});

describe('safeFilename', () => {
  it('keeps the basename and nothing else', () => {
    expect(safeFilename('statement.csv')).toBe('statement.csv');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\a.png')).toBe('a.png');
    expect(safeFilename('..')).toBe('upload');
    expect(safeFilename('')).toBe('upload');
    expect(safeFilename('a\u0000b.txt')).toBe('ab.txt');
  });
});

describe('what the runtime can use', () => {
  it('takes images and documents', () => {
    for (const [mime, name] of [
      ['image/png', 'a.png'],
      ['application/pdf', 'a.pdf'],
      ['text/csv', 'a.csv'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'],
    ] as const) {
      expect(acceptedUpload(mime, name).ok, name).toBe(true);
    }
  });

  it('falls back to the extension when the browser will not say', () => {
    // Chrome sends octet-stream for a `.md`; the file is still a document.
    expect(resolveUploadMime('application/octet-stream', 'notes.md')).toBe('text/markdown');
    expect(resolveUploadMime('', 'export.csv')).toBe('text/csv');
    // A type the browser *did* state is never second-guessed from the name.
    expect(resolveUploadMime('image/png', 'thing.csv')).toBe('image/png');
  });

  it('keeps the rest too, under the mime it resolves to', () => {
    // A zip, a video, a bare binary: all stored. The runtime tells the model
    // which of them it can look at and names the others by id.
    expect(acceptedUpload('application/zip', 'export.zip')).toEqual({ ok: true, mime: 'application/zip' });
    expect(acceptedUpload('video/mp4', 'clip.mp4').ok).toBe(true);
    expect(acceptedUpload('application/octet-stream', 'thing.bin').ok).toBe(true);
  });
});

describe('readUpload', () => {
  it('reads one file, its name and its bytes', async () => {
    const bytes = Buffer.from('date,amount\n2026-09-01,-12.40\n');
    const result = await readUpload(request([{ name: 'file', filename: 'a.csv', type: 'text/csv', body: bytes }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toMatchObject({ filename: 'a.csv', mime: 'text/csv' });
    // Byte-exact: the trailing CRLF belongs to the delimiter, not to the file.
    expect(result.file.bytes.equals(bytes)).toBe(true);
  });

  it('skips the fields around the file', async () => {
    const result = await readUpload(
      request([
        { name: 'conversationId', body: 'not-a-file' },
        { name: 'file', filename: 'b.txt', type: 'text/plain', body: 'hello' },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.filename).toBe('b.txt');
    expect(result.file.bytes.toString('utf8')).toBe('hello');
  });

  it('refuses a body that is not multipart, carries no file, or is empty', async () => {
    const json = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage;
    json.headers = { 'content-type': 'application/json' };
    expect(await readUpload(json)).toMatchObject({ ok: false, status: 400 });

    expect(await readUpload(request([{ name: 'text', body: 'no file here' }]))).toMatchObject({
      ok: false,
      status: 400,
    });

    expect(
      await readUpload(request([{ name: 'file', filename: 'empty.txt', type: 'text/plain', body: '' }])),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses an oversize file with the size it would accept', async () => {
    const big = Buffer.alloc(4096, 0x61);
    const result = await readUpload(
      request([{ name: 'file', filename: 'big.txt', type: 'text/plain', body: big }]),
      1024,
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('keeps a type the model cannot look at, under the mime it came with', async () => {
    const result = await readUpload(
      request([{ name: 'file', filename: 'clip.mp4', type: 'video/mp4', body: 'fake' }]),
    );
    expect(result).toMatchObject({ ok: true, file: { filename: 'clip.mp4', mime: 'video/mp4' } });
  });
});
