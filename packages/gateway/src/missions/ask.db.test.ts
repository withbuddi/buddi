/**
 * A mission's own question (docs/browser.md, "Any mission may ask"), against
 * a throwaway database: an unattended run that asks the owner parks on the
 * question exactly as a browser card does — a card, a notification with the
 * choices, the answer resuming the run in its conversation, and one "needed
 * you" line when nobody answers. The run is told it may ask; a `/recap` in an
 * open chat is not.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  answerQuestion,
  createPool,
  ensureOwner,
  getJob,
  getOccurrence,
  openQuestion,
  runMigrations,
  runWorker,
  ToolRegistry,
  upsertMission,
  type CoreToolContext,
  type Mission,
} from '@buddi/core';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { loadGatewayCatalog } from '../agents/catalog.js';
import { insertOccurrence } from '../missions-cli.js';
import { createMissionJobHandler, MISSION_JOB_KIND, queueOccurrence } from '../serve.js';
import { readAgentAttention } from '../web/attention.js';
import { createMissionExecutor, firstQuestionSink, MISSION_ASK_LINE } from './execute.js';
import { createInlineMissionRunner } from './inline.js';
import { expireParkedRuns, PARKED_REASON_PREFIX, resumeParkedForQuestion } from './parked.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_missions_ask_test_${process.pid}`;
const ENV = { BUDDI_TZ: 'UTC' } as NodeJS.ProcessEnv;
const AGENT = 'browser-agent';

type Step = { tool: string; input: unknown } | { text: string };
/** Plays the steps in order, one per model call, and keeps what each call was told. */
function scripted(steps: Step[], seen: CompletionRequest[]): RuntimeProvider {
  let n = 0;
  return {
    async complete(req): Promise<CompletionResponse> {
      seen.push(req);
      const step = steps[n++] ?? { text: 'done' };
      if ('tool' in step) {
        return { content: [{ type: 'tool_use', id: `tu-${n}`, name: step.tool, input: step.input }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'claude-test' };
      }
      return { content: [{ type: 'text', text: step.text }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' };
    },
  };
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

suite('missions that ask the owner (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let registry: ToolRegistry;
  let ctx: CoreToolContext;
  let logs: string[] = [];

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [memoryManifest]);
    await ensureOwner(pool, 'owner');
    ctx = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    registry = new ToolRegistry();
    registry.register(memoryManifest);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    logs = [];
    await pool.query('truncate core.jobs cascade');
    await pool.query('truncate core.occurrences, core.missions cascade');
    await pool.query('truncate core.questions, core.owner_notifications cascade');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
  });

  const catalog = () => loadGatewayCatalog({
    dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'browsing-agents'),
    env: ENV,
    registry,
  });

  // Not a browsing mission: the question is the run's own.
  const mission = (): Promise<Mission> => upsertMission(pool, {
    id: 'agent:browser-agent:renewal', name: 'Renewal', agentId: AGENT, prompt: 'Check whether the domain renewal went through.', browser: null,
  });

  const QUESTION = 'Renew withbuddi.com for one year or three?';
  const ASK: Step = {
    tool: 'conversation.ask',
    input: { question: QUESTION, options: [{ label: 'One year', recommended: true }, { label: 'Three years' }] },
  };

  const executor = (steps: Step[], seen: CompletionRequest[], delivered: string[]) => createMissionExecutor({
    pool, registry, catalog: catalog(), provider: scripted(steps, seen), ctx, env: ENV, now: () => new Date(),
    deliver: async (text) => { delivered.push(text); return 'chat-1'; },
    log: (line) => { logs.push(line); },
  });

  /** Run the occurrence as a queue job until it parks on the question. */
  const parkedRun = async (steps: Step[]) => {
    const m = await mission();
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const job = await queueOccurrence(pool, occurrence, m);
    const seen: CompletionRequest[] = [];
    const delivered: string[] = [];
    const handler = createMissionJobHandler({ pool, execute: executor(steps, seen, delivered), log: () => {} });
    const worker = runWorker({ pool, worker: 'test', kinds: [MISSION_JOB_KIND], handlers: { [MISSION_JOB_KIND]: handler }, now: () => new Date(), pollMs: 5, leaseMs: 5_000 });
    await waitFor(async () => (await getJob(pool, job.id))?.state === 'suspended');
    const conversationId = ((await getJob(pool, job.id))?.payload as { parked: { conversationId: string } }).parked.conversationId;
    return { occurrence, job, seen, delivered, worker, conversationId };
  };

  it('a mission that asks parks on the question; the owner is notified with the choices; the answer resumes the run', async () => {
    const { occurrence, job, seen, delivered, worker, conversationId } = await parkedRun([
      ASK,
      { text: 'Renew for one year or three?' },
      { tool: 'mission.report', input: { urgency: 'normal', text: 'Renewed withbuddi.com for three years.' } },
      { text: 'done' },
    ]);
    try {
      const question = await openQuestion(pool, { conversationId, now: new Date() });
      expect(question?.question).toBe(QUESTION);
      expect(question?.options.map((o) => o.label)).toEqual(['One year', 'Three years']);
      expect((await getJob(pool, job.id))?.suspendedReason).toBe(`${PARKED_REASON_PREFIX}${question!.id}`);
      // It reaches the owner (Telegram draws the card's choices as buttons), and Needs you holds it past fifteen minutes.
      const { rows } = await pool.query<{ kind: string; title: string; text: string; dedupe_key: string }>(
        `select kind, title, text, dedupe_key from core.owner_notifications`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'question', title: `Renewal: ${QUESTION}`, dedupe_key: `question:${question!.id}` });
      expect(rows[0]!.text).not.toMatch(/browser/);
      expect((await readAgentAttention(pool, new Date(Date.now() + 20 * 60_000))).agents.find((a) => a.agentId === AGENT)?.question?.conversationId).toBe(conversationId);
      expect(delivered).toEqual([]);

      const option = question!.options.find((o) => o.label === 'Three years')!;
      const settled = await answerQuestion(pool, { id: question!.id, answer: option.label, optionId: option.id, via: 'telegram', now: new Date() });
      if (!settled.ok) throw new Error(`answer refused: ${settled.reason}`);
      expect(await resumeParkedForQuestion(pool, settled.question)).toBe(true);

      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(delivered).toEqual(['Renewed withbuddi.com for three years.']);
      expect((await getOccurrence(pool, occurrence.id))?.state).toBe('succeeded');
      const turns = seen.flatMap((req) => req.messages).flatMap((m) => (typeof m.content === 'string'
        ? [m.content]
        : (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '')));
      expect(turns.some((t) => t.includes(`The owner answered your card "${QUESTION}": Three years.`))).toBe(true);
      expect(turns.some((t) => t.includes('the page is as you left it'))).toBe(false);
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it('unanswered past the parking time, the run ends with the "needed you" line', async () => {
    const { occurrence, job, delivered, worker } = await parkedRun([ASK, { text: 'Renew for one year or three?' }]);
    try {
      expect(await expireParkedRuns(pool, new Date())).toBe(0);
      expect(await expireParkedRuns(pool, new Date(Date.now() + 61 * 60_000))).toBe(1);
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(delivered).toEqual([
        `Renewal needed you and stopped: "${QUESTION}" No answer came within an hour, so it ended there. Run it again from Missions when you can take a look.`,
      ]);
      expect((await getOccurrence(pool, occurrence.id))?.state).toBe('succeeded');
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it('asked twice in one turn, it parks on the first and drops the second with a log line', async () => {
    const m = await mission();
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const seen: CompletionRequest[] = [];
    const twice: CompletionResponse = {
      content: [
        { type: 'tool_use', id: 'tu-a', name: 'conversation.ask', input: { question: 'First question?' } },
        { type: 'tool_use', id: 'tu-b', name: 'conversation.ask', input: { question: 'Second question?' } },
      ],
      stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'claude-test',
    };
    let n = 0;
    const provider: RuntimeProvider = {
      async complete(req) {
        seen.push(req);
        return n++ === 0 ? twice : { content: [{ type: 'text', text: 'Waiting.' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' };
      },
    };
    const result = await createMissionExecutor({
      pool, registry, catalog: catalog(), provider, ctx, env: ENV, now: () => new Date(),
      deliver: async () => 'chat-1', log: (line) => { logs.push(line); },
    })(occurrence, m);
    expect(result.parked?.question).toBe('First question?');
    const { rows } = await pool.query(`select question from core.questions`);
    expect(rows).toEqual([{ question: 'First question?' }]);

    // A second question that does land on the run's sink (a browser card after the run asked) is dropped and logged.
    const dropped: string[] = [];
    const sink = firstQuestionSink((question) => dropped.push(question));
    sink.asked = { question: 'First question?', options: [], allowOther: true };
    sink.asked = { question: 'Second question?', options: [], allowOther: true };
    expect(sink.asked?.question).toBe('First question?');
    expect(dropped).toEqual(['Second question?']);
  });

  describe('a stuck watcher does not interrupt the owner every run', () => {
    const runOnce = async (steps: Step[], delivered: string[] = []) => {
      const m = await mission();
      const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
      return executor(steps, [], delivered)(occurrence, m);
    };
    const notifications = async () => (await pool.query<{ kind: string; urgency: string; state: string; title: string }>(
      `select kind, urgency, state, title from core.owner_notifications order by created_at`,
    )).rows;

    it('one open question per mission: a second run that asks while the first card waits is held back, quietly', async () => {
      const first = await runOnce([ASK, { text: 'Waiting.' }]);
      expect(first.parked?.question).toBe(QUESTION);
      const second = await runOnce([{ tool: 'conversation.ask', input: { question: 'Something else entirely?' } }, { text: 'Waiting.' }]);
      expect(second).toMatchObject({ decision: 'no-decision', delivered: false, reason: 'question-open' });
      expect(second.parked).toBeUndefined();
      expect((await pool.query(`select question from core.questions`)).rows).toEqual([{ question: QUESTION }]);
      // The card reached the owner once; the held-back one is a quiet line on Needs you, stored, never pushed.
      expect(await notifications()).toEqual([
        expect.objectContaining({ kind: 'question', urgency: 'now' }),
        expect.objectContaining({ kind: 'watcher', urgency: 'digest', state: 'stored', title: 'Renewal needed you' }),
      ]);
      expect(logs.some((line) => line.includes('question held back (open)'))).toBe(true);
    });

    it('the same unanswered question within a day is not asked again', async () => {
      const first = await runOnce([ASK, { text: 'Waiting.' }]);
      // Nobody answered: the parking time ran out and the card closed.
      await pool.query(`update core.questions set answered_at = now(), answered_via = 'timeout' where id = $1::uuid`, [first.parked!.questionId]);
      const again = await runOnce([ASK, { text: 'Waiting.' }]);
      expect(again).toMatchObject({ decision: 'no-decision', reason: 'question-repeat' });
      expect((await pool.query(`select count(*)::int as n from core.questions`)).rows[0]).toEqual({ n: 1 });
      expect((await notifications()).filter((n) => n.kind === 'question')).toHaveLength(1);
      // A question the owner did answer may be asked again.
      await pool.query(`update core.questions set answered_via = 'telegram', answer = 'One year' where id = $1::uuid`, [first.parked!.questionId]);
      expect((await runOnce([ASK, { text: 'Waiting.' }])).parked?.question).toBe(QUESTION);
    });

    it('the timeout line is folded: the same mission timing out on the same question again today says nothing more', async () => {
      const delivered: string[] = [];
      const timeOut = async () => {
        const run = await runOnce([ASK, { text: 'Waiting.' }]);
        const m = await mission();
        const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
        // The card is closed by the clock, so the next run may ask (and park) again.
        return executor([], [], delivered)(occurrence, m, { answer: { parked: run.parked!, timedOut: true } });
      };
      const first = await timeOut();
      expect(first).toMatchObject({ decision: 'needed-you', delivered: true });
      // Answered earlier today by the owner, so asking again is allowed; it times out again.
      await pool.query(`update core.questions set answered_via = 'telegram' where answered_via = 'timeout'`);
      const second = await timeOut();
      expect(second).toMatchObject({ decision: 'needed-you', delivered: false });
      expect(delivered).toHaveLength(1);
    });
  });

  it('a scheduled run is told it may ask; a /recap in an open chat is not', async () => {
    const m = await mission();
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const seen: CompletionRequest[] = [];
    await executor([{ tool: 'mission.silent', input: { reason: 'nothing new' } }, { text: 'done' }], seen, [])(occurrence, m);
    expect(JSON.stringify(seen[0]!.messages)).toContain(MISSION_ASK_LINE);
    expect(seen[0]!.tools.map((t) => t.name)).toContain('conversation.ask');

    const inline: CompletionRequest[] = [];
    const run = createInlineMissionRunner({ pool, registry, catalog: catalog(), provider: scripted([{ text: 'All renewed.' }], inline), ctx, env: ENV, now: () => new Date(), log: () => {} });
    await run(m.id, 'chat-1');
    expect(JSON.stringify(inline[0]!.messages)).not.toContain('You run while the owner is away');
    expect(inline[0]!.tools.map((t) => t.name)).not.toContain('conversation.ask');
  });
});
