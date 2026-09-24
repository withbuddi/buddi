/** SOCKS5 CONNECT only. DNS is checked by the socket's resolver, not before a
 * second browser resolution. No UDP, local services, or filesystem URLs.
 * This is egress confinement for the browser, not an OS sandbox for plugins. */
import { createConnection, createServer, type Socket, type AddressInfo } from 'node:net';
// Not yet on ctx.buddi: the proxy dials raw sockets, not HTTP requests, and is
// started before any context exists; ctx.buddi.http has no resolver to hand out.
import { guardedLookup, type LookupAll } from '@buddi/core';
import { checkUrl, DEFAULT_POLICY, type AddressPolicy } from '@buddi/core/plugin';

export async function startProxy(options: { policy?: AddressPolicy; resolve?: LookupAll } = {}) {
  const policy = options.policy ?? DEFAULT_POLICY;
  const sockets = new Set<Socket>();
  const track = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    client.setTimeout(30_000, () => client.destroy());
    let buffer = Buffer.alloc(0);
    let greeting = true;
    const receive = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65_536) { client.destroy(); return; }
      if (greeting) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]!).includes(0)) {
          client.end(Buffer.from([5, 255])); return;
        }
        buffer = buffer.subarray(2 + buffer[1]!);
        client.write(Buffer.from([5, 0]));
        greeting = false;
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) { client.destroy(); return; }
      const kind = buffer[3];
      const size = kind === 1 ? 4 : kind === 4 ? 16 : kind === 3 ? 1 + buffer[4]! : 0;
      if (!size) { client.destroy(); return; }
      if (buffer.length < 4 + size + 2) return;
      const host = kind === 1 ? [...buffer.subarray(4, 8)].join('.')
        : kind === 4 ? `[${Array.from({ length: 8 }, (_, i) => buffer.readUInt16BE(4 + i * 2).toString(16)).join(':')}]`
        : buffer.subarray(5, 4 + size).toString('utf8');
      const port = buffer.readUInt16BE(4 + size);
      try {
        if (!policy.ports.includes(port) || /[\s/@?#\\]/.test(host)) throw new Error('Invalid SOCKS destination');
        const checked = checkUrl(`http://${host}:${port}`, policy);
        const upstream = track(createConnection({ host: checked.hostname, port,
          lookup: guardedLookup(options.resolve, policy) }));
        client.removeListener('data', receive);
        client.pause();
        const rest = buffer.subarray(6 + size);
        upstream.setTimeout(30_000, () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        upstream.once('connect', () => {
          client.setTimeout(0);
          upstream.setTimeout(0);
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
      } catch {
        client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    };
    client.on('data', receive);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `socks5://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
