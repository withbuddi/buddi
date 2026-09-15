/**
 * The transport, and the bug it exists to make impossible.
 *
 * The first test in this file is the one that matters. It reproduces, against
 * a real server on a real socket, the failure that killed a day of turns: a
 * connection that has been sitting idle, closed by the far end, handed back out
 * of a pool and written into. Node's own client fails on it — that assertion is
 * in the test, because a regression test that cannot show the bug is not
 * evidence of anything — and the transport does not.
 */
import { Agent, createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createSocketServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpTransport,
  defaultHttpTransport,
  providerHttpAgent,
  providerHttpsAgent,
  TransportError,
  type HttpTransport,
} from './transport.js';

const servers: Array<Server | NetServer> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Harness {
  url: string;
  /** Distinct TCP connections the server has accepted. */
  connections: () => number;
  /** Requests the handler has been asked to answer. */
  requests: () => number;
}

async function serve(
  handler: (n: number) => { status?: number; body?: string; destroy?: boolean },
  options: { keepAliveTimeout?: number } = {},
): Promise<Harness> {
  let connections = 0;
  let requests = 0;
  const server = createServer((req, res) => {
    // Drain the body, so the client's write always completes.
    req.on('data', () => {});
    req.on('end', () => {
      requests += 1;
      const answer = handler(requests);
      if (answer.destroy) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial"');
        res.socket?.destroy();
        return;
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(answer.body ?? '{"ok":true}');
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  if (options.keepAliveTimeout !== undefined) server.keepAliveTimeout = options.keepAliveTimeout;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/messages`,
    connections: () => connections,
    requests: () => requests,
  };
}

const post = (transport: HttpTransport, url: string): ReturnType<HttpTransport> =>
  transport(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Node's own client on the same pooled agent, so the bug is visible. */
function rawPost(url: string, agent: Agent): Promise<string> {
  const target = new URL(url);
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(`status ${res.statusCode}`));
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => resolve(`threw ${err.code ?? err.message}`));
    req.end('{}');
  });
}

/**
 * A server that answers the first request on a connection and is *gone* for the
 * second one, without ever having told the client.
 *
 * This is the whole bug in eight lines. A real endpoint closes an idle
 * keep-alive connection and the notice is lost — a NAT table expires, a load
 * balancer drains a node, a FIN arrives in the same tick as our write — so the
 * client still believes it has a connection, takes it out of the pool, writes a
 * POST into it and gets nothing back. Destroying the socket on the second
 * request reproduces exactly what the client sees, deterministically: a reused
 * socket, no response byte, `ECONNRESET`.
 */
async function serveStale(): Promise<Harness> {
  let connections = 0;
  let requests = 0;
  const server = createSocketServer((socket) => {
    connections += 1;
    let seen = 0;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      // One request per chunk is enough: the bodies here are two bytes.
      if (!chunk.includes('\r\n\r\n')) return;
      seen += 1;
      requests += 1;
      if (seen > 1) {
        // "I closed this a while ago and never got to tell you."
        socket.destroy();
        return;
      }
      const body = '{"ok":true}';
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/messages`,
    connections: () => connections,
    requests: () => requests,
  };
}

describe('a pooled connection the far end had already closed', () => {
  it('breaks Node\u2019s own client, and does not break the transport', async () => {
    // First, the bug itself: Node's client, a keep-alive agent, two requests.
    const bare = await serveStale();
    const bareAgent = new Agent({ keepAlive: true });
    expect(await rawPost(bare.url, bareAgent)).toBe('status 200');
    expect(await rawPost(bare.url, bareAgent)).toMatch(/^threw (ECONNRESET|EPIPE|ERR_)/);
    bareAgent.destroy();

    // Now the same server, the same kind of agent, through the transport. The
    // second request is retried on a fresh connection and the owner's turn
    // lives. That retry is safe *because* the socket was reused and no byte of
    // a response had arrived — see the header of `transport.ts`.
    const harness = await serveStale();
    const pooled = new Agent({ keepAlive: true });
    const transport = createHttpTransport({ agent: pooled });
    expect((await post(transport, harness.url)).status).toBe(200);
    const second = await post(transport, harness.url);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    // Two connections: the dead one was abandoned, not waited on.
    expect(harness.connections()).toBe(2);
    pooled.destroy();
  }, 15_000);

  it('cannot happen at all on the default transport: nothing is ever pooled', async () => {
    const harness = await serve(() => ({}), { keepAliveTimeout: 150 });
    expect((await post(defaultHttpTransport, harness.url)).status).toBe(200);
    await sleep(300);
    expect((await post(defaultHttpTransport, harness.url)).status).toBe(200);
    // Two requests, two connections: no socket survived to go stale.
    expect(harness.connections()).toBe(2);
  }, 15_000);
});

/**
 * The acceptance test for the wedge.
 *
 * The sharpest fact about the live failure was not that a request failed. It
 * was that the process never recovered: after the first `fetch failed`, the
 * owner typed "hey" and that failed too, in a millisecond, and every request
 * after it, for hours, until the service was killed. undici had a destroyed
 * HTTP/2 session in its pool for that origin and kept handing it back.
 *
 * So the bar is this, in one sentence: **a long-lived process that has just
 * seen a connection failure must succeed on its very next request.** It holds
 * here for the reason it will always hold — this transport keeps no
 * connection, no client and no pool between requests, so there is nothing for
 * a dead one to be cached in.
 */
describe('a process that has already seen a failure', () => {
  it('succeeds on its very next request, with no restart and no reset', async () => {
    let requests = 0;
    const server = createSocketServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        if (!chunk.includes('\r\n\r\n')) return;
        requests += 1;
        if (requests === 1) {
          // The first request dies at the socket, on a fresh connection: this
          // transport does not retry that, so the failure really surfaces.
          socket.destroy();
          return;
        }
        const body = '{"ok":true}';
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/messages`;

    // One transport, one process, three requests in a row.
    await expect(post(defaultHttpTransport, url)).rejects.toBeInstanceOf(TransportError);
    expect((await post(defaultHttpTransport, url)).status).toBe(200);
    expect((await post(defaultHttpTransport, url)).status).toBe(200);
  }, 15_000);

  it('holds nothing between requests that a dead connection could hide in', () => {
    // The structural guarantee behind the test above: no keep-alive, therefore
    // no free list, therefore nothing to evict and nothing to go stale.
    const optionsOf = (agent: unknown): { keepAlive?: boolean } =>
      (agent as { options: { keepAlive?: boolean } }).options;
    expect(optionsOf(providerHttpsAgent).keepAlive).toBe(false);
    expect(optionsOf(providerHttpAgent).keepAlive).toBe(false);
    // And nothing is being held right now, either.
    expect(Object.keys(providerHttpsAgent.freeSockets)).toHaveLength(0);
    expect(Object.keys(providerHttpAgent.freeSockets)).toHaveLength(0);
  });
});

describe('what is safe to retry', () => {
  it('does not retry once any response byte has arrived', async () => {
    // The server answers, then dies mid-body. It *did* act on the request, so
    // sending it again could act on it twice. `email.send` is downstream.
    const harness = await serve(() => ({ destroy: true }));
    const pooled = new Agent({ keepAlive: true });
    const transport = createHttpTransport({ agent: pooled });
    await expect(post(transport, harness.url)).rejects.toBeInstanceOf(TransportError);
    expect(harness.requests()).toBe(1);
    pooled.destroy();
  });

  it('does not retry a failure on a connection that was never reused', async () => {
    // Nothing is listening: the connection never came up, so `reusedSocket` is
    // false and this transport does not try again — the adapter's own budget
    // decides that, where it is a deliberate choice rather than a silent one.
    const transport = createHttpTransport();
    const err = await post(transport, 'http://127.0.0.1:1/v1/messages').catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).reusedSocket).toBe(false);
    expect((err as TransportError).neverSent).toBe(true);
  });

  it('carries the cause, so the log gets the real code', async () => {
    const err = await post(defaultHttpTransport, 'http://127.0.0.1:1/v1/messages').catch((e) => e);
    expect((err as TransportError).cause).toBeDefined();
    expect((err as { cause: NodeJS.ErrnoException }).cause.code).toBe('ECONNREFUSED');
  });
});

describe('the response an adapter sees', () => {
  it('is the slice of `Response` the adapters use, and nothing else', async () => {
    const harness = await serve(() => ({ status: 429, body: '{"error":{"type":"rate_limit"}}' }));
    const res = await post(defaultHttpTransport, harness.url);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    expect(res.statusText).toBe('Too Many Requests');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('x-nothing')).toBeNull();
    expect(await res.json()).toEqual({ error: { type: 'rate_limit' } });
  });

  it('reads the body as text when it is not JSON', async () => {
    const harness = await serve(() => ({ status: 500, body: 'upstream exploded' }));
    const res = await post(defaultHttpTransport, harness.url);
    expect(await res.text()).toBe('upstream exploded');
  });
});

describe('a connection that goes silent', () => {
  it('is abandoned rather than waited on forever', async () => {
    const server = createServer(() => {
      /* never answers */
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const transport = createHttpTransport({ idleTimeoutMs: 120 });
    const err = await post(transport, `http://127.0.0.1:${port}/`).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toContain('went silent');
  }, 10_000);
});

/**
 * What the transport had to grow to carry every outbound caller in the repo,
 * and the proof that growing it did not loosen the one rule that matters.
 */
describe('bodies and responses that are bytes', () => {
  /** A server that hands back exactly what it was given, plus what it saw. */
  async function echo(): Promise<{ url: string; seen: () => { body: Buffer; type: string | undefined; method: string } }> {
    let last: { body: Buffer; type: string | undefined; method: string } = {
      body: Buffer.alloc(0),
      type: undefined,
      method: '',
    };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        last = {
          body: Buffer.concat(chunks),
          type: req.headers['content-type'],
          method: req.method ?? '',
        };
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(last.body);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/upload`, seen: () => last };
  }

  it('sends a multipart upload byte for byte and reads the bytes back', async () => {
    // Every byte 0..255, which is what makes this a real test: a body squeezed
    // through a UTF-8 string would come back mangled, and a PDF or a photo on
    // its way to Telegram is exactly this.
    const file = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const boundary = '----buddi-test-boundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n42\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="s.bin"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const harness = await echo();
    const res = await defaultHttpTransport(harness.url, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(200);
    // What the server received, and what we read back, are both the exact bytes.
    expect(harness.seen().body.equals(body)).toBe(true);
    expect(harness.seen().type).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  });

  it('sends a GET with no body and no content-length', async () => {
    const harness = await echo();
    const res = await defaultHttpTransport(harness.url, { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    expect(harness.seen().method).toBe('GET');
    expect(harness.seen().body).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('abandons the request when the caller aborts, and never retries it', async () => {
    let requests = 0;
    const server = createServer(() => {
      requests += 1;
      /* never answers: this is the long poll being stopped mid-flight */
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/getUpdates`;

    const controller = new AbortController();
    // A pooling agent, so the only reason *not* to retry is that it was aborted.
    const pooled = new Agent({ keepAlive: true });
    const transport = createHttpTransport({ agent: pooled });
    const inflight = transport(url, { method: 'POST', headers: {}, body: '{}', signal: controller.signal });
    await sleep(50);
    controller.abort();

    const err = await inflight.catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).aborted).toBe(true);
    await sleep(50);
    // One request, not two: a shutdown is an instruction, not a failure.
    expect(requests).toBe(1);
    pooled.destroy();
  }, 10_000);

  it('refuses immediately when the signal is already aborted', async () => {
    const harness = await serve(() => ({}));
    const err = await defaultHttpTransport(harness.url, {
      method: 'POST',
      headers: {},
      body: '{}',
      signal: AbortSignal.abort(),
    }).catch((e) => e);
    expect((err as TransportError).aborted).toBe(true);
    expect(harness.requests()).toBe(0);
  });
});

describe('the silence budget', () => {
  it('is per request, so a long poll outlives the default', async () => {
    // The transport default here is 100ms; the server says nothing for 400ms,
    // which is what a long poll looks like. The request that asks for its own
    // budget lives; the one that does not, dies. This is the whole reason
    // `idleTimeoutMs` is on the request and not only on the transport.
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }, 400);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/getUpdates`;
    const transport = createHttpTransport({ idleTimeoutMs: 100 });

    const patient = await transport(url, {
      method: 'POST',
      headers: {},
      body: '{}',
      idleTimeoutMs: 5_000,
    });
    expect(patient.status).toBe(200);

    const impatient = await transport(url, { method: 'POST', headers: {}, body: '{}' }).catch((e) => e);
    expect(impatient).toBeInstanceOf(TransportError);
    expect((impatient as TransportError).message).toContain('went silent');
  }, 10_000);
});
