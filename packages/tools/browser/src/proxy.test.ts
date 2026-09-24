import { createServer, createConnection, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@buddi/core/plugin';
import { startProxy } from './proxy.js';

async function connect(proxyUrl: string, host: string, port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(proxyUrl).port) });
  socket.setTimeout(2000, () => socket.destroy(new Error('timeout')));
  await once(socket, 'connect');
  socket.write(Buffer.from([5, 1, 0]));
  await once(socket, 'data');
  const name = Buffer.from(host);
  const request = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.alloc(2)]);
  request.writeUInt16BE(port, request.length - 2);
  const result = new Promise<Socket>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('refused')));
    socket.once('data', (bytes: Buffer) => {
      if (bytes[1] === 0) resolve(socket);
      else { socket.destroy(); reject(new Error('refused')); }
    });
  });
  socket.write(request);
  return result;
}

describe('browser egress proxy', () => {
  it('refuses private destinations, custom ports, and DNS rebinding answers', async () => {
    let lookups = 0;
    const proxy = await startProxy({ resolve: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
    try {
      await expect(connect(proxy.url, '127.0.0.1', 80)).rejects.toThrow('refused');
      await expect(connect(proxy.url, 'public.example', 4317)).rejects.toThrow('refused');
      await expect(connect(proxy.url, 'public.example', 443)).rejects.toThrow('refused');
      expect(lookups).toBe(1);
    } finally { await proxy.close(); }
  });
  it('dials the checked resolver result, not a second DNS answer', async () => {
    const target = createServer((socket) => socket.pipe(socket));
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const port = (target.address() as AddressInfo).port;
    let lookups = 0;
    const proxy = await startProxy({ policy: { ...DEFAULT_POLICY, ports: [port], blocked: () => null },
      resolve: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
    try {
      const socket = await connect(proxy.url, 'fixture.example', port);
      const reply = once(socket, 'data'); socket.write('fixture');
      expect(String((await reply)[0])).toBe('fixture');
      expect(lookups).toBe(1);
      socket.destroy();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
