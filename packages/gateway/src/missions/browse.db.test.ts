/**
 * Missions that browse (docs/browser.md, "Missions"), against a throwaway
 * database, with the real browser controller over fake page drivers.
 *
 *  - A mission whose package says `browser: own` may use browser.act with
 *    nobody there, in buddi's own browser; one that did not opt in may not.
 *  - Asked for the owner's Chrome, it is refused with the reason.
 *  - A browser moment (here a sign-in wall) parks the run on a question card:
 *    answered (as Needs you answers it), the run resumes in its conversation;
 *    unanswered past the parking time, it ends with one report line.
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
import { createBrowserManifest, HostController, type BrowserDriver, type ExtensionBridge, type Observation } from '@buddi/tool-browser';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { loadGatewayCatalog } from '../agents/catalog.js';
import { insertOccurrence } from '../missions-cli.js';
import { createMissionJobHandler, MISSION_JOB_KIND, queueOccurrence } from '../serve.js';
import { readAgentAttention } from '../web/attention.js';
import { createMissionExecutor } from './execute.js';
import { expireParkedRuns, GAVE_BACK_ANSWER, handbackQuestionId, PARKED_REASON_PREFIX, resumeParkedForPage, resumeParkedForQuestion } from './parked.js';
import type { JobHandler } from '@buddi/core';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_missions_browse_test_${process.pid}`;
const ENV = { BUDDI_TZ: 'UTC' } as NodeJS.ProcessEnv;
const AGENT = 'browser-agent';

/** One page driver: records where it went; a sign-in address looks like a sign-in page. */
function driver(name: string, log: string[]): () => BrowserDriver {
  return () => {
    let url = '';
    const page = (at: string): Partial<Observation> => at.includes('/ap/signin')
      ? { title: 'Amazon Sign-In', tree: '- textbox "Email or mobile phone number"', targets: [{ ref: 'e1', frame: 0, role: 'textbox', name: 'Email or mobile phone number' }] }
      : { title: 'Headlines', tree: '- heading "Today"' };
    return {
      start: async () => {}, close: async () => {}, screenshot: async () => undefined,
      perform: async (command) => { if (command.action === 'navigate' && command.url) { url = command.url; log.push(`${name} ${url}`); } },
      observe: async () => ({ id: `${name}-${log.length}`, url, title: 'Page', tree: '', tabs: [], capturedAt: new Date().toISOString(), ...page(url) }),
    };
  };
}
const bridge: ExtensionBridge = { connected: () => true, paired: () => true, send: async () => { throw new Error('not used'); }, close: () => {} };

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

/** The tool results the model was handed, as text. */
function toolResults(seen: CompletionRequest[]): string[] {
  const out: string[] = [];
  for (const req of seen) for (const message of req.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type: string; content?: unknown }>) {
      if (block.type === 'tool_result') out.push(JSON.stringify(block.content));
    }
  }
  return out;
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

suite('missions that browse (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  let controller: HostController;
  let registry: ToolRegistry;
  let ctx: CoreToolContext;
  const log: string[] = [];

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
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    log.length = 0;
    await pool.query('truncate core.jobs cascade');
    await pool.query('truncate core.occurrences, core.missions cascade');
    await pool.query('truncate core.questions, core.owner_notifications cascade');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-missions-browse-'));
    controller = new HostController(dir, {
      platform: 'linux', env: {},
      detect: () => ({ engine: 'chromium', executable: '/x/chrome' }),
      extensionBridge: () => bridge,
      drivers: { own: driver('own', log), chrome: driver('chrome', log) },
      service: { sleep: async () => {} },
    });
    await controller.enable();
    await controller.configure({ yourChrome: true });
    registry = new ToolRegistry();
    registry.register(memoryManifest);
    registry.register(createBrowserManifest(controller));
  });

  afterEach(async () => {
    await controller.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  const catalog = () => loadGatewayCatalog({
    dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'browsing-agents'),
    env: ENV,
    registry,
  });

  const mission = (browser: 'own' | null): Promise<Mission> => upsertMission(pool, {
    id: 'agent:browser-agent:headlines', name: 'Headlines', agentId: AGENT, prompt: 'Look at the headlines.', browser,
  });

  /** One executor over the steps given, delivering into `delivered`. */
  const executor = (steps: Step[], seen: CompletionRequest[], delivered: string[]) => createMissionExecutor({
    pool, registry, catalog: catalog(), provider: scripted(steps, seen), ctx, env: ENV, now: () => new Date(),
    deliver: async (text) => { delivered.push(text); return 'chat-1'; },
    browser: controller,
    log: () => {},
  });

  it('an opted-in mission looks at a page in the own browser, and its telemetry says mission', async () => {
    const m = await mission('own');
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const seen: CompletionRequest[] = [];
    const delivered: string[] = [];
    const result = await executor([
      { tool: 'browser.act', input: { action: 'navigate', url: 'https://news.test/' } },
      { tool: 'mission.report', input: { urgency: 'normal', text: 'Three headlines today.' } },
      { text: 'done' },
    ], seen, delivered)(occurrence, m);
    expect(result).toMatchObject({ delivered: true, decision: 'report' });
    expect(delivered).toEqual(['Three headlines today.']);
    expect(log).toEqual(['own https://news.test/']);
    expect(toolResults(seen).join('\n')).toContain('\\"route\\":\\"own\\"');
    expect(controller.telemetry.events.filter((e) => e.type === 'browser.route').every((e) => e.mission === true)).toBe(true);
  });

  it('a mission that did not opt in opens no page', async () => {
    const m = await mission(null);
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const seen: CompletionRequest[] = [];
    await executor([
      { tool: 'browser.act', input: { action: 'navigate', url: 'https://news.test/' } },
      { tool: 'mission.silent', input: { reason: 'could not look' } },
      { text: 'done' },
    ], seen, [])(occurrence, m);
    expect(log).toEqual([]);
    expect(toolResults(seen).join('\n')).toMatch(/has not opted in to browsing/);
  });

  it("asked for the owner's Chrome, a mission is refused with the reason", async () => {
    const m = await mission('own');
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const seen: CompletionRequest[] = [];
    await executor([
      { tool: 'browser.act', input: { action: 'navigate', url: 'https://shop.test/', prefer: 'yours' } },
      { tool: 'mission.silent', input: { reason: 'needs the owner' } },
      { text: 'done' },
    ], seen, [])(occurrence, m);
    expect(log).toEqual([]);
    expect(toolResults(seen).join('\n')).toMatch(/never the owner's Chrome/);
  });

  /** Run the occurrence as a queue job until it parks on the sign-in card; hands back what the test needs. */
  const parkedRun = async (after: Step[], wrap?: (handler: JobHandler) => JobHandler) => {
    const m = await mission('own');
    const occurrence = await insertOccurrence(pool, m.id, 0, new Date(), 'claimed');
    const job = await queueOccurrence(pool, occurrence, m);
    const seen: CompletionRequest[] = [];
    const delivered: string[] = [];
    const handler = createMissionJobHandler({
      pool,
      execute: executor([
        { tool: 'browser.act', input: { action: 'navigate', url: 'https://www.amazon.com/ap/signin' } },
        { text: 'Amazon needs your sign-in.' },
        ...after,
      ], seen, delivered),
      log: () => {},
    });
    const worker = runWorker({ pool, worker: 'test', kinds: [MISSION_JOB_KIND], handlers: { [MISSION_JOB_KIND]: wrap ? wrap(handler) : handler }, now: () => new Date(), pollMs: 5, leaseMs: 5_000 });
    if (!wrap) await waitFor(async () => (await getJob(pool, job.id))?.state === 'suspended');
    return { m, occurrence, job, seen, delivered, worker };
  };

  it('a sign-in parks the run on a card; answered from Needs you, the run resumes in its conversation', async () => {
    const { occurrence, job, seen, delivered, worker } = await parkedRun([
      { tool: 'mission.report', input: { urgency: 'normal', text: 'Signed in later; two orders arriving Friday.' } },
      { text: 'done' },
    ]);
    try {
      const parked = await getJob(pool, job.id);
      const conversationId = (parked?.payload as { parked?: { conversationId: string } }).parked!.conversationId;
      const question = await openQuestion(pool, { conversationId, now: new Date() });
      expect(question?.question.split('\n')[0]).toBe('Amazon needs your sign-in');
      expect(parked?.suspendedReason).toBe(`${PARKED_REASON_PREFIX}${question!.id}`);
      // It reached the owner as a notification with an action, and Needs you holds it past fifteen minutes.
      const { rows } = await pool.query(`select kind, action, dedupe_key from core.owner_notifications`);
      expect(rows).toEqual([{ kind: 'question', action: 'Amazon needs your sign-in Sign in on the page and give it back, and I carry on.', dedupe_key: `question:${question!.id}` }]);
      const later = new Date(Date.now() + 20 * 60_000);
      expect((await readAgentAttention(pool, later)).agents.find((a) => a.agentId === AGENT)?.question?.conversationId).toBe(conversationId);
      expect(delivered).toEqual([]);

      // Needs you answers the card exactly as the dashboard's question picker does.
      const option = question!.options.find((o) => o.label === 'Save a login for next time')!;
      const settled = await answerQuestion(pool, { id: question!.id, answer: option.label, optionId: option.id, via: 'web', now: new Date() });
      if (!settled.ok) throw new Error(`answer refused: ${settled.reason}`);
      expect(await resumeParkedForQuestion(pool, settled.question)).toBe(true);

      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(delivered).toEqual(['Signed in later; two orders arriving Friday.']);
      expect((await getOccurrence(pool, occurrence.id))?.state).toBe('succeeded');
      const resumedTurn = JSON.stringify(seen.map((req) => req.messages));
      expect(resumedTurn).toContain('The owner answered your card');
      expect(resumedTurn).toContain('Save a login for next time');
      expect((await readAgentAttention(pool, new Date())).agents.find((a) => a.agentId === AGENT)?.question ?? null).toBeNull();
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it('Take over parks the run on the page; Give it back wakes it, and it carries on from the page', async () => {
    const { occurrence, job, seen, delivered, worker } = await parkedRun([
      { tool: 'mission.report', input: { urgency: 'normal', text: 'You signed in; two orders arriving Friday.' } },
      { text: 'done' },
    ]);
    const off = controller.onGiveBack((info) => { void resumeParkedForPage(pool, info.conversationId, new Date()); });
    try {
      const conversationId = ((await getJob(pool, job.id))?.payload as { parked: { conversationId: string } }).parked.conversationId;
      const question = await openQuestion(pool, { conversationId, now: new Date() });
      const option = question!.options.find((o) => o.label === 'Take over')!;
      const settled = await answerQuestion(pool, { id: question!.id, answer: option.label, optionId: option.id, via: 'web', now: new Date() });
      if (!settled.ok) throw new Error(`answer refused: ${settled.reason}`);
      const calls = seen.length;
      expect(await resumeParkedForQuestion(pool, settled.question)).toBe(true);

      // The run wakes, hands the page to the owner and parks again, on the page: no model call, nothing delivered.
      await waitFor(async () => (await getJob(pool, job.id))?.suspendedReason === `${PARKED_REASON_PREFIX}${handbackQuestionId(conversationId)}`);
      expect(seen).toHaveLength(calls);
      expect(delivered).toEqual([]);
      const page = controller.status({ agentId: AGENT, conversationId });
      expect(page.state).toBe('paused');

      // Give it back: the run carries on in its conversation and reports.
      await controller.control('resume', page.session!.id);
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(delivered).toEqual(['You signed in; two orders arriving Friday.']);
      expect((await getOccurrence(pool, occurrence.id))?.state).toBe('succeeded');
      expect(JSON.stringify(seen.map((req) => req.messages))).toContain(GAVE_BACK_ANSWER);
    } finally {
      off();
      await worker.stop();
    }
  }, 30_000);

  it('an answer that arrives before the job has parked is kept, and wakes the job as it parks', async () => {
    const delivered: string[] = [];
    let answered = false;
    const { job, worker } = await parkedRun([
      { tool: 'mission.report', input: { urgency: 'normal', text: 'Answered early; carried on.' } },
      { text: 'done' },
    ], (handler) => async (current, jobContext) => {
      const result = await handler(current, jobContext);
      if (!answered && typeof result === 'object' && result !== null && 'suspended' in result) {
        answered = true;
        // The card is out and the owner answers it now, before the worker lands the suspension.
        const conversationId = ((await getJob(pool, current.id))?.payload as { parked: { conversationId: string } }).parked.conversationId;
        expect((await getJob(pool, current.id))?.state).toBe('leased');
        const question = await openQuestion(pool, { conversationId, now: new Date() });
        const option = question!.options.find((o) => o.label === 'Save a login for next time')!;
        const settled = await answerQuestion(pool, { id: question!.id, answer: option.label, optionId: option.id, via: 'web', now: new Date() });
        if (!settled.ok) throw new Error(`answer refused: ${settled.reason}`);
        expect(await resumeParkedForQuestion(pool, settled.question)).toBe(true);
      }
      return result;
    });
    try {
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(answered).toBe(true);
      const { rows } = await pool.query(`select kind from core.events where kind = 'job.resumed'`);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await worker.stop();
    }
    void delivered;
  }, 30_000);

  it('unanswered past the parking time, the run ends as "needed you" with one report line', async () => {
    const { occurrence, job, delivered, worker } = await parkedRun([]);
    try {
      const conversationId = ((await getJob(pool, job.id))?.payload as { parked: { conversationId: string } }).parked.conversationId;
      const question = await openQuestion(pool, { conversationId, now: new Date() });
      // Not yet: the hour is not up.
      expect(await expireParkedRuns(pool, new Date())).toBe(0);
      expect(await expireParkedRuns(pool, new Date(Date.now() + 61 * 60_000))).toBe(1);
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(/^Headlines needed you and stopped: "Amazon needs your sign-in\." No answer came within an hour/);
      expect((await getOccurrence(pool, occurrence.id))?.state).toBe('succeeded');
      // The card takes no late tap.
      const late = await answerQuestion(pool, { id: question!.id, answer: 'Take over', optionId: question!.options[0]!.id, via: 'web', now: new Date() });
      expect(late.ok).toBe(false);
      const { rows } = await pool.query(`select kind from core.events where kind = 'mission.needed_you'`);
      expect(rows).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  }, 30_000);
});
