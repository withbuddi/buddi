/**
 * The lock screen, end to end against a throwaway database: the PIN is kept
 * hashed, a locked session gets 423 for everything but the lock screen's own
 * calls, tries are limited for the installation, a session left idle past the
 * delay is locked by the server, a new browser session starts locked, a ticket
 * opens one, buddi's own clients are never covered, open streams are cut, and
 * removing the PIN from the command line opens everything.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { request } from 'node:http';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, ToolRegistry, appendEvent, createAction, createPool, ensureOwner, migrate, removeLockPin, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { QUESTION_ASKED } from './attention.js';
import { testDatabaseUrl } from '@buddi/core/testing';
import pngjs from 'pngjs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csrfCookieName, sessionCookieName } from './http.js';
import { LOCK_GRACE_MS, allowedWhileLocked } from './lock.js';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';
import { hostFetch } from '../__fixtures__/host-fetch.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_lock_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const T0 = new Date('2026-10-01T12:00:00Z');

suite('the lock screen', () => {
  let admin: Pool;
  let pool: Pool;
  let app: WebServer;
  let clock = T0;
  const advance = (ms: number): void => { clock = new Date(clock.getTime() + ms); };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    app = await startWebServer({
      pool,
      registry: new ToolRegistry(),
      catalog: { list: () => [], get: () => undefined } as unknown as AgentCatalog,
      ctx: { db: pool, ownerId: 'owner', now: () => clock, timezone: 'Europe/Paris' } as unknown as CoreToolContext,
      timezone: 'Europe/Paris',
      now: () => clock,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      openAccess: true,
      log: () => {},
      // The passphrase routes read the vault: an in-memory one, never the owner's keychain, and no supervisor.
      env: { ...process.env, BUDDI_VAULT: 'memory', BUDDI_SUPERVISOR_SOCKET: '' },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    clock = new Date(clock.getTime() + 60 * 60_000);
    await pool.query("delete from core.web_settings where key in ('lock', 'lock.pin')");
    await pool.query('delete from core.lock_background');
    await pool.query('truncate core.dashboard_sessions');
    // The service trusts what it read for two seconds; the clock moved an hour.
  });

  const base = (): string => `http://127.0.0.1:${app.port}`;

  /** A browser: its own cookie jar, its CSRF echoed on every write. */
  async function browser(headers: Record<string, string> = {}) {
    const res = await hostFetch(`${base()}/api/session`, { headers: { Connection: 'close', ...headers } });
    const pairs = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
    return jar(pairs, headers);
  }
  function jar(pairs: string[], extra: Record<string, string> = {}) {
    const csrf = pairs.find((p) => p.startsWith(`${csrfCookieName(app.port)}=`))?.split('=')[1] ?? '';
    const cookie = pairs.join('; ');
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await hostFetch(`${base()}${path}`, {
        method,
        headers: {
          Cookie: cookie,
          Connection: 'close',
          ...extra,
          ...(method === 'GET' ? {} : { Origin: base(), 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : null };
    };
    return {
      cookie,
      csrf,
      get: (path: string) => call('GET', path),
      post: (path: string, body: unknown = {}) => call('POST', path, body),
      put: (path: string, body: unknown) => call('PUT', path, body),
      del: (path: string) => call('DELETE', path),
    };
  }

  it('is off until a PIN is set: nothing locks, Lock now says so', async () => {
    const b = await browser();
    expect((await b.get('/api/lock')).body).toMatchObject({ pin: false, locked: false, delayMinutes: 5, background: 'earth' });
    expect((await b.post('/api/lock')).status).toBe(409);
    expect((await b.get('/api/overview')).status).toBe(200);
  });

  it('draws on Earth until the owner picks a background, and keeps the one they picked', async () => {
    const b = await browser();
    // Before Earth, every write carried the old default: that is not a pick.
    await pool.query(`insert into core.web_settings (key, value) values ('lock', '{"delayMinutes":15,"background":"field"}'::jsonb) on conflict (key) do update set value = excluded.value`);
    clock = new Date(clock.getTime() + 60_000);
    expect((await b.get('/api/lock')).body).toMatchObject({ delayMinutes: 15, background: 'earth' });
    expect((await b.put('/api/lock/settings', { delayMinutes: 60 })).body).toMatchObject({ delayMinutes: 60, background: 'earth' });
    // A pick stays, Buddi included, through later changes.
    expect((await b.put('/api/lock/settings', { background: 'field' })).body).toMatchObject({ background: 'field' });
    expect((await b.put('/api/lock/settings', { delayMinutes: 5 })).body).toMatchObject({ delayMinutes: 5, background: 'field' });
    // A colour picked before Earth existed stays too.
    await pool.query(`update core.web_settings set value = '{"delayMinutes":5,"background":"dusk"}'::jsonb where key = 'lock'`);
    clock = new Date(clock.getTime() + 60_000);
    expect((await b.get('/api/lock')).body).toMatchObject({ background: 'dusk' });
    expect((await b.put('/api/lock/settings', { background: 'nebula' })).status).toBe(400);
  });

  it('keeps only a scrypt hash of the PIN, and refuses one that is not four to eight digits', async () => {
    const b = await browser();
    expect((await b.put('/api/lock/pin', { pin: '12' })).status).toBe(400);
    expect((await b.put('/api/lock/pin', { pin: '12345678901' })).status).toBe(400);
    expect((await b.put('/api/lock/pin', { pin: 'abcd' })).status).toBe(400);
    const set = await b.put('/api/lock/pin', { pin: '2468' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ pin: true, locked: false });
    const { rows } = await pool.query("select value::text as v from core.web_settings where key = 'lock.pin'");
    expect(rows[0].v).toContain('scrypt$');
    expect(rows[0].v).not.toContain('2468');
  });

  it('answers a locked session 423 for everything but the lock screen, and opens with the PIN', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    const locked = await b.post('/api/lock');
    expect(locked.body).toMatchObject({ locked: true, reason: 'owner' });

    for (const path of ['/api/overview', '/api/widgets', '/api/chat/agents', '/api/notifications', '/api/conversations']) {
      const res = await b.get(path);
      expect(res.status, path).toBe(423);
      expect(res.body).toMatchObject({ locked: true });
    }
    expect((await b.post('/api/presence', { state: 'active' })).status).toBe(423);
    expect((await b.post('/api/lock/activity')).status).toBe(423);
    expect((await b.put('/api/lock/pin', { pin: '1111', current: '2468' })).status).toBe(423);

    expect((await b.get('/api/session')).status).toBe(200);
    expect((await b.get('/api/lock')).body).toMatchObject({ pin: true, locked: true });
    const screen = await b.get('/api/lock/screen');
    expect(screen.status).toBe(200);
    expect(screen.body).toMatchObject({ locked: true, timezone: 'Europe/Paris', owner: 'owner', approvals: 0, widgets: [] });
    expect(typeof screen.body!.needs).toBe('number');

    const open = await b.post('/api/lock/unlock', { pin: '2468' });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ locked: false });
    expect((await b.get('/api/overview')).status).toBe(200);
  });

  it('counts only what the owner can act on, as Home and the rail do, never what it says', async () => {
    const b = await browser();
    await pool.query('delete from core.owner_notifications');
    // The demo: an approval, an urgent decision, an agent's question, a mission report and two plain notify messages.
    await createAction(pool, { tool: 'demo.send', toolVersion: '1', agentId: 'postie', canonicalArgs: { to: 'ana' }, envelope: {}, preview: 'Send to ana', now: clock });
    await pool.query(
      `insert into core.sentinel_findings (key, sentinel_id, severity, title, detail, owner_line, agent_id)
       values ('lock.test:1', 'test.watcher', 'urgent', 'A payment to an unknown payee', 'brief', 'A payment of 1240 EUR is waiting', 'ledger')`,
    );
    await appendEvent(pool, QUESTION_ASKED, { agentId: 'tempo' });
    await pool.query(
      `insert into core.owner_notifications (kind, urgency, title, state, seen_at, action, created_at)
       values ('recap', 'now', 'a secret mission report', 'sent', null, null, $1),
              ('agent', 'now', '@scout: the parcel was delivered', 'sent', null, null, $1),
              ('agent', 'now', '@tempo: rain after four', 'shown', null, null, $1)`,
      [clock],
    );
    const overview = await b.get('/api/overview');
    expect(overview.body!.needsYou).toMatchObject({ approvals: 1, questions: 1, urgent: 1, asks: 0, total: 3 });
    expect((await b.get('/api/notifications?needs=1')).body!.notifications).toEqual([]);

    // A notify that carries an action is in Needs you, and on every count.
    await pool.query(
      `insert into core.owner_notifications (kind, urgency, title, state, action, created_at)
       values ('agent', 'now', '@ledger: charged twice', 'sent', 'Confirm with the bank?', $1)`,
      [clock],
    );
    const again = await b.get('/api/overview');
    expect(again.body!.needsYou).toMatchObject({ asks: 1, total: 4 });
    const listed = await b.get('/api/notifications?needs=1');
    expect(listed.body!.notifications.map((n: { title: string; needsOwner: boolean }) => [n.title, n.needsOwner])).toEqual([['@ledger: charged twice', true]]);
    const all = (await b.get('/api/notifications')).body!.notifications as Array<{ kind: string; needsOwner: boolean }>;
    expect(all.filter((n) => n.needsOwner)).toHaveLength(1);

    await b.put('/api/lock/pin', { pin: '2468' });
    await b.post('/api/lock');
    const screen = await b.get('/api/lock/screen');
    expect(screen.body).toMatchObject({ approvals: 1, needs: 3 });
    expect(screen.body!.approvals + screen.body!.needs).toBe(again.body!.needsYou.total);
    expect(JSON.stringify(screen.body)).not.toContain('secret');
    await b.post('/api/lock/unlock', { pin: '2468' });
    await pool.query("delete from core.sentinel_findings where key = 'lock.test:1'");
    await pool.query('update core.approvals set state = \'rejected\'');
  });

  it('limits tries for the installation: five wrong, then a wait that doubles', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    await b.post('/api/lock');
    for (let i = 1; i <= 4; i++) {
      const wrong = await b.post('/api/lock/unlock', { pin: '0000' });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toMatchObject({ triesLeft: 5 - i, waitUntil: null });
    }
    const fifth = await b.post('/api/lock/unlock', { pin: '0000' });
    expect(fifth.status).toBe(403);
    expect(fifth.body!.triesLeft).toBe(0);
    expect(Date.parse(fifth.body!.waitUntil) - clock.getTime()).toBe(30_000);
    // Even the right PIN waits; and a new session does not reset the count.
    expect((await b.post('/api/lock/unlock', { pin: '2468' })).status).toBe(429);
    const other = await browser();
    expect((await other.post('/api/lock/unlock', { pin: '2468' })).status).toBe(429);
    advance(31_000);
    const sixth = await b.post('/api/lock/unlock', { pin: '0000' });
    expect(Date.parse(sixth.body!.waitUntil) - clock.getTime()).toBe(60_000);
    advance(61_000);
    expect((await b.post('/api/lock/unlock', { pin: '2468' })).status).toBe(200);
    // A right PIN clears the count.
    expect((await b.get('/api/lock')).body).toMatchObject({ triesLeft: null, waitUntil: null });
  });

  it('starts a new browser session locked while a PIN is set, but not a ticket or buddi’s own client', async () => {
    const owner = await browser();
    await owner.put('/api/lock/pin', { pin: '2468' });

    const fresh = await browser();
    expect((await fresh.get('/api/lock')).body).toMatchObject({ locked: true, reason: 'start' });
    expect((await fresh.get('/api/overview')).status).toBe(423);

    // The header alone is no credential: a cookie-less request naming itself
    // `mcp` gets a browser's session, locked like any other.
    const claimed = await browser({ 'X-Buddi-Client': 'mcp' });
    expect((await claimed.get('/api/overview')).status).toBe(423);
    expect((await claimed.get('/api/lock')).body).toMatchObject({ locked: true, reason: 'start' });

    // `buddi mcp` signs in with a ticket from the installation token: its client is not covered.
    const mcpTicket = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN, clock))}`, { headers: { Connection: 'close', 'X-Buddi-Client': 'mcp' } });
    expect(mcpTicket.status).toBe(302);
    const mcp = jar(mcpTicket.headers.getSetCookie().map((c) => c.split(';')[0]!), { 'X-Buddi-Client': 'mcp' });
    expect((await mcp.get('/api/overview')).status).toBe(200);
    expect((await mcp.post('/api/lock')).status).toBe(409);

    // `buddi dashboard --unlock`: a ticket opens a session past the lock.
    const exchanged = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN, clock))}`, { headers: { Connection: 'close' } });
    expect(exchanged.status).toBe(302);
    const ticketed = jar(exchanged.headers.getSetCookie().map((c) => c.split(';')[0]!));
    expect(ticketed.cookie).toContain(sessionCookieName(app.port));
    expect((await ticketed.get('/api/overview')).status).toBe(200);
  });

  it('locks a session the server saw no use of for the delay, whatever the page says', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    await b.put('/api/lock/settings', { delayMinutes: 1 });
    // Polls are not use: only the page's activity report is.
    advance(50_000);
    expect((await b.get('/api/overview')).status).toBe(200);
    expect((await b.post('/api/lock/activity')).status).toBe(204);
    advance(60_000 + LOCK_GRACE_MS - 1_000);
    expect((await b.get('/api/overview')).status).toBe(200);
    advance(2_000);
    expect((await b.get('/api/overview')).status).toBe(423);
    const state = (await b.get('/api/lock')).body!;
    expect(state).toMatchObject({ locked: true, reason: 'idle' });

    // Never: no idle lock at all.
    await b.post('/api/lock/unlock', { pin: '2468' });
    await b.put('/api/lock/settings', { delayMinutes: null });
    advance(10 * 60 * 60_000);
    expect((await b.get('/api/overview')).status).toBe(200);
    expect((await b.put('/api/lock/settings', { delayMinutes: 7 })).status).toBe(400);
  });

  it('keeps a session opened by `--unlock` open when an old tab sharing the cookie claims it sat idle', async () => {
    const owner = await browser();
    await owner.put('/api/lock/pin', { pin: '2468' });
    await owner.put('/api/lock/settings', { delayMinutes: 1 });
    // The old tab has been open, unused, for most of the delay.
    advance(50_000);
    // `buddi dashboard --unlock` on 127.0.0.1: the browser now presents the ticket's session for every tab.
    const exchanged = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN, clock))}`, { headers: { Connection: 'close', Cookie: owner.cookie } });
    expect(exchanged.status).toBe(302);
    const ticketed = jar(exchanged.headers.getSetCookie().map((c) => c.split(';')[0]!));
    expect((await ticketed.get('/api/lock')).body).toMatchObject({ locked: false });
    // Ten seconds on, the old tab's own clock reaches the delay and asks for an idle lock on the shared cookie.
    advance(10_000);
    expect((await ticketed.post('/api/lock', { reason: 'idle', idleForMs: 60_000 })).body).toMatchObject({ locked: false });
    expect((await ticketed.post('/api/lock', { reason: 'idle' })).body).toMatchObject({ locked: false });
    expect((await ticketed.get('/api/overview')).status).toBe(200);
    // An honest idle claim still locks, and Lock now always does.
    advance(60_000);
    expect((await ticketed.post('/api/lock', { reason: 'idle' })).body).toMatchObject({ locked: true, reason: 'idle' });
    await ticketed.post('/api/lock/unlock', { pin: '2468' });
    expect((await ticketed.post('/api/lock', { reason: 'owner' })).body).toMatchObject({ locked: true, reason: 'owner' });
  });

  it('honours an idle claim when the activity report trailed the last use, as it always does', async () => {
    const owner = await browser();
    await owner.put('/api/lock/pin', { pin: '2468' });
    await owner.put('/api/lock/settings', { delayMinutes: 1 });
    // The owner's last use; the page reports it on its next tick past the 30 s throttle, 34 s later.
    advance(34_000);
    expect((await owner.post('/api/lock/activity')).status).toBe(204);
    // The page reaches the delay from the use itself, 26 s after the report: the claim holds.
    advance(26_000);
    expect((await owner.post('/api/lock', { reason: 'idle', idleForMs: 60_000 })).body).toMatchObject({ locked: true, reason: 'idle' });
    await owner.post('/api/lock/unlock', { pin: '2468' });
    // A page that does not say how long counts the delay, with the same allowance.
    expect((await owner.post('/api/lock/activity')).status).toBe(204);
    advance(30_000);
    expect((await owner.post('/api/lock', { reason: 'idle' })).body).toMatchObject({ locked: true, reason: 'idle' });
  });

  it('keeps a lock across a restart of the session store', async () => {
    const exchanged = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN, clock))}`, { headers: { Connection: 'close' } });
    const b = jar(exchanged.headers.getSetCookie().map((c) => c.split(';')[0]!));
    await b.put('/api/lock/pin', { pin: '2468' });
    await b.post('/api/lock');
    await new Promise((r) => setTimeout(r, 50));
    const { rows } = await pool.query('select locked_at, lock_reason, client from core.dashboard_sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lock_reason: 'owner', client: 'browser' });
    expect(rows[0].locked_at).not.toBeNull();
  });

  it('changes and removes the PIN only with the current one', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    expect((await b.put('/api/lock/pin', { pin: '1357' })).status).toBe(400);
    const wrong = await b.put('/api/lock/pin', { pin: '1357', current: '9999' });
    expect(wrong.status).toBe(403);
    expect(wrong.body!.error).toContain('current PIN');
    expect((await b.put('/api/lock/pin', { pin: '1357', current: '2468' })).status).toBe(200);
    expect((await b.post('/api/lock/pin/remove', { current: '2468' })).status).toBe(403);
    expect((await b.post('/api/lock/pin/remove', { current: '1357' })).body).toMatchObject({ pin: false });
  });

  it('reveals the backup passphrase behind the PIN, counted like an unlock try', async () => {
    const open = await browser();
    // No PIN: the signed-in session is all there is.
    expect((await open.post('/api/backups/passphrase/reveal', {})).body).toMatchObject({ passphrase: expect.any(String) });
    await open.put('/api/lock/pin', { pin: '2468' });
    const b = open;
    const plain = await b.get('/api/backups/passphrase');
    expect(plain.status).toBe(403);
    expect(plain.body).toMatchObject({ needsPin: true });
    expect((await b.post('/api/backups/passphrase/reveal', {})).status).toBe(403);
    const wrong = await b.post('/api/backups/passphrase/reveal', { pin: '9999' });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ triesLeft: expect.any(Number) });
    const right = await b.post('/api/backups/passphrase/reveal', { pin: '2468' });
    expect(right.status).toBe(200);
    expect(right.body!.passphrase.split(' ').length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the lock screen’s clock: Profile by default, picked formats, a second zone from a place or a town', async () => {
    const b = await browser();
    expect((await b.get('/api/lock')).body).toMatchObject({ clock: { time: 'profile', date: 'profile', zone: null } });
    expect((await b.get('/api/lock/screen')).body).toMatchObject({ clockView: { time: null, date: null, zone: null } });
    await pool.query(`update core.owner set time_format = '24h', date_format = 'long' where id = 'owner'`);
    expect((await b.get('/api/lock/screen')).body).toMatchObject({ clockView: { time: '24h', date: 'long', zone: null } });
    const town = await b.put('/api/lock/settings', { clock: { time: '12h', date: 'off', zone: { label: 'Tokyo', timezone: 'Asia/Tokyo' } } });
    expect(town.status).toBe(200);
    expect(town.body).toMatchObject({ clock: { time: '12h', date: 'off', zone: { label: 'Tokyo', timezone: 'Asia/Tokyo' } } });
    expect((await b.get('/api/lock/screen')).body).toMatchObject({ clockView: { time: '12h', date: 'off', zone: { label: 'Tokyo', timezone: 'Asia/Tokyo' } } });
    // A place of the owner's is read by id, so its zone follows a move.
    await pool.query(`insert into core.owner_places (id, label, place_name, latitude, longitude, timezone, position) values ('ben', 'Ben', 'Brooklyn, New York', 40.65, -73.95, 'America/New_York', 0) on conflict do nothing`);
    await b.put('/api/lock/settings', { clock: { time: 'profile', date: 'short', zone: { place: 'ben' } } });
    expect((await b.get('/api/lock/screen')).body).toMatchObject({ clockView: { time: '24h', date: 'short', zone: { label: 'Ben', timezone: 'America/New_York' } } });
    for (const clock of [{ time: '13h' }, { date: 'weekly' }, { zone: { label: 'Mars', timezone: 'Mars/Olympus' } }, 'big']) {
      expect((await b.put('/api/lock/settings', { clock })).status).toBe(400);
    }
    await b.put('/api/lock/settings', { clock: { time: 'profile', date: 'profile', zone: null } });
    await pool.query(`update core.owner set time_format = null, date_format = null where id = 'owner'`);
    await pool.query(`delete from core.owner_places where id = 'ben'`);
  });

  it('reads every time on the lock screen one way: the lock clock’s pick, else the Profile, else the browser’s', async () => {
    const b = await browser();
    await pool.query(`insert into core.owner_places (id, label, place_name, latitude, longitude, timezone, position) values ('ben', 'Ben', 'Brooklyn, New York', 40.65, -73.95, 'America/New_York', 0) on conflict do nothing`);
    // The World clock on the lock screen, on Profile: it reads the way the big clock does.
    expect((await b.put('/api/widgets/lock', { placements: [{ widget: 'buddi.clock', size: 'small', settings: {} }] })).status).toBe(200);
    const twelve = /^\d{1,2}:\d{2}\s?[AP]M$/;
    const twentyFour = /^\d{2}:\d{2}$/;
    const read = async (query = '') => {
      const body = (await b.get(`/api/lock/screen${query}`)).body!;
      return { time: body.clockView.time as string | null, widget: body.widgets[0]?.view.body.value as string };
    };
    // Profile on Auto: the browser's clock (hour=12) for the big clock and the widget alike.
    const auto = await read('?hour=12');
    expect(auto.time).toBe('12h');
    expect(auto.widget).toMatch(twelve);
    expect((await read('?hour=24')).time).toBe('24h');
    // Profile on 12-hour: the browser's taste no longer matters.
    await pool.query(`update core.owner set time_format = '12h' where id = 'owner'`);
    const profile = await read('?hour=24');
    expect(profile.time).toBe('12h');
    expect(profile.widget).toMatch(twelve);
    // 24-hour picked for the lock screen: the big clock and its widgets on Profile follow it, never a mix.
    await b.put('/api/lock/settings', { clock: { time: '24h', date: 'profile', zone: null } });
    const picked = await read();
    expect(picked.time).toBe('24h');
    expect(picked.widget).toMatch(twentyFour);
    await b.put('/api/lock/settings', { clock: { time: 'profile', date: 'profile', zone: null } });
    await b.put('/api/widgets/lock', { placements: [] });
    await pool.query(`update core.owner set time_format = null where id = 'owner'`);
    await pool.query(`delete from core.owner_places where id = 'ben'`);
  });

  it('opens every session when the PIN is removed from the command line', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    await b.post('/api/lock');
    expect((await b.get('/api/overview')).status).toBe(423);
    expect(await removeLockPin(pool)).toBe(true);
    // The service trusts its last read for two seconds of its clock.
    advance(3_000);
    expect((await b.get('/api/overview')).status).toBe(200);
    expect((await b.get('/api/lock')).body).toMatchObject({ pin: false, locked: false });
    expect(await removeLockPin(pool)).toBe(false);
  });

  it('closes a locked session’s open streams', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    const ended = new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: app.port, path: '/api/chat/attention/stream', headers: { Cookie: b.cookie } }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 300));
    await b.post('/api/lock');
    expect(await ended).toBe(200);
    // And a new one is refused while it stays locked.
    expect((await b.get('/api/chat/attention/stream')).status).toBe(423);
  }, 20_000);

  it('takes a picture for the background, re-encoded as a JPEG, served while locked', async () => {
    const b = await browser();
    await b.put('/api/lock/pin', { pin: '2468' });
    expect((await b.put('/api/lock/settings', { background: 'image' })).status).toBe(409);
    expect((await b.put('/api/lock/settings', { background: 'dusk' })).body).toMatchObject({ background: 'dusk' });

    const png = new pngjs.PNG({ width: 40, height: 30 });
    png.data.fill(200);
    const bytes = pngjs.PNG.sync.write(png);
    const boundary = 'x-lock-test';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: app.port, path: '/api/lock/background', method: 'POST',
        headers: { Cookie: b.cookie, Origin: base(), 'X-Buddi-CSRF': b.csrf, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(body);
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ background: 'image' });
    expect(uploaded.body.image).toMatch(/^\/api\/lock\/background\?v=[0-9a-f]{16}$/);

    await b.post('/api/lock');
    const picture = await hostFetch(`${base()}/api/lock/background`, { headers: { Cookie: b.cookie } });
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/jpeg');
    const jpeg = Buffer.from(await picture.arrayBuffer());
    expect(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);

    await b.post('/api/lock/unlock', { pin: '2468' });
    expect((await b.del('/api/lock/background')).body).toMatchObject({ background: 'earth', image: null });
  });

  it('fails closed when the PIN cannot be read: a locked session stays locked, a new one is refused', async () => {
    let failing = false;
    // The same database, but reading the PIN fails while `failing` is set.
    const flaky = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (text: unknown, params?: unknown[]) => {
            if (failing && Array.isArray(params) && params.includes('lock.pin')) return Promise.reject(new Error('connection terminated'));
            return (target.query as (...a: unknown[]) => unknown).call(target, text, params);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flakyApp = await startWebServer({
      pool: flaky,
      registry: new ToolRegistry(),
      catalog: { list: () => [], get: () => undefined } as unknown as AgentCatalog,
      ctx: { db: flaky, ownerId: 'owner', now: () => clock, timezone: 'Europe/Paris' } as unknown as CoreToolContext,
      timezone: 'Europe/Paris',
      now: () => clock,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      openAccess: true,
      log: () => {},
    });
    try {
      const at = `http://127.0.0.1:${flakyApp.port}`;
      const open = async () => {
        const res = await hostFetch(`${at}/api/session`, { headers: { Connection: 'close' } });
        return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ') };
      };
      const get = async (cookie: string, path: string) =>
        (await hostFetch(`${at}${path}`, { headers: { Cookie: cookie, Connection: 'close' } })).status;

      // Nothing known yet and the read fails: no session is minted unlocked.
      failing = true;
      const blind = await open();
      expect(blind.status).toBe(503);

      // A PIN, a session that starts locked; then the read fails: still locked.
      failing = false;
      const owner = await browser();
      await owner.put('/api/lock/pin', { pin: '2468' });
      const fresh = await open();
      expect(fresh.status).toBe(200);
      expect(await get(fresh.cookie, '/api/overview')).toBe(423);
      failing = true;
      advance(5_000);
      expect(await get(fresh.cookie, '/api/overview')).toBe(423);
      advance(5_000);
      expect(await get(fresh.cookie, '/api/overview')).toBe(423);
      const another = await open();
      expect(another.status).toBe(200);
      expect(await get(another.cookie, '/api/overview')).toBe(423);
    } finally {
      failing = false;
      await flakyApp.close();
    }
  });

  it('allows only the lock screen’s own calls while locked', () => {
    expect(allowedWhileLocked('GET', '/api/session')).toBe(true);
    expect(allowedWhileLocked('GET', '/api/lock/screen')).toBe(true);
    expect(allowedWhileLocked('POST', '/api/lock/unlock')).toBe(true);
    expect(allowedWhileLocked('POST', '/api/lock/activity')).toBe(false);
    expect(allowedWhileLocked('PUT', '/api/lock/pin')).toBe(false);
    expect(allowedWhileLocked('GET', '/api/overview')).toBe(false);
    expect(allowedWhileLocked('POST', '/api/lock/screen')).toBe(false);
    // The widget rows' logos draw on the lock screen; nothing else under plugins does.
    expect(allowedWhileLocked('GET', '/api/plugin-assets/news/lemonde.fr')).toBe(true);
    expect(allowedWhileLocked('PUT', '/api/plugin-assets/news/lemonde.fr')).toBe(false);
    expect(allowedWhileLocked('GET', '/api/plugin-assetsx')).toBe(false);
    expect(allowedWhileLocked('GET', '/api/plugins')).toBe(false);
  });
});
