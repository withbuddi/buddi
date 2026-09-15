/**
 * The Telegram client on the shared transport — against real sockets.
 *
 * The bug this is about never showed itself here: the poll loop reconnects to
 * `api.telegram.org` every twenty-five seconds, so a connection rarely sits
 * idle long enough to be closed under us. That is luck. The client had the same
 * defect the provider path had — the global `fetch` is undici, undici pools a
 * connection per origin, and a dead pooled connection is handed back for ever —
 * and the shape of the failure here is the worst one this assistant has: a bot
 * that is running, reachable, and answers nothing at all.
 *
 * So these tests are about the two facts that make the surface survivable: a
 * connection failure does not outlive the request it happened on, and a long
 * poll — which is *meant* to sit silent for half a minute — is not mistaken for
 * one.
 */
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { createHttpTransport } from '@buddi/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  POLL_IDLE_TIMEOUT_MS,
  POLL_TIMEOUT_SECONDS,
  TELEGRAM_IDLE_TIMEOUT_MS,
  TelegramApi,
  telegramFetchOn,
  type FetchLike,
} from './api.js';

const servers: Array<Server | NetServer> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const listen = async (server: Server | NetServer): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

/** Telegram's envelope: everything the client accepts looks like this. */
const okBody = (result: unknown): string => JSON.stringify({ ok: true, result });

describe('a Bot API call whose connection dies', () => {
  it('does not wedge the bot: the very next message goes out', async () => {
    let requests = 0;
    // The first request dies on the socket with nothing written back — a
    // dropped connection, a drained load balancer, a NAT entry that expired.
    const server = createSocketServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk: Buffer) => {
        if (!chunk.includes('\r\n\r\n')) return;
        requests += 1;
        if (requests === 1) {
          socket.destroy();
          return;
        }
        const body = okBody({ message_id: 101 });
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
      });
    });
    const baseUrl = await listen(server);
    const api = new TelegramApi({ token: 'test-token', baseUrl });

    // The failure surfaces — it is a real failure and must not be swallowed…
    await expect(api.sendMessage(7, 'first')).rejects.toThrow();
    // …and then the bot answers, in the same process, with no restart. This is
    // the whole acceptance bar: on the old client every later call failed in a
    // millisecond, for ever, because undici kept handing back the dead session.
    expect(await api.sendMessage(7, 'second')).toBe(101);
    expect(await api.sendMessage(7, 'third')).toBe(101);
  }, 15_000);

  it('never sends the same message twice when a connection dies', async () => {
    // A message is an outside effect. The transport's one retry is for a socket
    // taken from a free list with no response byte seen; the default agent
    // pools nothing, so `reusedSocket` is never true and this path cannot
    // duplicate a message. The server counts, which is the only proof worth
    // having.
    let requests = 0;
    const server = createSocketServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk: Buffer) => {
        if (!chunk.includes('\r\n\r\n')) return;
        requests += 1;
        socket.destroy();
      });
    });
    const baseUrl = await listen(server);
    const api = new TelegramApi({ token: 'test-token', baseUrl });
    await expect(api.sendMessage(7, 'only once')).rejects.toThrow();
    expect(requests).toBe(1);
  }, 15_000);
});

describe('the long poll', () => {
  it('survives a silence that would kill an ordinary call', async () => {
    // Telegram answers `getUpdates` only when something happens, so the socket
    // is quiet on purpose for up to POLL_TIMEOUT_SECONDS. Here the server is
    // quiet for 400ms while the transport's own budget is 100ms: the poll lives
    // because it carries its own, and a request that does not carry one dies on
    // the very same server.
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const isPoll = (req.url ?? '').endsWith('/getUpdates');
        setTimeout(
          () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(okBody(isPoll ? [{ update_id: 5 }] : { message_id: 1 }));
          },
          400,
        );
      });
    });
    const baseUrl = await listen(server);
    const impatient: FetchLike = telegramFetchOn(createHttpTransport({ idleTimeoutMs: 100 }));
    const api = new TelegramApi({ token: 'test-token', baseUrl, fetch: impatient });

    const updates = await api.getUpdates(undefined);
    expect(updates).toEqual([{ update_id: 5 }]);

    await expect(
      impatient(`${baseUrl}/bot-test-token/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).rejects.toThrow(/went silent/);
  }, 15_000);

  it('asks for a budget longer than Telegram’s own timeout, and only for the poll', async () => {
    // The numbers, pinned: a poll that dies is dropped and retried in seconds
    // rather than hanging the surface until some five-minute default expires.
    expect(POLL_IDLE_TIMEOUT_MS).toBeGreaterThan(POLL_TIMEOUT_SECONDS * 1000);
    expect(POLL_IDLE_TIMEOUT_MS).toBeGreaterThan(TELEGRAM_IDLE_TIMEOUT_MS);

    const budgets: Array<number | undefined> = [];
    const recording: FetchLike = async (_url, init = {}) => {
      budgets.push(init.idleTimeoutMs);
      return { ok: true, status: 200, text: async () => okBody([]) };
    };
    const api = new TelegramApi({ token: 't', fetch: recording });
    await api.getUpdates(undefined);
    await api.sendMessage(7, 'hi');
    expect(budgets).toEqual([POLL_IDLE_TIMEOUT_MS, TELEGRAM_IDLE_TIMEOUT_MS]);
  });

  it('stops when the surface aborts it, and opens no second connection', async () => {
    // `TelegramSurface.stop()` aborts the in-flight poll. An abort is an
    // instruction, not a failure: nothing is retried behind it.
    let connections = 0;
    const server = createServer(() => {
      connections += 1;
      /* holds the request open, as Telegram would */
    });
    const baseUrl = await listen(server);
    const api = new TelegramApi({ token: 'test-token', baseUrl });
    const abort = new AbortController();
    const poll = api.getUpdates(undefined, abort.signal);
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await expect(poll).rejects.toThrow(/aborted/);
    await new Promise((r) => setTimeout(r, 100));
    expect(connections).toBe(1);
  }, 15_000);
});

describe('a file coming back from Telegram', () => {
  it('arrives as the exact bytes, not as text', async () => {
    // `downloadFile` is the one endpoint that answers a PDF rather than JSON.
    // Every byte 0..255, because a body that went through a UTF-8 string would
    // come back corrupted and the owner would get an unopenable statement.
    const file = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(file);
    });
    const baseUrl = await listen(server);
    const api = new TelegramApi({ token: 'test-token', baseUrl });
    const got = await api.downloadFile('documents/file_7.pdf');
    expect(got.equals(file)).toBe(true);
  }, 15_000);
});
