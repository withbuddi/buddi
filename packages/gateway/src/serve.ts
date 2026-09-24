#!/usr/bin/env node
/**
 * `buddi serve` — one process, both halves of the installation.
 *
 * The Telegram surface (inbound: the owner asks) and the scheduler runner
 * (outbound: missions deliver) share one pool, one registry and one resolved
 * provider. They are otherwise independent: the surface polls Telegram, the
 * runner materializes and drains occurrences, and a signal stops both, waiting
 * for in-flight work rather than cutting it off.
 *
 * Stale claims are released every tick: a claim older than fifteen minutes is a
 * process that died mid-run, and the occurrence goes back to `pending` rather
 * than sitting claimed forever.
 *
 * Scheduled missions do not run in the scheduler pass. The scheduler decides
 * *when* and enqueues a `mission-run` job keyed by the occurrence; a queue
 * worker in this same process claims it under a lease and runs it. That is what
 * buys bounded retries with backoff, startup recovery, durable suspension and a
 * global pause — none of which an inline call can offer. Telegram's interactive
 * turns stay inline (they are user-facing and already serialized per chat), but
 * they are gated by the same pause flag.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  collectSources,
  countJobsByState,
  enqueue,
  finishOccurrence,
  getActiveSchedule,
  getMission,
  getOccurrence,
  inRecovery,
  isPaused,
  listMissions,
  nextAfter,
  releaseStaleClaims,
  sweepLapsedOffers,
  sweepOrphanUploads,
  resumeJob,
  runScheduler,
  runSentinels,
  runSources,
  runWorker,
  collectSentinels,
  createPool,
  type Job,
  type JobHandler,
  type Mission,
  type ActionRecord,
  type Occurrence,
  type PluginManifest,
  type SourceContext,
  type Suspension,
} from '@buddi/core';
import type { Pool } from 'pg';
import { hostBrowser } from '@buddi/tool-browser';
import { hostService } from '@buddi/tool-host';
import type { ApprovalResume } from '@buddi/runtime';
import {
  DEFAULT_POLL_TIMEOUT_MS,
  ensureGmailAccount,
  POLL_TIMEOUT_VAR,
} from '@buddi/tool-email';
import { createWiringAsync, loadEnvironment } from './bootstrap.js';
import { describeDatabaseError, waitForDatabase } from './db-ready.js';
import { migrateAtStart } from './plugins/migrate.js';
import { AGENT_RUN_JOB_KIND, createAgentRunHandler, OFFER_HINT_PREFIX } from './missions/agent-run.js';
import {
  composePrepare,
  createMissionExecutor,
  type MissionExecutorDeps,
  type MissionRunControl,
  type MissionRunResult,
} from './missions/execute.js';
import { withNudgeBudget } from './missions/getting-started.js';
import { createDeadLetterWatch } from './missions/dead-letter.js';
import { createInlineMissionRunner, type InlineMissionDeps } from './missions/inline.js';
import { createDigestPrepare } from './missions/recap.js';
import { createMailWatcherPrepare } from './missions/watcher-mail.js';
import { createReminderTick } from './missions/reminders.js';
import { PROPOSAL_SWEEP_MS, adoptPluginPolicies, createProposalSweep } from './agents/learning.js';
import { LEARNING_DIGEST_ID, ensureDigestMission, runLearningDigest } from './agents/learning-digest.js';
import { startLoop } from './loop.js';
import { dashboardRouteUrl, ensureWebToken, extensionEndpoint, startWebServer, webConfig, type WebServer } from './web/index.js';
import { memoryPreambleFor, memoryPreambleForGroup } from './agents/catalog.js';
import { createCoreArtifactStore } from './telegram/attachments.js';
import { seedOwnerFromEnv } from './owner-seed.js';
import { delegateAllowlist } from './agents/delegation.js';
import { notifyOwner, ownerChatId } from './telegram/notify.js';
import { describePaired, startTelegram, type TelegramDeps } from './telegram/main.js';

/**
 * `/recap` now lives in `missions/inline.ts`, so a surface that is not this
 * process can run a mission on demand. Re-exported under its old name: every
 * caller that imported it from here still does.
 */
export { createInlineMissionRunner, type InlineMissionDeps };

/** Scheduler cadence and the age at which a claim is considered abandoned. */
export const TICK_MS = 30_000;
export const STALE_CLAIM_MS = 15 * 60_000;
/** An upload nobody sent is kept this long before the sweep takes it. */
export const ORPHAN_UPLOAD_MS = 24 * 60 * 60_000;
export const ORPHAN_SWEEP_MS = 60 * 60_000;

/**
 * The watchers and the sources run on their own loops, off the scheduler's
 * critical path. A poll that reaches the network must never be able to stop the
 * clock: a wedged IMAP call once held the whole tick, so sentinels, sources and
 * the scheduler are three independent loops that share only the pool.
 */
export const SENTINEL_TICK_MS = 30_000;
export const SOURCE_TICK_MS = 30_000;

/**
 * The part of the catalog the resolver reads: the roster, by role. Structural
 * so a test can hand it two agents instead of a loaded directory — an
 * `AgentCatalog` is one of these.
 */
export interface RoleRoster {
  agentsWithRole(role: string): readonly { id: string; availability: { ok: boolean } }[];
}

/**
 * `SentinelContext.agentForRole`, over the installation's live roster.
 *
 * A sentinel addresses a finding by role — "whoever does credit" — and this is
 * where that becomes an id. Two rules:
 *
 *  - **Roster order decides.** The first agent claiming the role wins, exactly
 *    as `AgentCatalog.agentForRole` decides it for every other surface.
 *  - **Only a runnable agent may be named.** An agent held back for a missing
 *    plugin, or bound to a provider this machine has no credential for, would
 *    take the finding and say nothing; passing it over leaves `agentId` unset
 *    and the wake mission's agent speaks instead.
 *
 * `undefined` is an answer: nobody holds the role, and the finding goes out
 * unaddressed rather than addressed to a ghost.
 */
export function sentinelAgentForRole(
  catalog: RoleRoster,
): (role: string) => string | undefined {
  return (role) => catalog.agentsWithRole(role).find((agent) => agent.availability.ok)?.id;
}

/**
 * The reminder loop. A minute is the resolution a one-off nudge deserves: the
 * owner asked to be told "on the 3rd", not "at 09:00:00 on the 3rd", and a
 * cheaper clock would mean a reminder set for 09:00 arriving at 09:29.
 */
export const REMINDER_TICK_MS = 60_000;

/**
 * The dead-letter watch. A minute is fine: the watch does not decide when to
 * speak, it only notices — the aggregation window inside it decides that.
 */
export const DEAD_LETTER_TICK_MS = 60_000;

/** The scheduler's kind: run one occurrence of a scheduled mission. */
export const MISSION_JOB_KIND = 'mission-run';

/** Every kind this process claims. A source's run is a job like any other. */
export const JOB_KINDS = [MISSION_JOB_KIND, AGENT_RUN_JOB_KIND] as const;

/** Queue worker cadence. The lease is long because a mission run is a model call. */
export const WORKER_POLL_MS = 1_000;
export const JOB_LEASE_MS = 10 * 60_000;

/** What a paused installation answers instead of running anything. */
export const PAUSED_TEXT =
  'buddi is paused. Nothing will run until you say `buddi resume`.';

/**
 * The payload a `mission-run` job carries: the occurrence it belongs to, plus —
 * once the run has stopped on a gated call — what it is waiting for and, after
 * the owner decides, the decision itself (merged in by `resumeJobForAction`).
 */
export interface MissionJobPayload {
  occurrenceId: string;
  missionId: string;
  awaiting?: { actionId: string; conversationId: string };
  approval?: ApprovalResume;
}

function missionJobPayload(payload: unknown): MissionJobPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const { occurrenceId, missionId } = p as Partial<MissionJobPayload>;
  if (typeof occurrenceId !== 'string' || typeof missionId !== 'string') return null;
  const awaiting =
    typeof p.awaiting === 'object' && p.awaiting !== null
      ? (p.awaiting as { actionId?: unknown; conversationId?: unknown })
      : null;
  const approval =
    typeof p.approval === 'object' && p.approval !== null
      ? (p.approval as { actionId?: unknown; state?: unknown })
      : null;
  return {
    occurrenceId,
    missionId,
    ...(awaiting &&
    typeof awaiting.actionId === 'string' &&
    typeof awaiting.conversationId === 'string'
      ? { awaiting: { actionId: awaiting.actionId, conversationId: awaiting.conversationId } }
      : {}),
    ...(approval && typeof approval.actionId === 'string' && typeof approval.state === 'string'
      ? { approval: approval as unknown as ApprovalResume }
      : {}),
  };
}

/** The three shapes a loop has when it is not running at all: see `idleLoops`. */
export interface IdleLoops {
  loop: { tick: () => Promise<'skipped'>; busy: boolean; stop: () => void };
  scheduler: ReturnType<typeof runScheduler>;
  worker: ReturnType<typeof runWorker>;
}

/**
 * The stand-ins recovery mode starts instead of the real loops.
 *
 * `done` is what `main` waits on, and ending that wait ends the pool. Stand-ins
 * whose `done` was already resolved made `main` fall straight through to
 * `pool.end()` while the dashboard server kept the process alive: the restored
 * installation then answered 500 on every route that reads the database —
 * including the recovery checklist, on the one installation it exists for. So
 * these settle on the same signal the real loops do, `stop()`, which is called
 * from shutdown and nowhere else.
 */
export function idleLoops(): IdleLoops {
  let stop = (): void => {};
  const done = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return {
    loop: { tick: async () => 'skipped' as const, busy: false, stop: () => stop() },
    scheduler: {
      tick: async () => ({ materialized: 0, executed: 0 }),
      stop: async () => stop(),
      done,
    },
    worker: {
      tick: async () => null,
      recover: async () => 0,
      stop: async () => stop(),
      done,
    },
  };
}

export interface MissionLine {
  mission: Mission;
  cron?: string;
  timezone?: string;
  next?: Date | null;
}

/** Every mission with the next instant its active schedule would fire. */
export async function describeMissions(pool: Pool, now: Date): Promise<MissionLine[]> {
  const missions = await listMissions(pool);
  const lines: MissionLine[] = [];
  for (const mission of missions) {
    const spec = await getActiveSchedule(pool, mission.id);
    if (!spec) {
      lines.push({ mission });
      continue;
    }
    lines.push({
      mission,
      cron: spec.cron,
      timezone: spec.timezone,
      next: mission.enabled ? nextAfter(spec.cron, now, spec.timezone) : null,
    });
  }
  return lines;
}

export function formatMissionLine(line: MissionLine): string {
  const { mission } = line;
  const state = mission.enabled ? '' : ' [disabled]';
  if (!line.cron) return `  ${mission.id} (${mission.agentId})${state} — no schedule`;
  const next = line.next
    ? `next ${line.next.toISOString()}`
    : mission.enabled
      ? 'next (never)'
      : 'next (disabled)';
  return `  ${mission.id} (${mission.agentId})${state} — ${line.cron} ${line.timezone} — ${next}`;
}

/**
 * Hand one due occurrence to the queue.
 *
 * The dedup key *is* the occurrence id, which is what makes the handoff safe to
 * repeat: a process that dies between claiming and running leaves the claim to
 * the stale sweep, the occurrence is claimed again, and this enqueue returns the
 * job that already exists rather than running the mission twice.
 */
export async function queueOccurrence(
  pool: Pool,
  occurrence: Occurrence,
  mission: Mission,
): Promise<Job> {
  const payload: MissionJobPayload = {
    occurrenceId: occurrence.id,
    missionId: mission.id,
  };
  return enqueue(pool, {
    kind: MISSION_JOB_KIND,
    payload,
    dedupKey: occurrence.id,
  });
}

/**
 * The learning digest runs on the mission scheduler but is not an agent run:
 * its occurrence is answered by `runLearningDigest`, and every other mission
 * goes to the executor it was given.
 */
export function withLearningDigest(
  execute: (occurrence: Occurrence, mission: Mission, control?: MissionRunControl) => Promise<MissionRunResult>,
  deps: {
    pool: Pool;
    now: () => Date;
    manifests: () => readonly PluginManifest[];
    proposalsUrl: string;
    deliver: (text: string) => Promise<unknown>;
    log?: (line: string) => void;
  },
): (occurrence: Occurrence, mission: Mission, control?: MissionRunControl) => Promise<MissionRunResult> {
  return async (occurrence, mission, control) => {
    if (mission.id !== LEARNING_DIGEST_ID) return execute(occurrence, mission, control);
    const result = await runLearningDigest({
      pool: deps.pool,
      now: deps.now(),
      manifests: deps.manifests(),
      proposalsUrl: deps.proposalsUrl,
      deliver: deps.deliver,
    });
    deps.log?.(`learning digest: ${result.delivered ? 'sent' : result.skipped ?? 'not sent'}`);
    return {
      conversationId: '',
      text: result.text,
      delivered: result.delivered,
      decision: result.delivered ? 'report' : 'silent',
      ...(result.skipped ? { reason: result.skipped } : {}),
    };
  };
}

/**
 * The `mission-run` handler: the mission executor, plus closing the occurrence.
 *
 * The occurrence is *this* handler's to finish — the scheduler only decided the
 * instant. A failure is left open until the job has spent its attempts, so a
 * retry finds the occurrence still claimed and runs it again; once the budget is
 * gone the occurrence is marked failed and stays that way for `buddi jobs`.
 */
export function createMissionJobHandler(deps: {
  pool: Pool;
  execute: (
    occurrence: Occurrence,
    mission: Mission,
    control?: MissionRunControl,
  ) => Promise<MissionRunResult>;
  log?: (line: string) => void;
}): JobHandler {
  const log = deps.log ?? ((line: string) => console.log(line));
  return async function handle(job, jobContext): Promise<unknown> {
    jobContext.signal?.throwIfAborted();
    const payload = missionJobPayload(job.payload);
    if (!payload) throw new Error(`mission-run job ${job.id}: payload is not an occurrence`);

    const occurrence = await getOccurrence(deps.pool, payload.occurrenceId);
    if (!occurrence) return { skipped: 'occurrence no longer exists' };
    // Already closed out — a duplicate delivery of the same job is a no-op,
    // never a second run of the mission.
    if (occurrence.state !== 'claimed') return { skipped: `occurrence is ${occurrence.state}` };

    const mission = await getMission(deps.pool, occurrence.missionId);
    if (!mission) throw new Error(`mission "${occurrence.missionId}" disappeared`);

    // A job coming back from an approval carries the decision in its payload.
    // The run continues in the conversation it suspended in; the occurrence was
    // deliberately left claimed while it waited.
    const control: MissionRunControl = {
      jobId: job.id,
      signal: jobContext.signal,
      ...(payload.approval && payload.awaiting
        ? {
            resume: {
              conversationId: payload.awaiting.conversationId,
              approval: payload.approval,
            },
          }
        : {}),
    };

    try {
      const result = await deps.execute(occurrence, mission, control);
      jobContext.signal?.throwIfAborted();

      // Stopped on a gated call: park the job, leave the occurrence claimed,
      // and record what it waits for. Nothing is held open.
      if (result.awaiting) {
        log(
          `mission ${mission.id}: suspended on action ${result.awaiting.actionId} — waiting for the owner`,
        );
        return {
          suspended: `awaiting-approval:${result.awaiting.actionId}`,
          payloadPatch: { awaiting: result.awaiting },
        } satisfies Suspension;
      }
      await finishOccurrence(deps.pool, occurrence.id, {
        state: 'succeeded',
        // A run with no conversation (the learning digest) leaves it unset.
        ...(result.conversationId ? { runConversationId: result.conversationId } : {}),
      });
      log(
        result.delivered
          ? `mission ${mission.id} delivered (${result.text.length} chars) → conversation ${result.conversationId}`
          : `mission ${mission.id} stayed silent (${result.reason ?? result.decision}) → conversation ${result.conversationId}`,
      );
      return {
        conversationId: result.conversationId,
        delivered: result.delivered,
        chars: result.text.length,
      };
    } catch (err) {
      jobContext.signal?.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= job.maxAttempts) {
        await finishOccurrence(deps.pool, occurrence.id, { state: 'failed', error: message });
      }
      throw err;
    }
  };
}

export async function main(): Promise<void> {
  await loadEnvironment();

  // The service waits for the database rather than dying on it. Under launchd's
  // KeepAlive an exit is an immediate restart, so a stopped Docker used to turn
  // into a crash loop and, once throttled, a job "loaded but not running".
  // Waiting here costs nothing and makes the installation self-healing: the
  // first probe after Docker comes up connects and serve starts.
  await waitForDatabase({ databaseUrl: process.env.DATABASE_URL });

  /*
   * Migrations, before anything is built on the schema they change.
   *
   * The packaged installation has always done this — the supervisor migrates
   * and then spawns the gateway — and a checkout used to be the one place
   * where `serve` would happily come up on last month's schema because the
   * owner forgot `buddi migrate` after a pull. Same function, same order, same
   * meanings: the "newer than this code" refusal first, then core and the
   * compiled-in plugins (a failure here stops the start), then the installed
   * third-party ones (a failure there demotes that plugin to the load report
   * and the start continues).
   *
   * Its own pool, ended here: `createWiringAsync` below reads tables this may
   * have just created, so it must not be the thing that opens them.
   */
  const migrationPool = createPool(process.env.DATABASE_URL as string);
  try {
    await migrateAtStart(migrationPool, process.env, { log: (line) => console.error(line) });
  } catch (err) {
    console.error(
      `buddi serve did not start: ${err instanceof Error ? err.message : String(err)}`,
    );
    await migrationPool.end().catch(() => {});
    process.exit(1);
  }
  await migrationPool.end().catch(() => {});

  let wiring;
  try {
    wiring = await createWiringAsync(process.env);
  } catch (err) {
    console.error(describeDatabaseError(err, process.env.DATABASE_URL));
    process.exit(1);
  }
  const { pool, now } = wiring;

  /*
   * Recovery: this installation was restored from a backup and the owner has
   * not been through the checklist yet.
   *
   * Read **once**, here, and then used to decide which loops are started at
   * all. It is deliberately not re-read on a timer: a flag the loops consulted
   * every tick would mean every loop carrying a "should I be running" branch
   * for ever, and half-started state in between. So leaving recovery is
   * finished by restarting the gateway — through the supervisor, which is what
   * `POST /api/recovery/leave` asks for once it has cleared the row. In a
   * developer checkout there is no supervisor to do that, and the loops start
   * in-process the next time `buddi serve` is started.
   */
  const recovering = await inRecovery(pool);

  /*
   * What sleeps, and what does not.
   *
   * Everything that acts on restored data without being asked: the scheduler,
   * the queue worker, the sentinel, source, reminder and dead-letter loops,
   * the stale-claim and orphan-upload sweeps, the owner seeding, and Telegram
   * — which also refuses to be started from the dashboard while this is true.
   * The two timers that remain are neither loops nor unattended: the chat
   * spinner and Telegram's typing indicator live only inside a turn the owner
   * is having, and a turn is exactly what recovery leaves working.
   */

  const idle = idleLoops();

  try {
    // "Your browser" mode drives the owner's Chrome through the dashboard's
    // own WebSocket endpoint. Handed over before `enable`, which is what
    // builds the driver for whichever mode the owner last chose.
    try { await hostBrowser(process.env, { extensionBridge: () => extensionEndpoint(process.env) }).enable(); }
    catch (error) { console.error(`host browser unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    // The mail account this installation sends and receives as, from the named
    // environment variable. Idempotent, and a no-op when none is configured —
    // an installation with no mailbox is a valid, running one.
    const account = await ensureGmailAccount(pool, process.env);

    const missionDeps = {
      pool,
      registry: wiring.registry,
      catalog: wiring.catalog,
      provider: wiring.provider,
      providerFor: wiring.providerFor,
      ctx: wiring.ctx,
      env: process.env,
      now,
    };

    // One gate, two callers: an interactive turn and `/recap` both refuse while
    // the installation is paused, and say so in one sentence.
    const gate = async (): Promise<string | null> => ((await isPaused(pool)) ? PAUSED_TEXT : null);

    const inlineMission = createInlineMissionRunner(missionDeps);
    /** Bound once the dashboard is up; a group decided in Telegram resumes there. */
    let dashboardChat: import('./web/chat.js').WebChat | undefined;
    const telegramOptions: TelegramDeps = {
      ...missionDeps,
      gate,
      resumeGroup: async (action, resume) => {
        if (!dashboardChat) return false;
        dashboardChat.resumeHost({ agentId: action.agentId, conversationId: action.conversationId, tool: action.tool }, resume);
        return true;
      },
      // The queue this process runs. An approval decided in a chat wakes the
      // suspended run through exactly this, and through nothing else.
      jobs: { resumeJob },
      // A tapped offer starts an ordinary agent run — the same job kind a
      // source or a reminder originates, with the prompt the agent wrote for
      // its own future self. It grants nothing: the run's tools, tiers and
      // approvals are exactly what they were.
      takeOffer: async (offer) => {
        const job = await enqueue(pool, {
          kind: AGENT_RUN_JOB_KIND,
          payload: { agentId: offer.agentId, prompt: offer.prompt, conversationHint: `${OFFER_HINT_PREFIX}${offer.id}` },
          dedupKey: `offer:${offer.id}`,
        });
        console.log(`offer taken: @${offer.agentId} job ${job.id} (${offer.label})`);
        return job.id;
      },
      runMission: async (missionId, chatId, onToolCall) => {
        const blocked = await gate();
        if (blocked !== null) return { ok: true, text: blocked };
        return inlineMission(missionId, chatId, onToolCall);
      },
    };
    /*
     * The Telegram surface, when there is a token for it.
     *
     * `let`, because the token may arrive later: the owner pastes it into the
     * dashboard during first run, and `startTelegramNow` brings the surface up
     * in this process rather than asking them to restart anything. Everything
     * that holds this binding — the approval path, the shutdown — reads it
     * when it runs, so they all see the surface the moment it exists.
     */
    let telegram = !recovering && process.env.TELEGRAM_BOT_TOKEN?.trim() ? await startTelegram(telegramOptions) : undefined;
    let starting: Promise<{ botUsername: string | null }> | undefined;
    const startTelegramNow = async (): Promise<{ botUsername: string | null; refused?: string }> => {
      // The whole point of recovery is that nothing this installation was told
      // to do last week happens before the owner has said it still applies,
      // and a bot answering messages is the loudest of those. The token is
      // kept either way; the surface comes up on the restart that leaves.
      if (recovering) {
        return {
          botUsername: null,
          refused:
            'Your token is saved. Telegram stays quiet until you finish the restore checklist on Settings, and starts on its own after that.',
        };
      }
      if (telegram) return { botUsername: telegram.botUsername ?? null };
      starting ??= (async () => {
        const handle = await startTelegram(telegramOptions);
        telegram = handle;
        console.log(`  telegram: @${handle.botUsername ?? '(unknown)'} started from the dashboard`);
        return { botUsername: handle.botUsername ?? null };
      })().finally(() => { starting = undefined; });
      return starting;
    };

    // An unattended run has no chat of its own. When one proposes a gated
    // effect, the request is posted to the paired owner chat on its behalf —
    // same preview, same buttons, same bound action as an interactive turn.
    const askApproval = async (action: ActionRecord): Promise<void> => {
      const chatId = await ownerChatId(pool);
      if (!chatId || !telegram) {
        console.error(
          `approval ${action.id} (${action.tool}) is waiting in the dashboard; ${!telegram ? 'Telegram is not configured' : 'no owner chat is paired'}`,
        );
        return;
      }
      await telegram.approvals.request(chatId, action);
    };

    // The first-run arc is the only mission that speaks without being asked
    // *and* without having been asked for, so it is the only one wrapped in a
    // budget. The wrapper refuses before the run — a message that is not
    // allowed to be sent must not cost a model call to discover that — and
    // counts only what actually reached the owner.
    const execute = withNudgeBudget(
      createMissionExecutor({
        ...missionDeps,
        deliver: (text, offers) => notifyOwner(text, { pool, env: process.env, ...(offers ? { offers } : {}) }),
        // Two, composed: the weekly digest on the recap, and the conversation
        // a mail watcher's finding is about on a wake run (docs/specs/email.md §7).
        prepare: composePrepare(createDigestPrepare(pool, { now }), createMailWatcherPrepare(pool)),
        askApproval,
      }),
      {
        pool,
        now,
        deliver: (text: string) => notifyOwner(text, { pool, env: process.env }),
        log: (line) => console.error(line),
      },
    );

    // The watchers. They run on their own loop: a sentinel that reads a plugin's
    // schema is usually fast, but "usually fast" is not a scheduling guarantee,
    // and a slow one must not delay materialization. A finding it enqueues is
    // claimed by the very next scheduler pass, seconds later.
    const sentinels = collectSentinels(wiring.registry.manifests());
    const sentinelTick = async (): Promise<void> => {
      const outcomes = await runSentinels(
        pool,
        wiring.registry.manifests(),
        now(),
        wiring.timezone,
        // The catalog is a façade, so this reads the roster as it stands on
        // this tick: an agent given the role at lunchtime speaks this
        // afternoon, with no restart.
        sentinelAgentForRole(wiring.catalog),
        // The same owner every other part of this process runs as: core's
        // goal watcher builds a ToolContext from it to measure a metric.
        wiring.ctx.ownerId,
      );
      for (const outcome of outcomes) {
        if (!outcome.ran) continue;
        if (outcome.error) {
          console.error(`sentinel ${outcome.sentinelId}: ${outcome.error}`);
          continue;
        }
        if (outcome.fired > 0 || outcome.resolved > 0) {
          console.log(
            `sentinel ${outcome.sentinelId}: ${outcome.findings} finding(s), ${outcome.fired} fired, ${outcome.resolved} resolved`,
          );
        }
      }
    };

    // The sources. A source originates work with no agent in the loop: it polls
    // the world, and every run it wants becomes a queue job keyed by the dedup
    // key the source chose — so a poll that crashes after its own commit but
    // before enqueueing re-enqueues the same key next time and creates nothing
    // new. Core decides only *when* a source is due (core.source_runs).
    const sources = collectSources(wiring.registry.manifests());
    const enqueueRun: SourceContext['enqueueRun'] = async (input) => {
      const job = await enqueue(pool, {
        kind: AGENT_RUN_JOB_KIND,
        payload: {
          agentId: input.agentId,
          prompt: input.prompt,
          ...(input.conversationHint ? { conversationHint: input.conversationHint } : {}),
        },
        dedupKey: input.dedupKey,
      });
      console.log(`source run queued: @${input.agentId} job ${job.id} (${input.dedupKey})`);
    };
    // A source's own per-call deadline bounds one poll; the loop's hard abort is
    // twice that, so the loop only ever intervenes when a source failed to.
    const sourcePollTimeoutMs = (() => {
      const raw = process.env[POLL_TIMEOUT_VAR]?.trim();
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_POLL_TIMEOUT_MS;
    })();
    const sourceAbortMs = sourcePollTimeoutMs * 2;
    const sourceTick = async (): Promise<void> => {
      const outcomes = await runSources(pool, wiring.registry.manifests(), {
        now: now(),
        timezone: wiring.timezone,
        enqueueRun,
        log: (line) => console.log(line),
      });
      for (const outcome of outcomes) {
        if (outcome.error) console.error(`source ${outcome.sourceId}: ${outcome.error}`);
      }
    };

    // Reminders. An agent promised the owner a nudge; this is the clock that
    // keeps the promise. Firing enqueues an ordinary agent run — the same job
    // kind a source originates — whose prompt says "check first, then speak or
    // stay silent", so a reminder never delivers a fact that stopped being true.
    const reminderTick = createReminderTick({
      pool,
      now,
      timezone: wiring.timezone,
      enqueueRun: async (input) => {
        const job = await enqueue(pool, {
          kind: AGENT_RUN_JOB_KIND,
          payload: { agentId: input.agentId, prompt: input.prompt },
          dedupKey: input.dedupKey,
        });
        console.log(`reminder run queued: @${input.agentId} job ${job.id} (${input.dedupKey})`);
      },
      log: (line) => console.log(line),
    });

    const sweepStaleClaims = async (): Promise<void> => {
      const released = await releaseStaleClaims(pool, new Date(now().getTime() - STALE_CLAIM_MS));
      if (released > 0) console.error(`scheduler: released ${released} stale claim(s)`);
    };
    if (!recovering) await sweepStaleClaims();
    const sweep = setInterval(() => {
      if (recovering) return;
      void sweepStaleClaims().catch((err) =>
        console.error(`scheduler: stale-claim sweep failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, TICK_MS);
    if (typeof sweep.unref === 'function') sweep.unref();

    // What `buddi init` asked and wrote to the env file lands in the owner row,
    // once, and only into fields nothing has filled yet: the row is the
    // truth the agents read, and an answer given at install is not lost.
    // Not in recovery: the owner row that just came back is the restored
    // installation's own answer, and an env file that was written for *this*
    // machine's install would quietly overwrite the empty fields in it before
    // the owner has seen the checklist. It is seeded on the restart that
    // leaves recovery instead.
    if (!recovering) {
      await seedOwnerFromEnv(pool, process.env).catch((err) =>
        console.error(`owner: seeding from the environment failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    /*
     * Offers whose moment passed while nothing was running.
     *
     * The dashboard lapses them on every read, which is enough for anyone
     * looking at it and no use at all to Telegram: a button in a chat is drawn
     * once and sits there, so an owner who never opens the dashboard would tap
     * something from a conversation three rollovers ago. One sweep at start
     * catches everything that went stale while the process was down, and after
     * that the reads and the rollover path keep up on their own. No scheduler:
     * an offer lapsing an hour late costs nothing, and a timer that has to be
     * right forever costs plenty.
     *
     * The roster goes in so an offer from an agent the owner has since removed
     * lapses too, rather than sitting there with nobody to take it.
     */
    void sweepLapsedOffers(pool, { now: now(), agentIds: wiring.catalog.list().map((a) => a.id) })
      .then((lapsed) => {
        if (lapsed > 0) console.error(`offers: ${lapsed} offer(s) had lapsed and are off the table`);
      })
      .catch((err) => console.error(`offers: the lapse sweep failed: ${err instanceof Error ? err.message : String(err)}`));

    // Uploads the dashboard stored eagerly and nobody sent: tombstoned once a
    // day old, at start and then hourly. Anything a message carries is kept.
    const sweepOrphans = async (): Promise<void> => {
      const gone = await sweepOrphanUploads(pool, { surface: 'web', olderThan: new Date(now().getTime() - ORPHAN_UPLOAD_MS), at: now() });
      if (gone > 0) console.error(`artifacts: discarded ${gone} unsent upload(s)`);
    };
    // In recovery this would tombstone uploads that came back in the archive
    // and are a day old by definition, before the owner has looked at any of
    // them. Every sweep sleeps until the checklist is done.
    if (!recovering) void sweepOrphans().catch((err) => console.error(`artifacts: orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`));
    const orphanSweep = setInterval(() => {
      if (recovering) return;
      void sweepOrphans().catch((err) => console.error(`artifacts: orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`));
    }, ORPHAN_SWEEP_MS);
    if (typeof orphanSweep.unref === 'function') orphanSweep.unref();

    // The queue worker is what actually runs a mission. The scheduler decides
    // *when* and hands the occurrence over; the run itself is a durable job with
    // a lease, bounded retries and a failed-job inspection path — so a restart
    // mid-mission resumes instead of losing the work, and a mission that throws
    // does not take the scheduler pass down with it.
    const worker = recovering ? idle.worker : runWorker({
      pool,
      worker: `serve:${process.pid}`,
      kinds: JOB_KINDS,
      handlers: {
        [MISSION_JOB_KIND]: createMissionJobHandler({ pool, execute: withLearningDigest(execute, {
          pool,
          now,
          manifests: () => wiring.registry.manifests(),
          proposalsUrl: dashboardRouteUrl(webConfig(process.env), '#/settings/proposals'),
          deliver: (text: string) => notifyOwner(text, { pool, env: process.env }),
          log: (line) => console.log(line),
        }) }),
        // A source's run. Same lease, same retries, same suspension on an
        // approval — the only difference is that nothing scheduled it.
        [AGENT_RUN_JOB_KIND]: createAgentRunHandler({
          pool,
          registry: wiring.registry,
          catalog: wiring.catalog,
          provider: wiring.provider,
          providerFor: wiring.providerFor,
          ctx: wiring.ctx,
          now,
          deliver: (text, offers) => notifyOwner(text, { pool, env: process.env, ...(offers ? { offers } : {}) }),
          askApproval,
        }),
      },
      now,
      pollMs: WORKER_POLL_MS,
      leaseMs: JOB_LEASE_MS,
      onError: (err, job) =>
        console.error(
          `worker${job ? ` job ${job.id} (${job.kind})` : ''}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    });

    // Two independent loops, neither of them on the scheduler's critical path.
    // Non-overlapping: a tick that lands while the previous poll is still
    // running says so and skips, and a poll still going at 2x the deadline is
    // abandoned so the next one starts clean.
    const sentinelLoop = recovering ? idle.loop : startLoop({
      name: 'sentinels',
      everyMs: SENTINEL_TICK_MS,
      abortAfterMs: SENTINEL_TICK_MS * 2,
      run: sentinelTick,
      log: (line) => console.error(line),
    });
    const sourceLoop = recovering ? idle.loop : startLoop({
      name: 'sources',
      everyMs: SOURCE_TICK_MS,
      abortAfterMs: sourceAbortMs,
      run: sourceTick,
      log: (line) => console.error(line),
    });

    const reminderLoop = recovering ? idle.loop : startLoop({
      name: 'reminders',
      everyMs: REMINDER_TICK_MS,
      abortAfterMs: REMINDER_TICK_MS * 2,
      run: async () => {
        await reminderTick();
      },
      log: (line) => console.error(line),
    });

    // Work that died and will not be retried must reach the owner. Its own
    // loop, off the scheduler's critical path, and it delivers down the same
    // path a mission report takes rather than inventing a second one.
    const deadLetterTick = createDeadLetterWatch({
      pool,
      now,
      timezone: wiring.timezone,
      deliver: (text: string) => notifyOwner(text, { pool, env: process.env }),
      log: (line) => console.error(line),
    });
    const deadLetterLoop = recovering ? idle.loop : startLoop({
      name: 'dead-letter',
      everyMs: DEAD_LETTER_TICK_MS,
      abortAfterMs: DEAD_LETTER_TICK_MS * 2,
      run: async () => {
        const outcome = await deadLetterTick();
        if (outcome.reported) console.error('dead-letter: told the owner about a wave of dead jobs');
      },
      log: (line) => console.error(line),
    });

    // Proposals nobody decided in 30 days are expired, each with a line in
    // Activity. Hourly: the clock is a month long.
    const proposalSweep = createProposalSweep({ pool, now, log: (line) => console.log(line) });
    // The weekly learning digest is a mission of its own; the owner moves its
    // day and hour on Settings → Proposals, and that schedule is kept.
    if (!recovering) {
      await ensureDigestMission(pool, wiring.timezone).catch((err) =>
        console.error(`learning digest: not scheduled: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // A plugin's rules proposed before they came through core move here once.
    if (!recovering) await adoptPluginPolicies(pool, wiring.registry.manifests(), now(), (line) => console.log(line));
    const proposalLoop = recovering ? idle.loop : startLoop({
      name: 'proposals',
      everyMs: PROPOSAL_SWEEP_MS,
      abortAfterMs: PROPOSAL_SWEEP_MS,
      run: async () => {
        await proposalSweep();
      },
      log: (line) => console.error(line),
    });

    const scheduler = recovering ? idle.scheduler : runScheduler({
      pool,
      now,
      tickMs: TICK_MS,
      execute: async (occurrence, mission) => {
        const job = await queueOccurrence(pool, occurrence, mission);
        console.log(`mission ${mission.id}: occurrence ${occurrence.id} queued as job ${job.id}`);
        // The job owns the occurrence from here; the runner must not close it.
        return { deferred: true };
      },
      onError: (err) =>
        console.error(`scheduler: ${err instanceof Error ? err.message : String(err)}`),
    });

    // The dashboard. One block, and the only thing `serve` knows about the web
    // surface: a read-first view over the event log that reuses core's own
    // functions for the handful of writes it offers. Bound to loopback by
    // default (BUDDI_WEB_HOST/BUDDI_WEB_PORT), off with BUDDI_WEB=0. A port
    // already in use costs the dashboard, never the installation.
    const web = webConfig(process.env);
    let dashboard: WebServer | undefined;
    if (web.enabled) {
      try {
        const { token, source, created } = await ensureWebToken({ env: process.env });
        dashboard = await startWebServer({
          pool,
          registry: wiring.registry,
          catalog: wiring.catalog,
          ctx: wiring.ctx,
          timezone: wiring.timezone,
          now,
          config: web,
          token,
          env: process.env,
          providerSettings: wiring.providerSettings,
          providerAccounts: wiring.providerAccounts,
          // The owner can hand this process a bot token from the dashboard and
          // have their phone working before they put it down.
          telegram: {
            running: () => telegram !== undefined,
            start: startTelegramNow,
            botUsername: () => telegram?.botUsername ?? null,
            pictureChanged: () => telegram?.syncProfilePhoto(),
          },
          jobs: { resumeJob },
          // A write asked for through `buddi mcp` raises its card on Telegram
          // too, through the same hook an unattended run's approval uses.
          askApproval,
          // The browser as a talking surface. Every one of these is the object
          // the other surfaces already use — the per-agent provider adapter,
          // the shared artifact store, the memory hook, and the same pause gate
          // an interactive Telegram turn passes through. There is no web-shaped
          // copy of any of them.
          chat: {
            providerFor: wiring.providerFor,
            artifacts: createCoreArtifactStore({ pool, env: process.env }),
            memoryPreamble: memoryPreambleFor(pool),
            groupMemoryPreamble: memoryPreambleForGroup(pool),
            allowlistFor: (agentId) => delegateAllowlist(agentId, wiring.catalog),
            gate,
          },
          log: (line) => console.error(line),
        });
        dashboardChat = dashboard.chat;
        console.log(
          `  dashboard: ${dashboard.url} (token in the ${source}${created ? ', created now' : ''}) — \`buddi dashboard\` opens it`,
        );
      } catch (err) {
        console.error(
          `dashboard not started: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (process.env.BUDDI_WEB_REQUIRE_AUTH === '1') {
          clearInterval(sweep); clearInterval(orphanSweep);
          sentinelLoop.stop(); sourceLoop.stop(); reminderLoop.stop(); deadLetterLoop.stop(); proposalLoop.stop();
          await Promise.all([scheduler.stop(), worker.stop(), telegram?.stop()]);
          throw err;
        }
      }
    } else {
      console.log('  dashboard: off (BUDDI_WEB=0)');
    }

    const missions = await describeMissions(pool, now());

    console.log('buddi serve — telegram surface + scheduler');
    if (recovering) {
      console.log(
        '  RECOVERY — this buddi was restored from a backup. The scheduler, the queue worker, ' +
          'the sentinels, the sources, the reminders and Telegram are all off until the checklist ' +
          'on Settings is done. Chat and the dashboard work as usual.',
      );
    }
    console.log(telegram ? `  bot: @${telegram.botUsername ?? '(unknown)'} (id ${telegram.botId})` : '  Telegram: not configured');
    console.log(`  paired owner ids: ${telegram ? describePaired(telegram.paired) : '(none)'}`);
    console.log(`  model: ${wiring.model} (${wiring.credentialKind})`);
    console.log(`  scheduler: tick ${TICK_MS / 1000}s, stale claims released after ${STALE_CLAIM_MS / 60_000}m`);
    console.log(
      `  loops: sentinels every ${SENTINEL_TICK_MS / 1000}s, sources every ${SOURCE_TICK_MS / 1000}s, ` +
        `reminders every ${REMINDER_TICK_MS / 1000}s ` +
        `(independent of the scheduler; source poll deadline ${sourcePollTimeoutMs / 1000}s)`,
    );
    const jobCounts = await countJobsByState(pool);
    console.log(
      `  queue: worker for ${JOB_KINDS.join(', ')}, lease ${JOB_LEASE_MS / 60_000}m — ` +
        `${jobCounts.pending} pending, ${jobCounts.suspended} suspended, ${jobCounts.failed} failed`,
    );
    console.log(`  mail account: ${account ? account.address : 'none configured (GMAIL_USER unset)'}`);
    if (await isPaused(pool)) {
      console.log('  PAUSED — nothing will run until `buddi resume`');
    }
    console.log(
      sentinels.length === 0
        ? '  sentinels: none installed'
        : `  sentinels (${sentinels.length}): ${sentinels
            .map((s) => `${s.id} every ${s.every}s`)
            .join(', ')}`,
    );
    console.log(
      sources.length === 0
        ? '  sources: none installed'
        : `  sources (${sources.length}): ${sources
            .map((src) => `${src.id} every ${src.every}s`)
            .join(', ')}`,
    );
    console.log(
      missions.length === 0
        ? '  missions: none registered (pnpm missions add-friday-recap)'
        : `  missions (${missions.length}):`,
    );
    for (const line of missions) console.log(formatMissionLine(line));
    console.log(`  last cursor: ${telegram?.cursor ?? '(none)'}`);

    let stopping = false;
    /**
     * The dashboard's own close, kept so the pool outlives it.
     *
     * `close()` stops new connections but lets the ones already open finish,
     * and a request finishing needs the pool that the `finally` below is about
     * to end. Awaited after the loops, so a request in flight when the signal
     * arrives is answered rather than told the pool has been ended.
     */
    let closingDashboard: Promise<void> | undefined;
    const shutdown = (signal: string): void => {
      hostService(process.env).stop(wiring.ctx.ownerId);
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping scheduler and telegram surface…`);
      clearInterval(sweep);
      sentinelLoop.stop();
      sourceLoop.stop();
      reminderLoop.stop();
      deadLetterLoop.stop();
      proposalLoop.stop();
      closingDashboard = dashboard?.close();
      closingDashboard?.catch(() => {});
      void hostBrowser(process.env).shutdown();
      void Promise.all([scheduler.stop(), worker.stop(), telegram?.stop()]);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await Promise.all([telegram?.done, scheduler.done, worker.done]);
    await closingDashboard?.catch(() => {});
    console.log('buddi serve stopped cleanly');
  } finally {
    await hostBrowser(process.env).shutdown();
    await pool.end();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    // Never a bare `AggregateError:` — that is the message this whole path exists
    // to replace.
    console.error(describeDatabaseError(err, process.env.DATABASE_URL));
    process.exit(1);
  });
}
