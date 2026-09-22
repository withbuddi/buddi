/**
 * The draft editor's routes: `/api/email/threads` and `/api/email/drafts`.
 *
 * What matters here is not the SQL — the plugin's own suite owns that — but the
 * three sentences the routes are supposed to make true:
 *
 *  - the conversation list says which threads have a draft waiting, which is
 *    the pill the page draws;
 *  - a save is the *owner's* words: the draft comes back `edited`, `edited_by`
 *    is `owner`, and the artifact version has moved;
 *  - **Send does not send.** It answers with the id of a `pending` `email.send`
 *    action and nothing reaches SMTP, so the owner still approves it on the
 *    card like any other send.
 *
 * And, since these are writes on the dashboard, that each of them still needs
 * the session and the CSRF pair.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  getAction,
  migrate,
  runMigrations,
  ToolRegistry,
  type AgentCatalog,
  type ToolContext,
} from '@buddi/core';
import {
  createEmailManifest,
  FakeImapServer,
  FakeSmtpServer,
  createInboxPollSource,
  ensureGmailAccount,
  GMAIL_SECRET_NAME,
  fakeMessage,
} from '@buddi/tool-email';
import { testDatabaseUrl } from '@buddi/core/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_drafts_routes_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const NOW = new Date('2026-09-21T12:00:00Z');
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };

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

suite('the draft editor routes', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  let dataDir: string;
  let smtp: FakeSmtpServer;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  const cookies = new Map<string, string>();

  const send = async (
    method: string,
    routePath: string,
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
    const res = await fetch(`${base}${routePath}`, {
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

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-drafts-routes-'));
    process.env.BUDDI_DATA_DIR = dataDir;
    smtp = new FakeSmtpServer();
    const manifest = createEmailManifest({ send: smtp.factory(), env: ENV });
    await runMigrations(pool, [manifest]);
    await ensureOwner(pool, 'owner');
    registry = new ToolRegistry();
    registry.register(manifest);

    ctx = { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC', agentId: 'mail-triage' };
    web = await startWebServer({
      pool,
      registry,
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
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    delete process.env.BUDDI_DATA_DIR;
  });

  /** One ingested message and one agent-written draft answering it. */
  const seed = async (): Promise<{ threadId: string; draftId: string }> => {
    await pool.query(
      'truncate email.drafts, email.triage, email.messages, email.threads, email.folders, email.accounts cascade',
    );
    await pool.query('truncate core.actions cascade');
    await ensureGmailAccount(pool, ENV);
    const server = new FakeImapServer();
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<bank-1@bank.test>',
        from: 'alerts@bank.test',
        to: ['owner@example.test'],
        subject: 'Direct debit returned',
        bodyText: 'Your direct debit was returned unpaid.',
        flags: [],
        date: new Date('2026-09-20T08:00:00Z'),
      }),
    );
    await createInboxPollSource({ connect: server.factory(), env: ENV, backfill: 1_000 }).poll({
      db: pool,
      now: () => NOW,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async () => {},
    });
    const { rows } = await pool.query(`select id from email.messages order by uid`);
    const written = await registry.invoke(
      'email.draft_reply',
      { inReplyTo: String(rows[0].id), bodyText: 'I will cover it today.' },
      ctx,
    );
    if (!written.ok) throw new Error('could not seed a draft');
    const draft = written.output as { id: string; threadId: string };
    return { threadId: draft.threadId, draftId: draft.id };
  };

  beforeEach(async () => {
    await seed();
  });

  it('lists the conversations and says which one has a draft waiting', async () => {
    const res = await send('GET', '/api/email/threads');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: Array<{ subject: string; hasLiveDraft: boolean }> };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({
      subject: 'Direct debit returned',
      hasLiveDraft: true,
    });
  });

  it('draws the conversation with its messages and the drafts under them', async () => {
    const { threadId } = await seed();
    const res = await send('GET', `/api/email/threads/${threadId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: unknown[];
      drafts: Array<{ status: string; bodyText: string }>;
      older: unknown[];
    };
    expect(body.messages).toHaveLength(1);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toMatchObject({ status: 'draft', bodyText: 'I will cover it today.' });
    expect(body.older).toEqual([]);
  });

  it('makes a save the owner’s words, on a new artifact version', async () => {
    const { draftId } = await seed();
    const before = await send('GET', `/api/email/drafts/${draftId}`);
    const draftIdBack = ((await before.json()) as any).draft.id;
    const { rows: pre } = await pool.query(`select artifact_id from email.drafts where id = $1`, [draftId]);

    const res = await send('PUT', `/api/email/drafts/${draftId}`, {
      to: ['alerts@bank.test'],
      cc: [],
      bcc: [],
      subject: 'Re: Direct debit returned',
      bodyText: 'Actually, I have already paid it.',
      updatedAt: ((await (await send('GET', `/api/email/drafts/${draftId}`)).json()) as any).draft.updatedAt,
    });
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as any).draft;
    expect(saved).toMatchObject({ id: draftIdBack, status: 'edited', editedBy: 'owner', live: true });
    expect(saved.bodyText).toBe('Actually, I have already paid it.');

    const { rows: post } = await pool.query(`select artifact_id from email.drafts where id = $1`, [draftId]);
    expect(String(post[0].artifact_id)).not.toBe(String(pre[0].artifact_id));
  });

  it('refuses a save that carries no version at all', async () => {
    const { draftId } = await seed();
    /*
     * An optional precondition is not one. A client that omits it — an old
     * bundle, a hand-made request, a future caller that forgot — would
     * otherwise get the unguarded write back, and the guard would protect only
     * the careful.
     */
    for (const body of [
      { bodyText: 'No version at all.' },
      { bodyText: 'Not a timestamp.', updatedAt: 'yesterday' },
      { bodyText: 'Null.', updatedAt: null },
    ]) {
      const res = await send('PUT', `/api/email/drafts/${draftId}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/`updatedAt`/);
    }
    const { rows } = await pool.query(`select body_text from email.drafts where id = $1`, [draftId]);
    expect(rows[0].body_text).toBe('I will cover it today.');
  });

  it('refuses a save with no recipient rather than storing an unsendable draft', async () => {
    const { draftId } = await seed();
    const loaded = ((await (await send('GET', `/api/email/drafts/${draftId}`)).json()) as any).draft;
    const res = await send('PUT', `/api/email/drafts/${draftId}`, { to: [], updatedAt: loaded.updatedAt });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/recipient/i);
  });

  it('discards a draft, keeps the row, and refuses to discard it twice', async () => {
    const { draftId, threadId } = await seed();
    const res = await send('POST', `/api/email/drafts/${draftId}/discard`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).draft).toMatchObject({ status: 'discarded', live: false });

    const again = await send('POST', `/api/email/drafts/${draftId}/discard`, {});
    expect(again.status).toBe(409);

    // It moves to "Older drafts": still readable, no longer waiting.
    const thread = (await (await send('GET', `/api/email/threads/${threadId}`)).json()) as any;
    expect(thread.drafts).toEqual([]);
    expect(thread.older).toHaveLength(1);
    expect(thread.thread.hasLiveDraft).toBe(false);
  });

  it('Send proposes: a pending action, and nothing on the wire', async () => {
    const { draftId } = await seed();
    const before = smtp.sent.length;
    const res = await send('POST', `/api/email/drafts/${draftId}/send`, {});
    expect(res.status).toBe(200);
    const { actionId } = (await res.json()) as { actionId: string };
    expect(actionId).toBeTruthy();
    const action = await getAction(pool, actionId);
    expect(action?.tool).toBe('email.send');
    expect(action?.state).toBe('pending');
    // The identity control is on the action, so the card can draw it. One
    // address here, so nothing is offered — a select with one option is a fact.
    expect(action?.choices).toEqual([]);
    expect(smtp.sent).toHaveLength(before);
  });

  it('refuses to propose a send for a draft that has ended', async () => {
    const { draftId } = await seed();
    await send('POST', `/api/email/drafts/${draftId}/discard`, {});
    const res = await send('POST', `/api/email/drafts/${draftId}/send`, {});
    expect(res.status).toBe(409);
  });

  it('refuses a save made against a version that has since moved, and says what is there', async () => {
    const { draftId } = await seed();
    const loaded = ((await (await send('GET', `/api/email/drafts/${draftId}`)).json()) as any).draft;

    // Somebody else rewrote it while the editor was open.
    await pool.query(
      `update email.drafts set body_text = 'Rewritten elsewhere.', updated_at = $2 where id = $1`,
      [draftId, new Date(NOW.getTime() + 1000)],
    );

    const res = await send('PUT', `/api/email/drafts/${draftId}`, {
      to: ['alerts@bank.test'],
      cc: [],
      bcc: [],
      subject: 'Re: Direct debit returned',
      bodyText: 'Stale text from a page left open.',
      updatedAt: loaded.updatedAt,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/changed while you had it open/i);
    // The answer carries what is actually stored, so the editor redraws from
    // it rather than asking again and guessing.
    expect(body.draft.bodyText).toBe('Rewritten elsewhere.');

    const { rows } = await pool.query(`select body_text from email.drafts where id = $1`, [draftId]);
    expect(rows[0].body_text).toBe('Rewritten elsewhere.');
  });

  it('refuses every act on a draft a dispatch is holding, and says why', async () => {
    const { draftId, threadId } = await seed();
    await pool.query(`update email.drafts set sent_action_id = $2 where id = $1`, [
      draftId,
      '77777777-7777-4777-8777-777777777777',
    ]);

    // The page has to be able to see it: an editable-looking draft that may
    // already be on the wire is how the same letter gets sent twice.
    const thread = (await (await send('GET', `/api/email/threads/${threadId}`)).json()) as any;
    expect(thread.drafts[0]).toMatchObject({ live: false, unresolved: true });

    expect(
      (
        await send('PUT', `/api/email/drafts/${draftId}`, {
          bodyText: 'nope',
          updatedAt: new Date(NOW).toISOString(),
        })
      ).status,
    ).toBe(409);
    expect((await send('POST', `/api/email/drafts/${draftId}/discard`, {})).status).toBe(409);
    const sendAgain = await send('POST', `/api/email/drafts/${draftId}/send`, {});
    expect(sendAgain.status).toBe(409);
    expect(((await sendAgain.json()) as any).error).toMatch(/never confirmed/i);
  });

  it('ships snippets with the thread and the body only when a message is opened', async () => {
    const { threadId } = await seed();
    const thread = (await (await send('GET', `/api/email/threads/${threadId}`)).json()) as any;
    // Twenty full bodies for a list of one-line rows is a page weight nobody
    // reads; the list carries what it draws.
    expect(thread.messages[0].snippet).toBeTruthy();
    expect(thread.messages[0].bodyText).toBeUndefined();

    const one = await send('GET', `/api/email/messages/${thread.messages[0].id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as any).message).toMatchObject({
      from: 'alerts@bank.test',
      bodyText: 'Your direct debit was returned unpaid.',
      purged: false,
    });
    expect((await send('GET', '/api/email/messages/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('measures the body cap in bytes, not in characters', async () => {
    const { draftId } = await seed();
    // 20k characters of three-byte text: well under a 32k character cap and
    // well over a 32k byte one. The owner should read the sentence about
    // drafts, not the one about request sizes.
    const long = '\u4e2d'.repeat(20_000);
    const loaded = ((await (await send('GET', `/api/email/drafts/${draftId}`)).json()) as any).draft;
    const res = await send('PUT', `/api/email/drafts/${draftId}`, {
      to: ['alerts@bank.test'],
      cc: [],
      bcc: [],
      subject: 'Long',
      bodyText: long,
      updatedAt: loaded.updatedAt,
    });
    expect([413, 400]).toContain(res.status);
    expect(((await res.json()) as any).error).toMatch(/too long to keep as a draft|body/i);
  });

  it('refuses every new route without a session at all', async () => {
    const { draftId, threadId } = await seed();
    /*
     * A server with the loopback shortcut off. The suite's own server mints a
     * `local` session for anything arriving on 127.0.0.1 — the binding is the
     * credential there — so the unauthenticated case can only be asked of a
     * server that is not open, which is what a remote one is.
     */
    const gated = await startWebServer({
      pool,
      registry,
      catalog: emptyCatalog(),
      ctx,
      timezone: 'UTC',
      now: () => NOW,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      openAccess: false,
      log: () => {},
    });
    try {
      const root = `http://127.0.0.1:${gated.port}`;
      for (const [method, routePath] of [
        ['GET', '/api/email/threads'],
        ['GET', `/api/email/threads/${threadId}`],
        ['GET', `/api/email/drafts/${draftId}`],
        ['PUT', `/api/email/drafts/${draftId}`],
        ['POST', `/api/email/drafts/${draftId}/discard`],
        ['POST', `/api/email/drafts/${draftId}/send`],
      ] as const) {
        const res = await fetch(`${root}${routePath}`, {
          method,
          redirect: 'manual',
          headers: { 'content-type': 'application/json', origin: root },
          ...(method === 'GET' ? {} : { body: '{}' }),
        });
        expect(res.status, routePath).toBe(401);
      }
    } finally {
      await gated.close();
    }
  });

  it('is behind the same session and CSRF gate as every other write', async () => {
    const { draftId } = await seed();
    for (const [method, routePath] of [
      ['PUT', `/api/email/drafts/${draftId}`],
      ['POST', `/api/email/drafts/${draftId}/discard`],
      ['POST', `/api/email/drafts/${draftId}/send`],
    ] as const) {
      expect((await send(method, routePath, {}, { csrf: null })).status).toBe(403);
      expect((await send(method, routePath, {}, { origin: 'https://elsewhere.test' })).status).toBe(403);
    }
    // Still a live draft: none of those refusals changed anything.
    const { rows } = await pool.query(`select status from email.drafts where id = $1`, [draftId]);
    expect(rows[0].status).toBe('draft');
  });
});
