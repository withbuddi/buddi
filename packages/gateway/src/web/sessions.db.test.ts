/**
 * Dashboard sessions in `core.dashboard_sessions`, against a throwaway
 * database: a restart (a new `SessionStore`, or a new server, over the same
 * table) keeps the owner signed in, on exactly the terms the in-memory store
 * kept, and the table only ever holds hashes.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, ToolRegistry, createPool, ensureOwner, migrate, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csrfCookieName, sessionCookieName } from './http.js';
import { startWebServer, type WebServer } from './server.js';
import { SessionStore, csrfFor, sessionIdHash, type SessionDb } from './sessions.js';
import { mintTicket } from './token.js';
import { hostFetch } from '../__fixtures__/host-fetch.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_sessions_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const T0 = new Date('2026-09-30T10:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

suite('dashboard sessions in the database', () => {
  let admin: Pool;
  let pool: Pool;
  const quiet = { log: () => {} };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.dashboard_sessions');
  });

  const rows = async () => (await pool.query('select * from core.dashboard_sessions')).rows as Array<Record<string, unknown>>;
  /** A pool that counts the writes made through it. */
  const counting = () => {
    const seen: string[] = [];
    const db: SessionDb = { query: (sql, params) => { seen.push(sql.trim().split(/\s+/)[0]!.toLowerCase()); return pool.query(sql, params as unknown[]); } };
    return { db, seen };
  };

  it('keeps a session across a restart, with the same CSRF value, and stores only hashes', async () => {
    const before = new SessionStore({}, undefined, { db: pool, ...quiet });
    const session = before.create('remote', T0, { via: 'ticket' });
    await before.flush();

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id_hash).toBe(sessionIdHash(session.id));
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(session.id);
    expect(dump).not.toContain(session.csrf);
    // The whole table, read as text, never holds the cookie's value.
    const { rows: text } = await pool.query(`select string_agg(t::text, '') as all from core.dashboard_sessions t`);
    expect(String(text[0]!.all)).not.toContain(session.id);

    const after = new SessionStore({}, undefined, { db: pool, ...quiet });
    const back = await after.resolve(session.id, 'remote', at(60_000));
    expect(back?.id).toBe(session.id);
    expect(back?.csrf).toBe(session.csrf);
    expect(back?.csrf).toBe(csrfFor(session.id));
    expect(SessionStore.csrfMatches(back!, session.csrf)).toBe(true);
    expect(back?.via).toBe('ticket');
    // Scope still has to match, and refusing it does not destroy it.
    expect(await new SessionStore({}, undefined, { db: pool, ...quiet }).resolve(session.id, 'local', at(60_000))).toBeUndefined();
    expect(await rows()).toHaveLength(1);
    // A cookie that never existed is a miss.
    expect(await after.resolve('not-a-session', 'remote', at(60_000))).toBeUndefined();
  });

  it('re-issues the cookie on the first response after a restart', async () => {
    const before = new SessionStore({ local: 10_000 }, undefined, { db: pool, ...quiet });
    const session = before.create('local', T0);
    await before.flush();
    const after = new SessionStore({ local: 10_000 }, undefined, { db: pool, ...quiet });
    const back = (await after.resolve(session.id, 'local', at(6_000)))!;
    expect(after.renewCookie(back, at(6_000))).toBe(true);
    expect(after.renewCookie(back, at(6_100))).toBe(false);
  });

  it('still lapses an idle session across a restart, and deletes its row', async () => {
    const before = new SessionStore({ local: 1_000 }, undefined, { db: pool, ...quiet });
    const session = before.create('local', T0);
    await before.flush();
    const after = new SessionStore({ local: 1_000 }, undefined, { db: pool, ...quiet });
    expect(await after.resolve(session.id, 'local', at(2_000))).toBeUndefined();
    await after.flush();
    expect(await rows()).toHaveLength(0);
  });

  it('carries the sliding renewal across a restart, writing it back sparingly', async () => {
    const { db, seen } = counting();
    const before = new SessionStore({ local: 10_000 }, undefined, { db, ...quiet });
    const session = before.create('local', T0);
    await before.flush();
    seen.length = 0;
    // A hundred requests in the first 900ms: not one write.
    for (let i = 1; i <= 100; i += 1) expect(before.get(session.id, 'local', at(i * 9))).toBeDefined();
    await before.flush();
    expect(seen.filter((s) => s === 'update')).toHaveLength(0);
    // Used every 800ms: written back at most every second (a tenth of the lifetime).
    for (let t = 800; t <= 4_000; t += 800) before.get(session.id, 'local', at(t));
    await before.flush();
    expect(seen.filter((s) => s === 'update')).toHaveLength(2); // at 1600 and 3200

    // Past the unslid edge (10s) the restarted store still honours it...
    const after = new SessionStore({ local: 10_000 }, undefined, { db: pool, ...quiet });
    expect(await after.resolve(session.id, 'local', at(12_000))).toBeDefined();
    // ...and a store restarted once that written edge (3.2s + 10s) has passed does not.
    const late = new SessionStore({ local: 10_000 }, undefined, { db: pool, ...quiet });
    await pool.query('update core.dashboard_sessions set expires_at = $1', [at(13_200)]);
    expect(await late.resolve(session.id, 'local', at(13_300))).toBeUndefined();
  });

  it('holds a Tailscale session to its absolute edge across a restart', async () => {
    const before = new SessionStore({ remote: 3_000 }, 5_000, { db: pool, ...quiet });
    const session = before.create('remote', T0, { via: 'tailscale', tailscaleLogin: 'owner@example.com', tailscaleAddress: '100.101.102.103', tailscaleName: 'The Owner' });
    for (let t = 400; t <= 4_800; t += 400) expect(before.get(session.id, 'remote', at(t))).toBeDefined();
    await before.flush();
    const after = new SessionStore({ remote: 3_000 }, 5_000, { db: pool, ...quiet });
    const back = await after.resolve(session.id, 'remote', at(4_900));
    expect(back?.tailscaleLogin).toBe('owner@example.com');
    expect(back?.tailscaleAddress).toBe('100.101.102.103');
    expect(back?.absoluteExpiresAt?.getTime()).toBe(at(5_000).getTime());
    const capped = new SessionStore({ remote: 3_000 }, 5_000, { db: pool, ...quiet });
    expect(await capped.resolve(session.id, 'remote', at(5_000))).toBeUndefined();
  });

  it('revokes in the table: destroy, and forget for rows this process never saw', async () => {
    const store = new SessionStore({}, undefined, { db: pool, ...quiet });
    const doomed = store.create('local', T0);
    const ticket = store.create('remote', T0, { via: 'ticket' });
    const tailnet = store.create('remote', T0, { via: 'tailscale', tailscaleLogin: 'owner@example.com' });
    await store.flush();

    await store.destroy(doomed.id);
    expect((await rows()).map((r) => r.id_hash)).not.toContain(sessionIdHash(doomed.id));
    expect(await new SessionStore({}, undefined, { db: pool, ...quiet }).resolve(doomed.id, 'local', at(1))).toBeUndefined();

    // A fresh process (nothing cached) turning Tailscale access off.
    const fresh = new SessionStore({}, undefined, { db: pool, ...quiet });
    const offered: Array<string | undefined> = [];
    expect(await fresh.forget((s) => { offered.push(s.id); return s.via === 'tailscale'; })).toBe(1);
    expect(offered.every((id) => id === undefined)).toBe(true);
    const left = (await rows()).map((r) => r.id_hash);
    expect(left).toEqual([sessionIdHash(ticket.id)]);
    // The process that did have it cached cannot keep using it either.
    await store.forget((s) => s.via === 'tailscale');
    expect(store.get(tailnet.id, 'remote', at(1))).toBeUndefined();
  });

  it('does not let a read in flight bring back a session being destroyed', async () => {
    const before = new SessionStore({}, undefined, { db: pool, ...quiet });
    const session = before.create('local', T0);
    await before.flush();
    const after = new SessionStore({}, undefined, { db: pool, ...quiet });
    const reading = after.resolve(session.id, 'local', at(1));
    const destroying = after.destroy(session.id);
    await Promise.all([reading, destroying]);
    expect(await after.resolve(session.id, 'local', at(2))).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it('keeps nothing for the open loopback gate, and nothing for a store without a database', async () => {
    const store = new SessionStore({}, undefined, { db: pool, ...quiet });
    store.create('local', T0, undefined, { persist: false });
    await store.flush();
    expect(await rows()).toHaveLength(0);
    // A session from before the upgrade lived in memory only: it ends, as it always did.
    const memoryOnly = new SessionStore();
    const old = memoryOnly.create('local', T0);
    expect(await new SessionStore({}, undefined, { db: pool, ...quiet }).resolve(old.id, 'local', at(1))).toBeUndefined();
  });

  it('sweeps expired rows', async () => {
    const store = new SessionStore({ local: 1_000 }, undefined, { db: pool, ...quiet });
    store.create('local', T0);
    await store.flush();
    // The next sweep is due ten minutes on; the row above is long gone by then.
    store.create('local', at(11 * 60_000));
    await store.flush();
    expect(await rows()).toHaveLength(1);
  });

  describe('through the server', () => {
    const servers: WebServer[] = [];
    afterAll(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

    const start = async (openAccess: boolean): Promise<WebServer> => {
      const app = await startWebServer({
        pool,
        registry: new ToolRegistry(),
        catalog: { list: () => [], get: () => undefined } as unknown as AgentCatalog,
        ctx: { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as unknown as CoreToolContext,
        timezone: 'UTC',
        now: () => new Date(),
        config: { enabled: true, host: '127.0.0.1', port: 0 },
        token: TOKEN,
        openAccess,
        log: () => {},
      });
      servers.push(app);
      return app;
    };

    it('signs the owner in once and keeps them signed in across a restart, CSRF pair included', async () => {
      const first = await start(false);
      const port = first.port;
      const res = await fetch(`http://127.0.0.1:${port}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const pairs = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
      const sessionPair = pairs.find((p) => p.startsWith(`${sessionCookieName(port)}=`))!;
      const csrf = pairs.find((p) => p.startsWith(`${csrfCookieName(port)}=`))!.split('=')[1]!;
      const id = sessionPair.slice(sessionPair.indexOf('=') + 1);
      expect((await rows()).map((r) => r.id_hash)).toEqual([sessionIdHash(id)]);
      await first.close();

      // The restarted gateway: a new server, a new store, the same table — and
      // the same port, since cookies are named after it.
      const second = await startWebServer({
        pool,
        registry: new ToolRegistry(),
        catalog: { list: () => [], get: () => undefined } as unknown as AgentCatalog,
        ctx: { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as unknown as CoreToolContext,
        timezone: 'UTC',
        now: () => new Date(),
        config: { enabled: true, host: '127.0.0.1', port },
        token: TOKEN,
        openAccess: false,
        log: () => {},
      });
      servers.push(second);
      // A fresh connection: the old server's keep-alive socket is gone with it.
      const headers = { Cookie: pairs.join('; '), Connection: 'close' };
      const session = await hostFetch(`http://127.0.0.1:${port}/api/session`, { headers });
      expect(session.status).toBe(200);
      // A write with the CSRF pair minted before the restart is still accepted.
      const write = await hostFetch(`http://127.0.0.1:${port}/api/pause`, {
        method: 'POST',
        headers: { ...headers, Origin: `http://127.0.0.1:${port}`, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: false }),
      });
      expect(write.status).not.toBe(403);
      expect(write.status).not.toBe(401);
    });

    it('keeps the open loopback gate as it was: a session for free, nothing stored', async () => {
      const app = await start(true);
      const res = await fetch(`http://127.0.0.1:${app.port}/api/session`);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${sessionCookieName(app.port)}=`))).toBe(true);
      expect(await rows()).toHaveLength(0);
    });
  });
});
