/** Remove buddi from this Mac, the gateway's half: the token and the refusals, against a fake supervisor socket. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKOUT_UNINSTALL,
  createTokenStore,
  uninstallBackupRoute,
  uninstallJobRoute,
  uninstallPlanRoute,
  uninstallRoute,
  withoutPassphrase,
} from './uninstall.js';

const dir = mkdtempSync(path.join(tmpdir(), 'bu-'));
const socket = path.join(dir, 's.sock');
const asked: Array<{ method: string; url: string; body: string }> = [];
let server: Server;
let removeStatus = 202;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/uninstall' && req.method === 'GET') return res.end(JSON.stringify({ data: '/d', backups: '/h/buddi-backups', appFinishes: true }));
      if (req.url === '/uninstall/backup') { res.statusCode = 202; return res.end(JSON.stringify({ job: { id: 'j' } })); }
      if (req.url === '/uninstall') {
        res.statusCode = removeStatus;
        return res.end(JSON.stringify(removeStatus === 202 ? { accepted: true } : { error: 'Take the last backup first.' }));
      }
      if (req.url?.startsWith('/jobs/u')) return res.end(JSON.stringify({ kind: 'uninstall-backup', phase: 'done', report: { archive: '/a', passphrase: 'six words' } }));
      if (req.url?.startsWith('/jobs/b')) return res.end(JSON.stringify({ kind: 'backup', phase: 'done', report: { archive: 'x' } }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const env = { BUDDI_SUPERVISOR_SOCKET: socket };
const T = new Date('2026-10-04T10:00:00Z');

describe('the uninstall token', () => {
  it('is good for one plan, until it expires or a new plan replaces it', () => {
    const tokens = createTokenStore(1000);
    const first = tokens.mint(0);
    expect(tokens.check(first, 999)).toBe(true);
    expect(tokens.check(first, 1001)).toBe(false);
    const second = tokens.mint(0);
    expect(tokens.check(first, 1)).toBe(false);
    expect(tokens.check(second, 1)).toBe(true);
    tokens.spend();
    expect(tokens.check(second, 1)).toBe(false);
    expect(tokens.check(undefined, 1)).toBe(false);
  });
});

describe('the routes', () => {
  it('a checkout is told to use the terminal', async () => {
    expect(await uninstallPlanRoute({ env: {} }, createTokenStore())).toEqual({ status: 200, body: { available: false, reason: CHECKOUT_UNINSTALL } });
    expect((await uninstallRoute({ env: {} }, createTokenStore(), { token: 'x', wroteItDown: true })).status).toBe(409);
  });

  it('the plan carries a token; the backup and the removal need it, and the removal needs "I wrote it down"', async () => {
    const tokens = createTokenStore();
    const plan = await uninstallPlanRoute({ env, now: () => T }, tokens);
    expect(plan.status).toBe(200);
    const body = plan.body as { available: boolean; token: string; appFinishes: boolean };
    expect(body).toMatchObject({ available: true, appFinishes: true });
    asked.length = 0;
    expect((await uninstallBackupRoute({ env, now: () => T }, tokens, { token: 'forged' })).status).toBe(403);
    expect(await uninstallBackupRoute({ env, now: () => T }, tokens, { token: body.token })).toEqual({ status: 202, body: { job: { id: 'j' } } });
    expect((await uninstallRoute({ env, now: () => T }, tokens, { token: body.token })).status).toBe(400);
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(['POST /uninstall/backup']);
    expect(await uninstallRoute({ env, now: () => T }, tokens, { token: body.token, wroteItDown: true, keepData: true })).toEqual({ status: 202, body: { accepted: true } });
    expect(asked[asked.length - 1]).toMatchObject({ method: 'POST', url: '/uninstall', body: JSON.stringify({ keepData: true }) });
    // Spent: the same token removes nothing a second time.
    expect((await uninstallRoute({ env, now: () => T }, tokens, { token: body.token, wroteItDown: true })).status).toBe(403);
  });

  it('an expired token removes nothing', async () => {
    const tokens = createTokenStore();
    const { token } = (await uninstallPlanRoute({ env, now: () => T }, tokens)).body as { token: string };
    const later = new Date(T.getTime() + 31 * 60_000);
    expect((await uninstallRoute({ env, now: () => later }, tokens, { token, wroteItDown: true })).status).toBe(403);
  });

  it('the words travel only on the uninstall job route', async () => {
    expect((await uninstallJobRoute({ env }, 'u1')).body).toMatchObject({ report: { passphrase: 'six words' } });
    expect((await uninstallJobRoute({ env }, 'b1')).status).toBe(404);
    // The generic job routes never show an uninstall's job, and never a report's words.
    expect(withoutPassphrase({ status: 200, body: { kind: 'uninstall-backup', report: { archive: '/a', passphrase: 'six words' } } }))
      .toEqual({ status: 404, body: { error: 'no such job' } });
    expect(withoutPassphrase({ status: 200, body: { kind: 'upgrade', report: { archive: '/a', passphrase: 'six words' } } }))
      .toEqual({ status: 200, body: { kind: 'upgrade', report: { archive: '/a' } } });
    expect(withoutPassphrase({ status: 200, body: { kind: 'backup', report: { archive: 'x' } } }))
      .toEqual({ status: 200, body: { kind: 'backup', report: { archive: 'x' } } });
  });

  it('a removal the supervisor refuses leaves the token good for the next try', async () => {
    const tokens = createTokenStore();
    const { token } = (await uninstallPlanRoute({ env, now: () => T }, tokens)).body as { token: string };
    removeStatus = 409;
    try {
      expect((await uninstallRoute({ env, now: () => T }, tokens, { token, wroteItDown: true })).status).toBe(409);
      expect(tokens.check(token, T.getTime())).toBe(true);
    } finally {
      removeStatus = 202;
    }
    expect((await uninstallRoute({ env, now: () => T }, tokens, { token, wroteItDown: true })).status).toBe(202);
    expect(tokens.check(token, T.getTime())).toBe(false);
  });
});
