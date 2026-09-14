/**
 * `getting-started` — the first-two-weeks arc.
 *
 * A newly installed system has to earn a habit, and it has about two weeks to
 * do it. Quiet-by-default is the right posture for month six and fatal in week
 * one: an installation that says nothing for ten days has taught its owner that
 * it does not work. So for the length of the window this mission runs daily and
 * tries to find *one* genuinely useful thing to say — and says nothing at all
 * on the days it cannot.
 *
 * Three things keep it from becoming the noise it exists to avoid:
 *
 *  - **The rule is in a skill** (`earning-attention`): every proactive message
 *    carries a fact or an offer true for this owner, found through a tool call
 *    in that run. A run that finds nothing calls `mission.silent`.
 *  - **The budget is in code** (`nudgePolicy`), not in the prompt. A model
 *    cannot hold a counter it cannot see.
 *  - **The arc ends by itself.** Fourteen days after onboarding completes the
 *    mission disables itself, so nobody has to remember that it exists.
 *
 * Like `sentinel-wake`, this is gateway infrastructure rather than a plugin's
 * suggestion — no domain owns "introduce yourself" — but its *speaker* is still
 * resolved by role: whoever claims `overview`, and the default agent only when
 * nobody does.
 */
import {
  appendEvent,
  setMissionEnabled,
  type AgentCatalog,
  type Mission,
  type Occurrence,
  type Queryable,
  type UpsertMissionInput,
} from '@buddi/core';
import type { Pool } from 'pg';
import { ROLE_OVERVIEW } from '../agents/roles.js';
import type { MissionRunControl, MissionRunResult } from './execute.js';
import {
  arcWindow,
  endsTheArc,
  nudgePolicy,
  refusalText,
  MAX_NUDGES,
  type NudgeRefusal,
  type OnboardingWindowState,
} from './nudge-policy.js';
import { readArcState, readEngagement, recordNudgeDelivered } from './nudge-state.js';

export const GETTING_STARTED_ID = 'getting-started';

/** Mid-morning in the owner's zone: after the commute, before the day closes in. */
export const GETTING_STARTED_CRON = '30 9 * * *';

export const GETTING_STARTED_PROMPT = `You are in the first two weeks of this installation. Your job today is to find ONE genuinely useful thing you can tell the owner, or to say nothing.

1. Read the owner's profile and what is actually installed here — the agents, the tools, the data that has arrived so far. Use your tools; do not assume.
2. Look for one thing that is true for THIS owner and that they do not already know: a number in their own data, a pattern in what they have given you, something you can now do for them because of what is set up.
3. If you find it, call mission.report: one short message, plain text, leading with the thing you found, ending with exactly one concrete offer they can answer in a word.
4. If you find nothing specific, call mission.silent with the one-line reason. A quiet day costs nothing. A message that says "just checking in", or that only describes what you are capable of, costs their attention and is forbidden.

Never summarise something you have already told them. Never send two things. Never ask a question with no finding in front of it.`;

/**
 * What the run is told about *its* place in the arc.
 *
 * Appended per run rather than baked into the stored prompt: "this is your
 * second message" is a fact about today, and the mission row must not pretend
 * to know it. The first two runs are steered towards demonstration because that
 * is what a new owner needs — being shown one capability working on their own
 * data teaches more than a paragraph explaining three.
 */
export function arcNote(nudgesSent: number): string {
  const lines = [
    `This is message ${nudgesSent + 1} of at most ${MAX_NUDGES} in the first-run arc.`,
  ];
  if (nudgesSent < 2) {
    lines.push(
      'Prefer teaching one capability by DEMONSTRATING it on the owner\'s own data over explaining it: run the tool, show them what it found about them, then make the offer. One capability, not a tour.',
    );
  }
  return lines.join(' ');
}

/**
 * The final message, sent exactly once, when three in a row have gone
 * unanswered. It is the one message in the arc allowed to carry no finding,
 * because its content is that there will be no more of them.
 */
export const STOPPING_TEXT = [
  "I'll stop suggesting things — you have not needed them, and that is a fine answer.",
  'I am still here when you want me: just ask, or send /status for where you stand and /help for the rest.',
].join(' ');

/**
 * The arc, bound to whoever speaks for this installation.
 *
 * `enabled` is decided by the caller, not here: `add-defaults` registers it
 * enabled only while the window is open, and disabled otherwise.
 */
export function gettingStartedMission(
  catalog: AgentCatalog,
  enabled: boolean,
): UpsertMissionInput {
  const overview = catalog.agentForRole(ROLE_OVERVIEW);
  return {
    id: GETTING_STARTED_ID,
    name: 'Getting started',
    agentId: overview.ok ? overview.agent.id : catalog.defaultAgent().id,
    prompt: GETTING_STARTED_PROMPT,
    enabled,
    // Never: the arc speaks only when it found something worth speaking about.
    alwaysDeliver: false,
  };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/** Why a run was refused, in the shape the event log and the tests read. */
export type ArcSkip =
  | { kind: 'window'; reason: string }
  | { kind: 'engagement'; reason: string }
  | { kind: 'budget'; refusal: NudgeRefusal; reason: string };

export interface ArcGateDecision {
  allow: boolean;
  skip?: ArcSkip;
  /** The arc is over: disable the mission after recording the decision. */
  disable: boolean;
  /** Send the one final message before disabling. */
  sayGoodbye: boolean;
  /** Messages already spent, for the per-run note. */
  nudgesSent: number;
}

/**
 * Should the arc run today? Pure given what it is handed — the reads happen in
 * `arcGate`, and this is the decision they feed.
 */
export function decideArc(
  input: {
    onboarding: OnboardingWindowState | null;
    engagement: 'arc' | 'quiet' | undefined;
    nudges: {
      nudgesSent: number;
      lastNudgeAt: Date | null;
      quietUntil: Date | null;
      unanswered: number;
    } | null;
  },
  now: Date,
): ArcGateDecision {
  const nudgesSent = input.nudges?.nudgesSent ?? 0;
  const base = { disable: false, sayGoodbye: false, nudgesSent };

  // The owner's standing choice outranks the window: `quiet` means permanently,
  // until they ask for the arc back.
  if (input.engagement === 'quiet') {
    return {
      ...base,
      allow: false,
      disable: true,
      skip: { kind: 'engagement', reason: 'the owner set engagement to quiet' },
    };
  }

  const window = arcWindow(input.onboarding, now);
  if (!window.open) {
    return {
      ...base,
      allow: false,
      disable: true,
      skip: { kind: 'window', reason: window.reason },
    };
  }

  const decision = nudgePolicy(
    input.nudges ?? { nudgesSent: 0, lastNudgeAt: null, quietUntil: null, unanswered: 0 },
    now,
  );
  if (!decision.allow) {
    const ends = endsTheArc(decision.reason);
    return {
      ...base,
      allow: false,
      disable: ends,
      // Only silence earns the goodbye. A spent budget is the arc finishing on
      // schedule, and "I have run out of things to say" is not worth a message.
      sayGoodbye: decision.reason === 'unanswered',
      skip: { kind: 'budget', refusal: decision.reason, reason: refusalText(decision.reason) },
    };
  }

  return { ...base, allow: true, disable: false, sayGoodbye: false };
}

/** Everything the gate reads, in one call. */
export async function arcGate(pool: Queryable, now: Date): Promise<ArcGateDecision> {
  const onboarding = await readArcState(pool);
  const engagement = await readEngagement(pool);
  return decideArc(
    {
      onboarding: onboarding
        ? {
            state: onboarding.state,
            completedAt: onboarding.completedAt,
            surface: onboarding.surface,
          }
        : null,
      engagement,
      nudges: onboarding,
    },
    now,
  );
}

export type MissionExecute = (
  occurrence: Occurrence,
  mission: Mission,
  control?: MissionRunControl,
) => Promise<MissionRunResult>;

export interface NudgeBudgetDeps {
  pool: Pool;
  now: () => Date;
  /** Sends the one final message. The mission executor's own deliver. */
  deliver: (text: string) => Promise<string>;
  log?: (line: string) => void;
  /** Injected in tests; core's `setMissionEnabled` otherwise. */
  disable?: (missionId: string) => Promise<void>;
}

/**
 * Wrap the mission executor so `getting-started` is subject to the budget and
 * nothing else is.
 *
 * The refusal happens *before* the run: a mission that is not allowed to speak
 * must not burn a model call discovering that. On the way out, a delivered
 * message is counted — and only a delivered one, so a run that found nothing
 * and called `mission.silent` costs the arc nothing.
 */
export function withNudgeBudget(execute: MissionExecute, deps: NudgeBudgetDeps): MissionExecute {
  const log = deps.log ?? ((line: string) => console.error(line));
  const disable =
    deps.disable ??
    (async (missionId: string): Promise<void> => {
      await setMissionEnabled(deps.pool, missionId, false);
    });

  return async function guarded(occurrence, mission, control): Promise<MissionRunResult> {
    if (mission.id !== GETTING_STARTED_ID) return execute(occurrence, mission, control);

    const now = deps.now();
    const gate = await arcGate(deps.pool, now);

    if (!gate.allow) {
      const skip = gate.skip as ArcSkip;
      log(`mission ${mission.id}: skipped — ${skip.reason}`);

      // The one message the arc is allowed to send without a finding: it says
      // there will be no more. Sent before the mission is disabled, and guarded
      // by the mission's own flag — an already-disabled arc has said its piece,
      // so a hand-run occurrence cannot make it say it twice.
      if (gate.sayGoodbye && mission.enabled) {
        try {
          await deps.deliver(STOPPING_TEXT);
          await appendEvent(deps.pool, 'mission.delivered', {
            missionId: mission.id,
            occurrenceId: occurrence.id,
            chars: STOPPING_TEXT.length,
            decision: 'report',
            urgency: 'normal',
            arc: 'stopping',
          });
        } catch (err) {
          log(
            `mission ${mission.id}: could not send the closing message: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await appendEvent(deps.pool, 'mission.silent', {
        missionId: mission.id,
        occurrenceId: occurrence.id,
        reason: skip.reason,
        arc: skip.kind,
        ...(skip.kind === 'budget' ? { refusal: skip.refusal } : {}),
      });

      if (gate.disable) {
        await disable(mission.id);
        log(`mission ${mission.id}: disabled — ${skip.reason}`);
        await appendEvent(deps.pool, 'mission.disabled', {
          missionId: mission.id,
          reason: skip.reason,
        });
      }

      return {
        conversationId: '',
        text: '',
        delivered: false,
        decision: 'silent',
        reason: skip.reason,
      };
    }

    // The run is told where it stands in the arc. The stored prompt stays the
    // rule; this is the one fact about today.
    const result = await execute(
      occurrence,
      { ...mission, prompt: `${mission.prompt}\n\n${arcNote(gate.nudgesSent)}` },
      control,
    );

    // Only a message that actually reached the owner spends the budget.
    if (result.delivered) await recordNudgeDelivered(deps.pool, deps.now());
    return result;
  };
}
