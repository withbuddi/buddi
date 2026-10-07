/**
 * An agent's sign-in card answered on the dashboard, end to end through the
 * real owner-secret store (docs/owner-secrets.md §6, "Saved from a
 * conversation"): `POST /api/secrets` saves a set for one site in one call;
 * Save and fill raises exactly one `secrets.use_set` approval for the set and
 * fills each field through `secret.fill` without another card; a locked vault
 * saves nothing and keeps the card; "I'll sign in myself" hands the page over;
 * a set saved with Save only asks once for the set when an agent fills it.
 * No value is ever in an event, a message, a question or what the agent hears.
 * The database is created here and dropped.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  askQuestion,
  configurePluginHost,
  createMemoryVault,
  createPool,
  createSecretsManifest,
  findSecret,
  getQuestion,
  migrateCore,
  ownerSecretVaultName,
  resetPluginHost,
  resetSecretDestinations,
  secretBindings,
  ToolRegistry,
  type CoreToolContext,
  type PluginManifest,
  type SecretRequestCard,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { fieldDestination } from '@buddi/tool-browser';
import { z } from 'zod';
import { declineSecretRequest, saveSecretSet, type SecretRequestRouteDeps } from './secret-request.js';
import { listSecrets } from './secrets.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_secret_request_${process.pid}`;
const USERNAME = 'SamRuiz-7731';
const PASSWORD = 'correct-horse-battery-9f2b';
const PAGE = 'https://en.wikipedia.org';

suite('an agent\'s sign-in card on the dashboard (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const vault = createMemoryVault();
  const registry = new ToolRegistry();
  /** What the stand-in `secret.fill` was handed: whether a value arrived, never the value. */
  const fills: Array<{ name: string; ref?: string; label?: string; delivered: boolean; pending?: string }> = [];
  const ctx = { ownerId: 'owner', timezone: 'UTC' } as Omit<CoreToolContext, 'db'>;

  /**
   * The browser plugin's destination and a `secret.fill` that does what the
   * real one does with a use, minus the page: asks core for the value on the
   * page's origin and reports whether it came.
   */
  const browser: PluginManifest = {
    name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', uses: ['secrets'],
    destinations: [fieldDestination],
    tools: [{
      name: 'secret.fill', tier: 'auto', description: 'stand-in',
      input: z.object({ name: z.string(), ref: z.string().optional(), label: z.string().optional() }).strict(),
      async execute(input: { name: string; ref?: string; label?: string }, toolCtx: CoreToolContext) {
        const outcome = await toolCtx.buddi!.secrets!.use(input.name, 'browser.field', PAGE);
        if ('pending' in outcome) {
          fills.push({ ...input, delivered: false, pending: outcome.pending });
          return { pending: true, actionId: outcome.pending };
        }
        if ('refused' in outcome) throw new Error(outcome.refused);
        fills.push({ ...input, delivered: true });
        return { filled: true };
      },
    }],
  } as unknown as PluginManifest;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrateCore(pool);
    configurePluginHost({ vault });
    registry.register(createSecretsManifest());
    registry.register(browser);
  }, 120_000);

  afterAll(async () => {
    resetPluginHost();
    resetSecretDestinations();
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists ${TEST_DB}`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  const deps = (more: Partial<SecretRequestRouteDeps> = {}): SecretRequestRouteDeps => ({
    pool, registry, ctx, now: () => new Date(), ...more,
  });

  async function conversationWithCard(fields: SecretRequestCard['fields'] = [
    { label: 'Username', kind: 'username', ref: 'e3' },
    { label: 'Password', kind: 'password', ref: 'e4' },
  ]): Promise<{ conversationId: string; questionId: string }> {
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('scout') returning id::text as id`);
    const conversationId = String(rows[0].id);
    await pool.query(`insert into core.messages (conversation_id, role, content) values ($1, 'user', $2::jsonb)`, [conversationId, JSON.stringify([{ type: 'text', text: 'Add the Lyon article to my Wikipedia watchlist.' }])]);
    const question = await askQuestion(pool, {
      agentId: 'scout', conversationId, question: 'No saved sign-in for wikipedia.org',
      options: [{ label: 'Decline', hint: null, recommended: false }], allowOther: false, now: new Date(),
      request: { kind: 'secret.request', site: 'wikipedia.org', origins: [PAGE, 'https://wikipedia.org', 'https://*.wikipedia.org'], fields, agentName: 'Scout' },
    });
    return { conversationId, questionId: question.id };
  }

  /** Every text the owner's surfaces read, as one string: none may hold a value. */
  async function everything(): Promise<string> {
    const events = await pool.query(`select payload::text as t from core.events`);
    const messages = await pool.query(`select content::text as t from core.messages`);
    const questions = await pool.query(`select coalesce(answer, '') || coalesce(request::text, '') as t from core.questions`);
    const actions = await pool.query(`select canonical_args::text || coalesce(envelope::text, '') || coalesce(preview, '') as t from core.actions`);
    return [...events.rows, ...messages.rows, ...questions.rows, ...actions.rows].map((row: { t: string }) => row.t).join('\n');
  }

  it('saves a set for one site in one call, bound to the site and every host under it', async () => {
    const answer = await saveSecretSet(deps(), {
      site: 'https://www.wikipedia.org/',
      fields: [{ label: 'Username', kind: 'username', value: USERNAME }, { label: 'Password', kind: 'password', value: PASSWORD }],
    });
    expect(answer).toEqual({ status: 200, body: { saved: ['Wikipedia username', 'Wikipedia password'], site: 'wikipedia.org' } });
    const secret = await findSecret(pool, 'Wikipedia password');
    expect(await vault.get(ownerSecretVaultName(secret!.id))).toBe(PASSWORD);
    expect((await secretBindings(pool, secret!.id)).map(({ kind, target, rule }) => ({ kind, target, rule })).sort((a, b) => String(a.target).localeCompare(String(b.target)))).toEqual([
      { kind: 'browser.field', target: 'https://*.wikipedia.org', rule: 'first-time' },
      { kind: 'browser.field', target: 'https://wikipedia.org', rule: 'first-time' },
    ]);
    const { rows } = await pool.query(`select count(distinct set_id)::int as sets, min(site) as site from core.secrets where name like 'Wikipedia %'`);
    expect(rows[0]).toEqual({ sets: 1, site: 'wikipedia.org' });
    // A second save names the next one rather than overwriting the first.
    const again = await saveSecretSet(deps(), { site: 'wikipedia.org', fields: [{ label: 'Password', kind: 'password', value: 'another-one-123' }] });
    expect((again.body as { saved: string[] }).saved).toEqual(['Wikipedia password 2']);
    await pool.query(`delete from core.secrets`);
  });

  it('refuses a set with no site or no value', async () => {
    expect((await saveSecretSet(deps(), { fields: [{ label: 'Password', kind: 'password', value: PASSWORD }] })).status).toBe(400);
    expect((await saveSecretSet(deps(), { site: 'wikipedia.org', fields: [{ label: 'Password', kind: 'password', value: '  ' }] })).status).toBe(400);
  });

  it('Save and fill raises exactly one approval for the set, fills every field, and the agent hears names only', async () => {
    const { conversationId, questionId } = await conversationWithCard();
    const carryOn = vi.fn(async () => 'run-1');
    fills.length = 0;
    const answer = await saveSecretSet(deps({ carryOn }), {
      questionId, then: 'fill',
      fields: [{ label: 'Username', kind: 'username', value: USERNAME }, { label: 'Password', kind: 'password', value: PASSWORD }],
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ saved: ['Wikipedia username', 'Wikipedia password'], filled: true, stamp: 'Filled username and password on wikipedia.org' });

    const { rows: actions } = await pool.query(
      `select a.tool, ap.state from core.actions a join core.approvals ap on ap.action_id = a.id where a.conversation_id = $1`,
      [conversationId],
    );
    expect(actions).toEqual([{ tool: 'secrets.use_set', state: 'succeeded' }]);
    // By the label the page shows (refs move once a fill redraws the page), the ref beside it.
    expect(fills).toEqual([
      { name: 'Wikipedia username', label: 'Username', ref: 'e3', delivered: true },
      { name: 'Wikipedia password', label: 'Password', ref: 'e4', delivered: true },
    ]);

    expect(carryOn).toHaveBeenCalledTimes(1);
    const turn = (carryOn.mock.calls[0] as unknown as [{ text: string; stamp: string; agentId: string }])[0];
    expect(turn.agentId).toBe('scout');
    expect(turn.text).toContain('{"saved":["Wikipedia username","Wikipedia password"],"filled":true,"fields":[{"name":"Wikipedia username","label":"Username","ref":"e3","filled":true},{"name":"Wikipedia password","label":"Password","ref":"e4","filled":true}]}');
    // It goes on to press the sign-in button itself.
    expect(turn.text).toContain('press its sign-in button');
    expect(turn.text).not.toContain(PASSWORD);
    expect(turn.text).not.toContain(USERNAME);

    const question = await getQuestion(pool, questionId);
    expect(question?.answeredAt).not.toBeNull();
    const all = await everything();
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(USERNAME);

    // Keys and secrets links each back to the conversation it came from.
    const listed = await listSecrets({ pool, registry, ctx, now: () => new Date() });
    const row = (listed.body as { secrets: Array<{ name: string; savedFrom?: { conversationId: string; agentId: string; title: string; site: string } }> }).secrets.find((s) => s.name === 'Wikipedia password');
    expect(row?.savedFrom).toMatchObject({ conversationId, agentId: 'scout', title: 'Add the Lyon article to my Wikipedia watchlist.', site: 'wikipedia.org' });
    expect(JSON.stringify(listed.body)).not.toContain(PASSWORD);

    // A second press saves nothing twice.
    expect((await saveSecretSet(deps({ carryOn }), { questionId, then: 'fill', fields: [{ label: 'Password', kind: 'password', value: PASSWORD }] })).status).toBe(409);
    await pool.query(`delete from core.secrets`);
  });

  it('a locked vault saves nothing, says so, and keeps the card', async () => {
    const { questionId } = await conversationWithCard();
    configurePluginHost({ vault: createMemoryVault({ locked: true }) });
    try {
      const answer = await saveSecretSet(deps(), { questionId, then: 'fill', fields: [{ label: 'Password', kind: 'password', value: PASSWORD }] });
      expect(answer).toEqual({ status: 409, body: { error: 'Nothing was saved: the vault is locked.', locked: true } });
    } finally {
      configurePluginHost({ vault });
    }
    expect(await findSecret(pool, 'Wikipedia password')).toBeNull();
    expect((await getQuestion(pool, questionId))?.answeredAt).toBeNull();
  });

  it('"I\'ll sign in myself" hands the page over and the agent hears it declined', async () => {
    const { conversationId, questionId } = await conversationWithCard();
    const handOver = vi.fn(async () => true);
    const carryOn = vi.fn(async () => 'run-2');
    const answer = await declineSecretRequest(deps({ browser: { handOver }, carryOn }), { questionId, reason: 'sign-in-myself' });
    expect(answer.status).toBe(200);
    expect(handOver).toHaveBeenCalledWith({ conversationId, agentId: 'scout' });
    expect((carryOn.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('{"declined":"sign-in-myself"}');
    expect((await declineSecretRequest(deps(), { questionId, reason: 'cancelled' })).status).toBe(409);
  });

  it('Save only hands the page over; a later fill of the set asks once for the whole set', async () => {
    const { conversationId, questionId } = await conversationWithCard();
    const handOver = vi.fn(async () => true);
    const answer = await saveSecretSet(deps({ browser: { handOver } }), {
      questionId, then: 'save',
      fields: [{ label: 'Username', kind: 'username', value: USERNAME }, { label: 'Password', kind: 'password', value: PASSWORD }],
    });
    expect(answer.body).toMatchObject({ saved: ['Wikipedia username', 'Wikipedia password'], filled: false });
    expect(handOver).toHaveBeenCalledTimes(1);

    // Later, the agent fills: one card for the set, the same card for its second field.
    fills.length = 0;
    const agentCtx = { ...ctx, agentId: 'scout', conversationId, db: pool, now: () => new Date() } as CoreToolContext;
    await registry.invoke('secret.fill', { name: 'Wikipedia username', ref: 'e3' }, agentCtx);
    await registry.invoke('secret.fill', { name: 'Wikipedia password', ref: 'e4' }, agentCtx);
    expect(fills.map((fill) => fill.delivered)).toEqual([false, false]);
    expect(fills[0]?.pending).toBe(fills[1]?.pending);
    const { rows } = await pool.query(
      `select a.tool, a.canonical_args->'items' as items, ap.state from core.actions a join core.approvals ap on ap.action_id = a.id where a.conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('secrets.use_set');
    expect(rows[0].state).toBe('pending');
    expect((rows[0].items as Array<{ secret: string }>).map((item) => item.secret)).toEqual(['Wikipedia username', 'Wikipedia password']);
    expect(await everything()).not.toContain(PASSWORD);
  });
});
