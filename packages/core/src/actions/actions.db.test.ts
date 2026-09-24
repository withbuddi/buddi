/**
 * The authorization boundary, against a real Postgres.
 *
 * Skipped unless DATABASE_URL is set. The suite creates a throwaway database,
 * runs core's migrations into it and drops it at the end: the owner's real
 * actions are never touched.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { ToolRegistry } from '../registry.js';
import type { PluginManifest, Tier, CoreToolContext } from '../tools.js';
import { decideApproval } from './approvals.js';
import { executeApproved } from './execute.js';
import { createAction, expireDueApprovals, getAction, listEffectAttempts, listPendingActions } from './store.js';
import { hashArgs } from './types.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_actions_test_${process.pid}`;

suite('actions and approvals (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.actions cascade');
    await pool.query('truncate core.events cascade');
  });

  const ctx = (): CoreToolContext => ({
    db: pool,
    ownerId: 'owner',
    now: () => new Date(),
    timezone: 'UTC',
    agentId: 'mailer',
    conversationId: undefined,
  });

  /** A gated tool that records every call it actually makes. */
  function sendManifest(opts: {
    tier?: Tier;
    execute?: (input: any) => Promise<unknown>;
    describe?: boolean;
    timeoutMs?: number;
  } = {}): { manifest: PluginManifest; sent: unknown[] } {
    const sent: unknown[] = [];
    const manifest: PluginManifest = {
      name: 'mail',
      version: '1.2.3',
      schema: 'mail',
      migrationsDir: '/tmp/mail',
      tools: [
        {
          name: 'mail.send',
          description: 'Send an email.',
          tier: opts.tier ?? 'gated',
          input: z.object({ to: z.string(), subject: z.string() }),
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
          execute: async (input: any) => {
            sent.push(input);
            return opts.execute ? await opts.execute(input) : { messageId: 'mid-1' };
          },
          ...(opts.describe === false
            ? {}
            : {
                describe: (input: any) => ({
                  envelope: { to: [input.to], bcc: ['archive@example.com'], subject: input.subject },
                  preview: `Send "${input.subject}" to ${input.to} (bcc archive@example.com)`,
                }),
              }),
        },
      ],
    };
    return { manifest, sent };
  }

  describe('the registry gate', () => {
    it('turns a gated call into an action plus a pending approval, and executes nothing', async () => {
      const { manifest, sent } = sendManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);

      const res = await registry.invoke('mail.send', { to: 'a@b.c', subject: 'Hi' }, ctx());
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('approval-required');
      if (res.reason !== 'approval-required') throw new Error('unreachable');
      expect(sent).toEqual([]);

      const action = await getAction(pool, res.actionId);
      expect(action).toBeDefined();
      expect(action?.state).toBe('pending');
      expect(action?.tool).toBe('mail.send');
      expect(action?.toolVersion).toBe('1.2.3');
      expect(action?.agentId).toBe('mailer');
      // The envelope is the tool's, not the model's: the BCC nobody mentioned
      // is in the object the owner is approving.
      expect(action?.envelope).toMatchObject({ bcc: ['archive@example.com'] });
      expect(res.preview).toContain('bcc archive@example.com');
      expect(action?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await listPendingActions(pool)).toHaveLength(1);
    });

    it('records the tier the call was created under, and binds it into the hash', async () => {
      const { manifest } = sendManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);
      const res = await registry.invoke('mail.send', { to: 'a@b.c', subject: 'Hi' }, ctx());
      if (res.ok || res.reason !== 'approval-required') throw new Error('expected approval');
      const action = await getAction(pool, res.actionId);
      expect(action?.tier).toBe('gated');

      // And the Executor will not run an action recorded under anything else.
      // Writing the column by hand is what a future tier that learned to
      // record one would look like, and the hash moves with it.
      await pool.query(`update core.actions set tier = 'auto' where id = $1`, [res.actionId]);
      const decided = await decideApproval(pool, {
        actionId: res.actionId,
        decision: 'approved',
        by: 'owner',
        via: 'test',
      });
      expect(decided.ok).toBe(true);
      const executed = await executeApproved(pool, {
        actionId: res.actionId,
        registry,
        ctx: ctx(),
        worker: 'test',
      });
      expect(executed.ok).toBe(false);
      if (executed.ok) throw new Error('unreachable');
      expect(executed.reason).toBe('tier-not-executable');
      expect(await listEffectAttempts(pool, res.actionId)).toEqual([]);
    });

    it('falls back to canonical args when a tool describes nothing', async () => {
      const { manifest } = sendManifest({ describe: false });
      const registry = new ToolRegistry();
      registry.register(manifest);
      const res = await registry.invoke('mail.send', { subject: 'S', to: 'a@b.c' }, ctx());
      if (res.ok || res.reason !== 'approval-required') throw new Error('expected approval');
      const action = await getAction(pool, res.actionId);
      expect(action?.envelope).toEqual({ subject: 'S', to: 'a@b.c' });
      expect(action?.preview).toContain('mail.send');
    });

    it('refuses draft and session without session authority', async () => {
      for (const tier of ['draft', 'session'] as Tier[]) {
        const { manifest, sent } = sendManifest({ tier });
        const registry = new ToolRegistry();
        registry.register(manifest);
        const res = await registry.invoke('mail.send', { to: 'a@b.c', subject: 'x' }, ctx());
        expect(res).toMatchObject({ ok: false, reason: tier === 'session' ? 'session-not-authorized' : 'tier-not-executable' });
        expect(sent).toEqual([]);
      }
    });
  });

  /**
   * The same tool, but it offers the owner something: a control the *tool*
   * declared, with the list of values it declared, on the action recorded
   * before anybody was asked.
   */
  function choiceManifest(): { manifest: PluginManifest; ran: Array<Record<string, string> | undefined> } {
    const ran: Array<Record<string, string> | undefined> = [];
    const manifest: PluginManifest = {
      name: 'mail',
      version: '1.2.3',
      schema: 'mail',
      migrationsDir: '/tmp/mail',
      tools: [
        {
          name: 'mail.send',
          description: 'Send an email.',
          tier: 'gated',
          input: z.object({ to: z.string(), subject: z.string() }),
          execute: async (_input: any, toolCtx: CoreToolContext) => {
            ran.push(toolCtx.choices ? { ...toolCtx.choices } : undefined);
            return { messageId: 'mid-1' };
          },
          describe: (input: any) => ({
            envelope: { to: [input.to], subject: input.subject },
            preview: `Send "${input.subject}" to ${input.to}`,
            choices: [
              {
                key: 'from',
                label: 'Send as',
                options: ['owner@work.test', 'legal@work.test'],
                default: 'owner@work.test',
              },
            ],
          }),
        },
      ],
    };
    return { manifest, ran };
  }

  describe('the claim hook', () => {
    /**
     * A gated tool that holds something somebody else can edit.
     *
     * `claim` is the last moment at which nothing has happened. What this
     * suite is really about is the *ledger*: a refusal here must leave no
     * effect attempt, because an attempt row says "this may have gone out" and
     * a lost claim says the opposite.
     */
    function claimingManifest(opts: { claim: () => Promise<void> }): {
      manifest: PluginManifest;
      claimed: number;
      ran: unknown[];
    } {
      const state = { claimed: 0, ran: [] as unknown[] };
      const manifest: PluginManifest = {
        name: 'mail',
        version: '1.2.3',
        schema: 'mail',
        migrationsDir: '/tmp/mail',
        tools: [
          {
            name: 'mail.send',
            description: 'Send an email.',
            tier: 'gated',
            input: z.object({ to: z.string(), subject: z.string() }),
            describe: (input: any) => ({
              envelope: { to: [input.to], subject: input.subject },
              preview: `Send "${input.subject}" to ${input.to}`,
            }),
            claim: async () => {
              state.claimed += 1;
              await opts.claim();
            },
            execute: async (input: any) => {
              state.ran.push(input);
              return { messageId: 'mid-1' };
            },
          },
        ],
      };
      return { manifest, get claimed() { return state.claimed; }, get ran() { return state.ran; } } as never;
    }

    const approvedWith = async (registry: ToolRegistry): Promise<string> => {
      const res = await registry.invoke('mail.send', { to: 'a@b.c', subject: 'Hi' }, ctx());
      if (res.ok || res.reason !== 'approval-required') throw new Error('expected approval');
      const decided = await decideApproval(pool, {
        actionId: res.actionId,
        decision: 'approved',
        by: 'owner',
        via: 'web',
      });
      expect(decided.ok).toBe(true);
      return res.actionId;
    };

    it('is actually called — the registry hands it to the Executor', async () => {
      const tool = claimingManifest({ claim: async () => {} });
      const registry = new ToolRegistry();
      registry.register(tool.manifest);
      // The registry builds the executable view of a tool by hand; a field it
      // forgets to copy is a hook that silently never runs.
      expect(registry.lookup('mail.send')?.claim).toBeTypeOf('function');

      const id = await approvedWith(registry);
      const out = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(out.ok).toBe(true);
      expect(tool.claimed).toBe(1);
      expect(tool.ran).toHaveLength(1);
    });

    it('settles refused with nothing in the ledger when the claim is lost', async () => {
      const tool = claimingManifest({
        claim: async () => {
          throw new Error('somebody edited it while you were deciding');
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool.manifest);
      const id = await approvedWith(registry);

      const out = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(out).toMatchObject({ ok: false, state: 'refused' });
      expect(out.ok ? '' : out.message).toContain('somebody edited it while you were deciding');
      // Never dispatched, and the ledger says so by holding nothing at all: an
      // attempt row would claim the effect may have happened.
      expect(tool.ran).toEqual([]);
      expect(await listEffectAttempts(pool, id)).toHaveLength(0);
      expect((await getAction(pool, id))?.state).toBe('refused');
    });
  });

  describe('owner choices on an approval', () => {
    const proposed = async (): Promise<{ id: string; registry: ToolRegistry; ran: Array<Record<string, string> | undefined> }> => {
      const { manifest, ran } = choiceManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);
      const res = await registry.invoke('mail.send', { to: 'a@b.c', subject: 'Hi' }, ctx());
      if (res.ok || res.reason !== 'approval-required') throw new Error('expected approval');
      return { id: res.actionId, registry, ran };
    };

    it('records what the tool offered on the action itself', async () => {
      const { id } = await proposed();
      const action = await getAction(pool, id);
      expect(action?.choices).toEqual([
        {
          key: 'from',
          label: 'Send as',
          options: ['owner@work.test', 'legal@work.test'],
          default: 'owner@work.test',
        },
      ]);
      // Pending: nothing has been picked yet, and `{}` would be a picked
      // nothing rather than an unanswered question.
      expect(action?.ownerChoices).toBeNull();
    });

    it('refuses a key nobody offered, and changes nothing', async () => {
      const { id } = await proposed();
      const out = await decideApproval(pool, {
        actionId: id,
        decision: 'approved',
        by: 'owner',
        via: 'web',
        ownerChoices: { replyTo: 'someone@else.test' },
      });
      expect(out).toMatchObject({ ok: false, reason: 'invalid-choice' });
      expect((await getAction(pool, id))?.state).toBe('pending');
    });

    it('refuses a value that is not one of the options, and changes nothing', async () => {
      const { id } = await proposed();
      const out = await decideApproval(pool, {
        actionId: id,
        decision: 'approved',
        by: 'owner',
        via: 'web',
        ownerChoices: { from: 'attacker@evil.test' },
      });
      expect(out).toMatchObject({ ok: false, reason: 'invalid-choice' });
      expect((await getAction(pool, id))?.state).toBe('pending');
    });

    it('hands execute the value the owner picked', async () => {
      const { id, registry, ran } = await proposed();
      const decided = await decideApproval(pool, {
        actionId: id,
        decision: 'approved',
        by: 'owner',
        via: 'web',
        ownerChoices: { from: 'legal@work.test' },
      });
      expect(decided.ok).toBe(true);
      const out = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(out.ok).toBe(true);
      expect(ran).toEqual([{ from: 'legal@work.test' }]);
      expect((await getAction(pool, id))?.ownerChoices).toEqual({ from: 'legal@work.test' });
    });

    it('fills an unanswered choice in from its declared default', async () => {
      const { id, registry, ran } = await proposed();
      await decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'cli' });
      await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(ran).toEqual([{ from: 'owner@work.test' }]);
    });

    it('binds the menu into the hash: swapping the options voids the approval', async () => {
      const { id, registry, ran } = await proposed();
      await decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'web' });
      await pool.query(
        `update core.actions set choices = $2::jsonb where id = $1`,
        [
          id,
          JSON.stringify([
            { key: 'from', label: 'Send as', options: ['owner@work.test', 'attacker@evil.test'], default: 'owner@work.test' },
          ]),
        ],
      );
      const out = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(out).toMatchObject({ ok: false, reason: 'args-hash-mismatch', state: 'refused' });
      expect(ran).toEqual([]);
    });
  });

  describe('decideApproval', () => {
    const pending = async (): Promise<string> => {
      const action = await createAction(pool, {
        tool: 'mail.send',
        toolVersion: '1.2.3',
        agentId: 'mailer',
        canonicalArgs: { subject: 'Hi', to: 'a@b.c' },
        envelope: { to: ['a@b.c'] },
        preview: 'Send "Hi" to a@b.c',
      });
      return action.id;
    };

    it('moves pending to approved, once', async () => {
      const id = await pending();
      const first = await decideApproval(pool, {
        actionId: id,
        decision: 'approved',
        by: 'owner',
        via: 'telegram',
      });
      expect(first).toMatchObject({ ok: true });
      if (!first.ok) throw new Error('unreachable');
      expect(first.action.state).toBe('approved');
      expect(first.action.decidedBy).toBe('owner');
      expect(first.action.decidedVia).toBe('telegram');

      const second = await decideApproval(pool, {
        actionId: id,
        decision: 'rejected',
        by: 'owner',
        via: 'telegram',
      });
      expect(second).toMatchObject({ ok: false, reason: 'already-decided', state: 'approved' });
    });

    it('rejects, and a rejection is equally final', async () => {
      const id = await pending();
      expect(
        await decideApproval(pool, { actionId: id, decision: 'rejected', by: 'owner', via: 'cli' }),
      ).toMatchObject({ ok: true });
      expect(
        await decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'cli' }),
      ).toMatchObject({ ok: false, reason: 'already-decided', state: 'rejected' });
    });

    it('only one of two racing decisions wins', async () => {
      const id = await pending();
      const [a, b] = await Promise.all([
        decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'telegram' }),
        decideApproval(pool, { actionId: id, decision: 'rejected', by: 'owner', via: 'cli' }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    });

    it('expires instead of deciding once the deadline has passed', async () => {
      const action = await createAction(pool, {
        tool: 'mail.send',
        toolVersion: '1.2.3',
        agentId: 'mailer',
        canonicalArgs: {},
        envelope: {},
        preview: 'p',
        expiresAt: new Date(Date.now() - 1000),
      });
      const res = await decideApproval(pool, {
        actionId: action.id,
        decision: 'approved',
        by: 'owner',
        via: 'telegram',
      });
      expect(res).toMatchObject({ ok: false, reason: 'expired' });
      expect((await getAction(pool, action.id))?.state).toBe('expired');
    });

    it('sweeps due approvals to expired', async () => {
      const action = await createAction(pool, {
        tool: 'mail.send',
        toolVersion: '1.2.3',
        agentId: 'mailer',
        canonicalArgs: {},
        envelope: {},
        preview: 'p',
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await expireDueApprovals(pool)).toEqual([action.id]);
      expect((await getAction(pool, action.id))?.state).toBe('expired');
    });

    it('says so plainly when the action does not exist', async () => {
      const res = await decideApproval(pool, {
        actionId: '00000000-0000-0000-0000-000000000000',
        decision: 'approved',
        by: 'owner',
        via: 'telegram',
      });
      expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    });
  });

  describe('executeApproved', () => {
    const approved = async (args: Record<string, unknown> = { subject: 'Hi', to: 'a@b.c' }) => {
      const action = await createAction(pool, {
        tool: 'mail.send',
        toolVersion: '1.2.3',
        agentId: 'mailer',
        canonicalArgs: args,
        envelope: { to: [args.to], bcc: ['archive@example.com'], subject: args.subject },
        preview: 'Send "Hi" to a@b.c',
      });
      await decideApproval(pool, {
        actionId: action.id,
        decision: 'approved',
        by: 'owner',
        via: 'telegram',
      });
      return action.id;
    };

    it('runs the tool once and records the attempt and the outcome', async () => {
      const { manifest, sent } = sendManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);
      const id = await approved();

      const res = await executeApproved(pool, {
        actionId: id,
        registry,
        ctx: ctx(),
        worker: 'w1',
      });
      expect(res).toMatchObject({ ok: true, state: 'succeeded', attempt: 1 });
      expect(sent).toEqual([{ subject: 'Hi', to: 'a@b.c' }]);

      const action = await getAction(pool, id);
      expect(action?.state).toBe('succeeded');
      expect(action?.claimedBy).toBe('w1');
      const attempts = await listEffectAttempts(pool, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attempt: 1, state: 'succeeded' });
      // Intent was recorded before dispatch: the envelope hash is on the row.
      expect(attempts[0]?.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is claimed exactly once when workers race', async () => {
      const { manifest, sent } = sendManifest({
        execute: async () => {
          await new Promise((r) => setTimeout(r, 25));
          return { messageId: 'mid' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(manifest);
      const id = await approved();

      const results = await Promise.all(
        ['w1', 'w2', 'w3', 'w4'].map((worker) =>
          executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        results.filter((r) => !r.ok && r.reason === 'already-claimed'),
      ).toHaveLength(3);
      // The effect itself happened exactly once.
      expect(sent).toHaveLength(1);
      expect(await listEffectAttempts(pool, id)).toHaveLength(1);
    });

    it('refuses when the approved arguments no longer hash to the approved value', async () => {
      const { manifest, sent } = sendManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);
      const id = await approved();
      // Someone edits the row under the standing approval.
      await pool.query(
        `update core.actions set canonical_args = $2::jsonb where id = $1`,
        [id, JSON.stringify({ subject: 'Hi', to: 'attacker@example.com' })],
      );

      const res = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      // `refused`, not `failed`: nothing was dispatched, so this did not
      // half-happen the way a thrown effect might have.
      expect(res).toMatchObject({ ok: false, reason: 'args-hash-mismatch', state: 'refused' });
      expect(sent).toEqual([]);
      // Nothing was dispatched, so nothing is in the ledger.
      expect(await listEffectAttempts(pool, id)).toHaveLength(0);
      expect((await getAction(pool, id))?.state).toBe('refused');
    });

    it('refuses when the tool moved to another version', async () => {
      const { manifest, sent } = sendManifest();
      const registry = new ToolRegistry();
      registry.register({ ...manifest, version: '2.0.0' });
      const id = await approved();
      const res = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(res).toMatchObject({ ok: false, reason: 'args-hash-mismatch' });
      expect(sent).toEqual([]);
    });

    it('records a timeout as unknown, never as failed and never retried', async () => {
      const { manifest } = sendManifest({
        timeoutMs: 20,
        execute: () => new Promise(() => {}),
      });
      const registry = new ToolRegistry();
      registry.register(manifest);
      const id = await approved();

      const res = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(res).toMatchObject({ ok: false, state: 'unknown', reason: 'timeout' });
      expect((await getAction(pool, id))?.state).toBe('unknown');
      const attempts = await listEffectAttempts(pool, id);
      expect(attempts[0]).toMatchObject({ state: 'unknown' });
      // A second call does not re-run it: the approval is no longer approved.
      const again = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w2' });
      expect(again).toMatchObject({ ok: false });
      expect(await listEffectAttempts(pool, id)).toHaveLength(1);
    });

    it('records a throwing tool as failed, with the error on the attempt', async () => {
      const { manifest } = sendManifest({
        execute: async () => {
          throw new Error('smtp said no');
        },
      });
      const registry = new ToolRegistry();
      registry.register(manifest);
      const id = await approved();
      const res = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(res).toMatchObject({ ok: false, state: 'failed', reason: 'tool-error' });
      expect((await listEffectAttempts(pool, id))[0]).toMatchObject({
        state: 'failed',
        error: 'smtp said no',
      });
    });

    it('will not execute an action that was never approved', async () => {
      const { manifest, sent } = sendManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);
      const action = await createAction(pool, {
        tool: 'mail.send',
        toolVersion: '1.2.3',
        agentId: 'mailer',
        canonicalArgs: { subject: 'Hi', to: 'a@b.c' },
        envelope: {},
        preview: 'p',
      });
      const res = await executeApproved(pool, {
        actionId: action.id,
        registry,
        ctx: ctx(),
        worker: 'w1',
      });
      expect(res).toMatchObject({ ok: false, reason: 'not-approved', state: 'pending' });
      expect(sent).toEqual([]);
    });

    it('will not execute an approval that expired while it waited', async () => {
      const { manifest, sent } = sendManifest();
      const registry = new ToolRegistry();
      registry.register(manifest);
      const id = await approved();
      // Aged with *this* clock, not the database's: `executeApproved` compares
      // `expires_at` against the `now` in the CoreToolContext, and the container's
      // clock is not the host's.
      await pool.query(`update core.actions set expires_at = $2 where id = $1`, [
        id,
        new Date(Date.now() - 3_600_000),
      ]);
      const res = await executeApproved(pool, { actionId: id, registry, ctx: ctx(), worker: 'w1' });
      expect(res).toMatchObject({ ok: false, reason: 'expired', state: 'expired' });
      expect(sent).toEqual([]);
    });
  });

  it('writes an event for every transition', async () => {
    const { manifest } = sendManifest();
    const registry = new ToolRegistry();
    registry.register(manifest);
    const res = await registry.invoke('mail.send', { to: 'a@b.c', subject: 'Hi' }, ctx());
    if (res.ok || res.reason !== 'approval-required') throw new Error('expected approval');
    await decideApproval(pool, {
      actionId: res.actionId,
      decision: 'approved',
      by: 'owner',
      via: 'telegram',
    });
    await executeApproved(pool, { actionId: res.actionId, registry, ctx: ctx(), worker: 'w1' });

    const { rows } = await pool.query(`select kind from core.events order by id asc`);
    expect(rows.map((r) => r.kind)).toEqual([
      'action.created',
      'approval.decided',
      'approval.claimed',
      'effect.attempted',
      'effect.succeeded',
    ]);
  });

  it('hashes canonically: key order does not change the approved hash', () => {
    expect(hashArgs('t', '1', { a: 1, b: 2 })).toBe(hashArgs('t', '1', { b: 2, a: 1 }));
    expect(hashArgs('t', '1', { a: 1 })).not.toBe(hashArgs('t', '2', { a: 1 }));
    expect(vi.isMockFunction(hashArgs)).toBe(false);
  });
});
