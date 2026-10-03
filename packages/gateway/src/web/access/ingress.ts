/**
 * The ingress listener (specs/trusted-access.md §3.3).
 *
 * A second loopback listener for a proxy on this machine other than
 * Tailscale (cloudflared). Every socket it accepts is tagged `ingress`
 * (`arrival.ts`) before a byte of the request is read, so every request on it
 * is remote and fails every loopback-only check, whatever it says about
 * itself. It is bound only while such a provider is on, and closed when the
 * last one goes off.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { markSocketArrival } from './arrival.js';

export interface Ingress {
  /** Bind or close to match `wanted()`. Serialised: overlapping calls run in turn. */
  sync(): Promise<void>;
  /** The bound port, or null while it is not listening. */
  port(): number | null;
  /** Why it is not listening although it is wanted, in words; null when fine. */
  problem(): string | null;
  close(): Promise<void>;
}

export function createIngress(opts: {
  onRequest: (req: IncomingMessage, res: ServerResponse) => void;
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The port to bind: the dashboard's + 2, `BUDDI_INGRESS_PORT`, or 0 in tests. */
  port: () => number;
  wanted: () => Promise<boolean>;
  log: (line: string) => void;
}): Ingress {
  let server: Server | null = null;
  let bound: number | null = null;
  let problem: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const open = async (): Promise<void> => {
    const port = opts.port();
    const next = createServer(opts.onRequest);
    next.on('connection', (socket) => markSocketArrival(socket, 'ingress'));
    next.on('upgrade', (req, socket, head) => opts.onUpgrade(req as IncomingMessage, socket, head as Buffer));
    await new Promise<void>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        problem = err.code === 'EADDRINUSE'
          ? `Port ${port}, where cloudflared should point, is taken by another program. Free it, or set BUDDI_INGRESS_PORT, and restart buddi.`
          : `The port for cloudflared (${port}) could not be opened: ${err.message}.`;
        opts.log(`access: the ingress listener could not bind 127.0.0.1:${port}: ${err.code ?? err.message}`);
        resolve();
      };
      next.once('error', onError);
      next.listen(port, '127.0.0.1', () => {
        next.removeListener('error', onError);
        server = next;
        bound = (next.address() as AddressInfo | null)?.port ?? port;
        problem = null;
        opts.log(`access: listening for cloudflared on 127.0.0.1:${bound}`);
        resolve();
      });
    });
  };

  const shut = async (): Promise<void> => {
    const current = server;
    server = null;
    bound = null;
    if (!current) return;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections?.();
    });
  };

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const run = chain.then(op, op);
    chain = run.catch(() => {});
    return run;
  };

  return {
    sync: () => enqueue(async () => {
      const want = await opts.wanted().catch(() => false);
      if (want && !server) await open();
      else if (!want) { problem = null; await shut(); }
    }),
    port: () => bound,
    problem: () => problem,
    close: () => enqueue(async () => { problem = null; await shut(); }),
  };
}
