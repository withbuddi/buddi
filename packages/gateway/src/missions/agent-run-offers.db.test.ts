/**
 * A queued offer answers in the conversation it came from.
 *
 * An offer taken somewhere other than the thread it belongs to — the Offers
 * page, a Telegram button — still goes on the queue, and it used to end there:
 * the run opened a conversation of its own and the answer reached the owner by
 * notification alone, so the thread that offered the button showed nothing
 * afterwards. Whatever the surface, the offer names a conversation, and that is
 * where its run belongs and where its report is written.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  createPool,
  ensureOwner,
  enqueue,
  listJobs,
  offerActions,
  runMigrations,
  ToolRegistry,
  type AgentCatalog,
  type Job,
  type JobContext,
  type CoreToolContext,
} from '@buddi/core';
import { createConversation, type CompletionResponse, type RuntimeProvider } from '@buddi/runtime';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as emailManifest } from '@buddi/tool-email';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import type { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createToolRegistry, loadGatewayCatalog } from '../agents/catalog.js';
import { AGENT_RUN_JOB_KIND, createAgentRunHandler, OFFER_HINT_PREFIX } from './agent-run.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_agentrun_offers_test_${process.pid}`;

const ENV = { BUDDI_TZ: 'America/New_York' } as NodeJS.ProcessEnv;
const MISSION_AGENT = 'mission-agent';
const NOW = new Date('2026-09-21T12:00:00Z');
const TZ = 'America/New_York';

const jobContext = (): JobContext => ({
  signal: new AbortController().signal,
  heartbeat: async () => true,
  suspend: async () => {},
  lost: false,
});

function fixtureCatalog(registry: ToolRegistry): AgentCatalog {
  return loadGatewayCatalog({
    dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'mission-agents'),
    env: ENV,
    registry,
  });
}

/** Reports once, then stops: an unattended run's shape. */
function reportingProvider(text: string): RuntimeProvider {
  let turn = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      turn += 1;
      if (turn === 1) {
        return {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'mission.report', input: { urgency: 'normal', text } },
          ],
          stopReason: 'tool_use',
          usage: { input: 1, output: 1 },
          model: 'claude-test',
        };
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
        model: 'claude-test',
      };
    },
  };
}

suite('an offer taken away from its thread (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [emailManifest, memoryManifest, artifactsManifest]);
    await ensureOwner(pool, 'owner');
    ctx = { db: pool, ownerId: 'owner', now: () => NOW, timezone: TZ };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.jobs cascade');
    await pool.query('truncate core.offers cascade');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
  });

  const runTakenOffer = async (opts: { conversationId: string | null; text: string }) => {
    const [offer] = await offerActions(pool, {
      agentId: MISSION_AGENT,
      conversationId: opts.conversationId,
      actions: [{ label: 'Send it', prompt: 'send the reply I drafted' }],
      now: NOW,
    });
    await enqueue(pool, {
      kind: AGENT_RUN_JOB_KIND,
      payload: {
        agentId: MISSION_AGENT,
        prompt: offer!.prompt,
        conversationHint: `${OFFER_HINT_PREFIX}${offer!.id}`,
      },
      dedupKey: `offer:${offer!.id}`,
    });
    const job = (await listJobs(pool, { kind: AGENT_RUN_JOB_KIND }))[0] as Job;

    const registry = createToolRegistry();
    const delivered: string[] = [];
    const contexts: unknown[] = [];
    const handle = createAgentRunHandler({
      pool,
      registry,
      catalog: fixtureCatalog(registry),
      provider: reportingProvider(opts.text),
      ctx,
      now: () => NOW,
      deliver: async (text, _offers, context) => {
        delivered.push(text);
        contexts.push(context);
        return 'chat';
      },
      log: () => {},
    });
    const outcome = (await handle({ ...job, attempts: 1 } as Job, jobContext())) as {
      conversationId: string;
      decision: string;
      delivered: boolean;
    };
    return { offer: offer!, outcome, delivered, contexts };
  };

  it('runs in the offer’s own conversation and writes the report into it', async () => {
    const conversationId = await createConversation(pool, MISSION_AGENT);
    const { outcome, delivered, contexts } = await runTakenOffer({
      conversationId,
      text: 'Sent. Dorothée has the reply.',
    });
    // The owner's notifications are told where the run came from.
    expect(contexts).toEqual([expect.objectContaining({ agentId: MISSION_AGENT, origin: 'offer' })]);

    // The run stays where the offer was made — not in a conversation of its own.
    expect(outcome).toMatchObject({ conversationId, decision: 'report', delivered: true });
    // Telegram still hears it; that half is unchanged.
    expect(delivered).toEqual(['Sent. Dorothée has the reply.']);

    // And so does the thread: the report is a message in it, which is what the
    // dashboard draws. Before this, that conversation showed nothing at all.
    const { rows } = await pool.query(
      `select role, content from core.messages
        where conversation_id = $1::uuid order by created_at asc, id asc`,
      [conversationId],
    );
    const assistantText = rows
      .filter((r) => r.role === 'assistant')
      .flatMap((r) => (r.content as Array<{ type: string; text?: string }>))
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
    expect(assistantText).toContain('Sent. Dorothée has the reply.');
    // The owner's half is the prompt the agent wrote, run as the opening turn.
    expect(rows.some((r) => r.role === 'user')).toBe(true);

    // The page watching that thread is told, the way an interactive turn tells it.
    const { rows: events } = await pool.query(
      `select payload from core.events
        where conversation_id = $1::uuid and kind = 'chat.message.appended'`,
      [conversationId],
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).role).toBe('assistant');
  });

  it('opens a conversation of its own when the offer never had one', async () => {
    const { offer, outcome } = await runTakenOffer({ conversationId: null, text: 'Nothing to do.' });
    expect(offer.conversationId).toBeNull();
    expect(outcome.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing was invented: no report row was written into a thread that has
    // no business holding one.
    const { rows } = await pool.query(
      `select count(*)::int as n from core.events where kind = 'chat.message.appended'`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
