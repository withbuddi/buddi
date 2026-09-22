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
    const wasArtifact = ((await before.json()) as any).draft.id;
    const { rows: pre } = await pool.query(`select artifact_id from email.drafts where id = $1`, [draftId]);

    const res = await send('PUT', `/api/email/drafts/${draftId}`, {
      to: ['alerts@bank.test'],
      cc: [],
      bcc: [],
      subject: 'Re: Direct debit returned',
      bodyText: 'Actually, I have already paid it.',
    });
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as any).draft;
    expect(saved).toMatchObject({ id: wasArtifact, status: 'edited', editedBy: 'owner', live: true });
    expect(saved.bodyText).toBe('Actually, I have already paid it.');

    const { rows: post } = await pool.query(`select artifact_id from email.drafts where id = $1`, [draftId]);
    expect(String(post[0].artifact_id)).not.toBe(String(pre[0].artifact_id));
  });

  it('refuses a save with no recipient rather than storing an unsendable draft', async () => {
    const { draftId } = await seed();
    const res = await send('PUT', `/api/email/drafts/${draftId}`, { to: [] });
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
