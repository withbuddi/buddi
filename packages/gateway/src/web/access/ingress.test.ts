/**
 * The ingress listener (ingress.ts): a server-level error after it is
 * listening (EMFILE on accept) is logged, never an unhandled 'error' event
 * that would take the gateway down.
 */
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

const created: Server[] = [];
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      created.push(server);
      return server;
    },
  };
});

const { createIngress } = await import('./ingress.js');

describe('the ingress listener', () => {
  it('logs an error that comes after it is listening, and keeps listening', async () => {
    const lines: string[] = [];
    const ingress = createIngress({
      onRequest: (_req, res) => { res.end('ok'); },
      onUpgrade: (_req, socket) => { socket.destroy(); },
      port: () => 0,
      wanted: async () => true,
      log: (line) => lines.push(line),
    });
    await ingress.sync();
    const port = ingress.port();
    expect(port).toEqual(expect.any(Number));
    const server = created.at(-1)!;
    const failure = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' });
    expect(() => server.emit('error', failure)).not.toThrow();
    expect(lines.at(-1)).toContain('EMFILE');
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    await ingress.close();
  });
});
