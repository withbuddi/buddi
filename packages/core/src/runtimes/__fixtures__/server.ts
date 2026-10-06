/**
 * A fake download server for the runtimes tests: a real HTTP server on
 * 127.0.0.1, an ephemeral port, and a `DownloadGet` that sends the pinned
 * https addresses to it. Nothing here reaches the network.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { nodeGet, type DownloadGet } from '../download.js';

export type Mode = 'ok' | 'corrupt' | 'partial' | 'missing';

export interface FakeServer {
  get: DownloadGet;
  /** What each path answers. */
  files: Map<string, Buffer>;
  /** How the next answers behave, by path; `ok` when unset. */
  modes: Map<string, Mode>;
  /** How many times each path was asked for. */
  hits: Map<string, number>;
  /** Paths answered with a 302 to another https address. */
  redirects: Map<string, string>;
  close(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, Mode>();
  const hits = new Map<string, number>();
  const redirects = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const to = redirects.get(url.pathname);
    if (to !== undefined) {
      res.writeHead(302, { location: to }).end();
      return;
    }
    const body = files.get(url.pathname);
    const mode = modes.get(url.pathname) ?? 'ok';
    if (body === undefined || mode === 'missing') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' });
    if (mode === 'corrupt') {
      const bad = Buffer.from(body);
      bad[Math.floor(bad.length / 2)] = (bad[Math.floor(bad.length / 2)]! + 1) % 256;
      res.end(bad);
      return;
    }
    if (mode === 'partial') {
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => {
        res.socket?.destroy();
      });
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const get = nodeGet(
    httpRequest as never,
    (url) => `http://127.0.0.1:${port}${new URL(url).pathname}`,
    true,
  );
  return {
    get,
    files,
    modes,
    hits,
    redirects,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A gzipped ustar archive of these entries. */
export function tgz(entries: ReadonlyArray<{ name: string; body: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${entry.body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header, entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
