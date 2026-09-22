/**
 * The mail-policy routes: `GET`, `POST` and `DELETE /api/email/policies`, and
 * `POST /api/email/policies/bulk`.
 *
 * The rules live in the email plugin and are tested there. What is asserted
 * here is that the routes apply them — the same refusals, in the same words —
 * that the reply is always the pair of lists the page redraws from, that
 * keeping a proposal and writing a rule are the same POST, that a write still
 * needs the session and the CSRF pair, and that DELETE revokes rather than
 * deletes.
 *
 * Skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  migrate,
  runMigrations,
  ToolRegistry,
  type AgentCatalog,
  type ToolContext,
} from '@buddi/core';
import { createPolicy, manifest as emailManifest, type PolicyView } from '@buddi/tool-email';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_routes_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const NOW = new Date('2026-09-21T12:00:00Z');

const emptyCatalog = (): AgentCatalog =>
  ({
    get: () => undefined,
    byHandle: () => undefined,
    list: () => [],
    agentsWithRole: () => [],
    agentForRole: () => ({ ok: false as const, problem: { code: 'no-agent-for-role' as const, role: 'x', message: 'none' } }),
    defaultAgent: () => undefined,
    resolve: () => undefined,
  }) as unknown as AgentCatalog;

interface PoliciesBody {
  applied: PolicyView[];
  proposed: PolicyView[];
  error?: string;
}

suite('the mail policy routes', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  const cookies = new Map<string, string>();

  const send = async (
    method: string,
    path: string,
    body?: unknown,
    opts: { csrf?: string | null; origin?: string | null } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const jar = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar !== '') headers.cookie = jar;
    const csrf = opts.csrf === undefined ? (cookies.get('buddi_csrf') ?? '') : opts.csrf;
    if (csrf !== null) headers['x-buddi-csrf'] = csrf;
    const origin = opts.origin === undefined ? base : opts.origin;
    if (origin !== null) headers.origin = origin;
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
    return res;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await runMigrations(pool, [emailManifest]);
    await ensureOwner(pool, 'owner');
    const ctx: ToolContext = { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' };
    web = await startWebServer({
      pool,
      registry: new ToolRegistry(),
      catalog: emptyCatalog(),
      ctx,
      timezone: 'UTC',
      now: () => NOW,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      log: () => {},
    });
    base = `http://127.0.0.1:${web.port}`;
    const signed = await send('GET', `/?t=${encodeURIComponent(mintTicket(TOKEN))}`);
    expect(signed.status).toBe(302);
  }, 60_000);

  afterAll(async () => {
    await web?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate email.events, email.policies cascade');
  });

  it('answers with two empty lists when nothing has been decided', async () => {
    const res = await send('GET', '/api/email/policies');
    expect(res.status).toBe(200);
    // `threads` is the list the "one conversation" rule is picked from; with
    // no mail ingested there is nothing to pick.
    expect(await res.json()).toEqual({ applied: [], proposed: [], threads: [] });
  });

  it('refuses a rule that says nothing about which mailbox it is for', async () => {
    // A rule with no account decides for every account (`gate.ts`), and that
    // has to be a choice: the form's "for every mailbox" box, not a blank.
    const res = await send('POST', '/api/email/policies', {
      scope: 'sender',
      matcher: 'news@shop.test',
      action: 'ignore',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as PoliciesBody).error).toMatch(/which mailbox/i);
    const { rows } = await pool.query(`select count(*)::int as n from email.policies`);
    expect(rows[0].n).toBe(0);
  });

  it('writes a rule for one named mailbox, and refuses one that is not the owner’s', async () => {
    const { rows } = await pool.query(
      `insert into email.accounts
         (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
       values ('owner@work.test', 'imap.work.test', 993, 'smtp.work.test', 465,
               'app-password', 'EMAIL_OWNER_WORK_TEST_00000001', 'page')
       on conflict (address) do update set imap_host = excluded.imap_host
       returning id`,
    );
    const accountId = String(rows[0].id);

    const stranger = await send('POST', '/api/email/policies', {
      scope: 'sender',
      matcher: 'news@shop.test',
      action: 'ignore',
      accountId: '00000000-0000-0000-0000-000000000000',
    });
    expect(stranger.status).toBe(400);

    const res = await send('POST', '/api/email/policies', {
      scope: 'sender',
      matcher: 'news@shop.test',
      action: 'ignore',
      accountId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PoliciesBody;
    expect(body.applied[0]).toMatchObject({ accountId, matcher: 'news@shop.test' });
  });

  it('writes a rule and answers with both lists', async () => {
    const res = await send('POST', '/api/email/policies', {
      scope: 'sender',
      matcher: 'News <News@Shop.test>',
      action: 'ignore',
      allAccounts: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PoliciesBody;
    expect(body.proposed).toEqual([]);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]).toMatchObject({
      scope: 'sender',
      matcher: 'news@shop.test',
      action: 'ignore',
      origin: 'owner',
      runsSaved: 0,
    });
  });

  it('refuses archive and label in the words the tool uses', async () => {
    const res = await send('POST', '/api/email/policies', {
      scope: 'sender',
      matcher: 'a@b.test',
      action: 'archive',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as PoliciesBody).error).toMatch(/^not yet/);
  });

  it('refuses an unknown action and a matcher that is not one', async () => {
    expect((await send('POST', '/api/email/policies', { scope: 'sender', matcher: 'a@b.test', action: 'explode' })).status).toBe(400);
    expect((await send('POST', '/api/email/policies', { scope: 'domain', matcher: 'localhost', action: 'ignore' })).status).toBe(400);
    expect((await send('POST', '/api/email/policies', { scope: 'nowhere', matcher: 'a@b.test', action: 'ignore' })).status).toBe(400);
  });

  it('keeps a proposal, which moves it from one list to the other', async () => {
    const proposed = await createPolicy(
      pool,
      { scope: 'sender', matcher: 'maybe@shop.test', action: 'ignore', origin: 'learned', proposed: true },
      NOW,
    );
    const before = (await (await send('GET', '/api/email/policies')).json()) as PoliciesBody;
    expect(before.applied).toHaveLength(0);
    expect(before.proposed).toHaveLength(1);

    const res = await send('POST', '/api/email/policies', { keep: proposed.id });
    expect(res.status).toBe(200);
    const after = (await res.json()) as PoliciesBody;
    expect(after.proposed).toHaveLength(0);
    expect(after.applied.map((p) => p.id)).toEqual([proposed.id]);
  });

  it('revokes with DELETE, and keeps the row', async () => {
    const policy = await createPolicy(
      pool,
      { scope: 'sender', matcher: 'news@shop.test', action: 'ignore', origin: 'owner' },
      NOW,
    );
    const res = await send('DELETE', `/api/email/policies/${policy.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PoliciesBody).applied).toEqual([]);

    const { rows } = await pool.query(`select revoked_at from email.policies where id = $1`, [policy.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('answers 404 for a policy that is not there', async () => {
    const res = await send('DELETE', '/api/email/policies/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect((await send('POST', '/api/email/policies', { keep: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);
  });

  /*
   * Bulk keep and revoke, over HTTP.
   *
   * The selection is a list of ids, and the route applies exactly those — the
   * one assertion worth making at this level, because the row it must not
   * touch is a real row in a real table rather than a mock that would have
   * been asked politely.
   */
  it('keeps and revokes exactly the ids the page sent, and nothing beside them', async () => {
    const ids: string[] = [];
    for (const matcher of ['one@shop.test', 'two@shop.test', 'three@shop.test']) {
      const made = await createPolicy(
        pool,
        { scope: 'sender', matcher, action: 'ignore', origin: 'learned', proposed: true },
        NOW,
      );
      ids.push(made.id);
    }

    const kept = await send('POST', '/api/email/policies/bulk', { action: 'keep', ids: [ids[0], ids[2]] });
    expect(kept.status).toBe(200);
    const afterKeep = (await kept.json()) as PoliciesBody & { kept: number; missing: number };
    expect(afterKeep).toMatchObject({ kept: 2, revoked: 0, missing: 0 });
    expect(afterKeep.applied.map((p) => p.matcher).sort()).toEqual(['one@shop.test', 'three@shop.test']);
    // The one that was not in the selection is still only a proposal.
    expect(afterKeep.proposed.map((p) => p.id)).toEqual([ids[1]]);

    const gone = await send('POST', '/api/email/policies/bulk', { action: 'revoke', ids: [ids[0]] });
    expect(gone.status).toBe(200);
    const afterRevoke = (await gone.json()) as PoliciesBody & { revoked: number };
    expect(afterRevoke).toMatchObject({ revoked: 1 });
    expect(afterRevoke.applied.map((p) => p.id)).toEqual([ids[2]]);

    const { rows } = await pool.query(
      `select id, revoked_at, proposed from email.policies order by matcher`,
    );
    // Three rows still, and only the one that was named is revoked.
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.revoked_at !== null).map((r) => String(r.id))).toEqual([ids[0]]);
  });

  it('refuses a bulk body that is not a selection, and one without the CSRF pair', async () => {
    const made = await createPolicy(
      pool,
      { scope: 'sender', matcher: 'news@shop.test', action: 'ignore', origin: 'learned', proposed: true },
      NOW,
    );
    expect((await send('POST', '/api/email/policies/bulk', { action: 'burn', ids: [made.id] })).status).toBe(400);
    expect((await send('POST', '/api/email/policies/bulk', { action: 'keep', ids: 'all' })).status).toBe(400);
    expect((await send('POST', '/api/email/policies/bulk', { action: 'keep', ids: ['nope'] })).status).toBe(400);
    expect(
      (await send('POST', '/api/email/policies/bulk', { action: 'keep', ids: [made.id] }, { csrf: null })).status,
    ).toBe(403);

    const { rows } = await pool.query(`select proposed from email.policies where id = $1`, [made.id]);
    expect(rows[0].proposed).toBe(true);
  });

  it('refuses a write without the CSRF pair, and one from another origin', async () => {
    const noCsrf = await send('POST', '/api/email/policies', { scope: 'sender', matcher: 'a@b.test', action: 'ignore' }, { csrf: null });
    expect(noCsrf.status).toBe(403);
    const elsewhere = await send('POST', '/api/email/policies', { scope: 'sender', matcher: 'a@b.test', action: 'ignore' }, { origin: 'https://evil.test' });
    expect(elsewhere.status).toBe(403);

    const { rows } = await pool.query(`select count(*)::int as n from email.policies`);
    expect(rows[0].n).toBe(0);
  });
});
