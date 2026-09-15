/**
 * The notify policy, expressed as two tools.
 *
 * A scheduled run has nobody at the keyboard, and a notification the owner did
 * not ask for is a cost. So an unattended run does not get to "answer": it gets
 * to *decide*, and it decides by calling a tool.
 *
 *   mission.report {urgency, text}   deliver this text, and only this text
 *   mission.silent {reason}          say nothing; the reason is logged
 *
 * The delivered text is the tool's argument, never the model's free-form prose:
 * the thing the owner reads is the thing the model deliberately wrote for
 * delivery. A run that calls neither is treated as silent with the reason
 * `no-decision`, and the executor logs a warning — silence is the safe default,
 * an accidental notification is not.
 *
 * These tools are registered per run (a fresh registry built from the installed
 * manifests plus this one), so nothing outside a mission run can call them and
 * two concurrent runs never share a decision.
 */
import {
  MAX_OFFERS,
  MAX_OFFER_LABEL,
  MAX_OFFER_PROMPT,
  type OfferedAction,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import { z } from 'zod';

/** Plugin family name for the mission-run tools. */
export const MISSION_PLUGIN = 'mission';

/** The longest report the owner should get from an unattended run. */
export const MAX_REPORT_CHARS = 1500;

export type MissionDecision =
  | {
      kind: 'report';
      urgency: 'urgent' | 'normal';
      text: string;
      /** The few things the owner might want to do about it. Usually empty. */
      actions: readonly OfferedAction[];
    }
  | { kind: 'silent'; reason: string };

/** Where the tools record what the run decided. One per run. */
export interface DecisionSink {
  decision?: MissionDecision;
}

const reportInput = z.object({
  urgency: z
    .enum(['urgent', 'normal'])
    .describe(
      "'urgent' means this is worth interrupting the owner for right now; 'normal' means it is the expected scheduled message.",
    ),
  text: z
    .string()
    .min(1)
    .max(MAX_REPORT_CHARS)
    .describe(
      'Exactly what the owner should read, in plain text with no markdown. This is delivered verbatim; nothing else you write in this run is sent.',
    ),
  actions: z
    .array(
      z.object({
        label: z
          .string()
          .min(1)
          .max(MAX_OFFER_LABEL)
          .describe(
            'What the owner reads on the button, in their own words: "Draft a reply", "Remind me tomorrow". Two or three words.',
          ),
        prompt: z
          .string()
          .min(1)
          .max(MAX_OFFER_PROMPT)
          .describe(
            'What you are asked when the owner taps it, written as the owner would ask you, naming the thing concretely. It starts an ordinary run of you: it authorizes nothing, and anything that leaves the machine still needs the owner\'s approval exactly as it would have.',
          ),
      }),
    )
    .max(MAX_OFFERS)
    .optional()
    .describe(
      `At most ${MAX_OFFERS} things the owner might want to do about this, offered as buttons where the surface has them and as plain words where it does not. Offer one only when it is genuinely the next move; omit this entirely when reading the message is all there is to do. Never phrase one in words taken from the message.`,
    ),
});

const silentInput = z.object({
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Why nothing needs to be sent, in one line, e.g. "projection holds, no charge due within 3 days". Recorded in the event log, not shown to the owner.',
    ),
});

export type ReportResult = { delivered: 'queued'; chars: number };
export type SilentResult = { delivered: 'none' };

export function createMissionManifest(sink: DecisionSink): PluginManifest {
  const report: ToolDefinition<z.infer<typeof reportInput>, ReportResult> = {
    name: 'mission.report',
    description:
      'Send this text to the owner as the result of this scheduled run, and finish. Call it once, with the finished message; the text you pass is exactly what is delivered. You may attach a few actions the owner can take about it — they become buttons where the surface has them and a plain list where it does not. If there is nothing worth an interruption, call mission.silent instead.',
    tier: 'auto',
    input: reportInput,
    async execute(input) {
      sink.decision = {
        kind: 'report',
        urgency: input.urgency,
        text: input.text.trim(),
        actions: input.actions ?? [],
      };
      return { delivered: 'queued', chars: input.text.trim().length };
    },
  };

  const silent: ToolDefinition<z.infer<typeof silentInput>, SilentResult> = {
    name: 'mission.silent',
    description:
      'Finish this scheduled run without sending anything, because nothing needs the owner\'s attention. Give the one-line reason; it is logged so the decision can be reviewed later.',
    tier: 'auto',
    input: silentInput,
    async execute(input) {
      sink.decision = { kind: 'silent', reason: input.reason.trim() };
      return { delivered: 'none' };
    },
  };

  return {
    name: MISSION_PLUGIN,
    version: '0.1.0',
    // The mission tools own no schema: the decision lives in the run, and the
    // event log records it.
    schema: 'core',
    migrationsDir: '',
    tools: [report, silent],
  };
}

/** The instruction block that tells an unattended run how to end. */
export const NOTIFY_POLICY_SUFFIX = [
  'You end this run by calling exactly one tool:',
  'mission.report to send the owner a message, or mission.silent when nothing needs their attention.',
  'Nothing you write outside mission.report is ever delivered — a run that calls neither tool sends nothing at all.',
  'Prefer silence: report only what the owner would want to be interrupted for, or what this mission exists to deliver.',
  'When you do report, you may attach up to three actions the owner can take about it — a label they read and the sentence you are asked if they choose it.',
  'An action is a shortcut for something the owner could have typed: it authorizes nothing, and anything that leaves this machine still goes through the approval they would have seen anyway.',
].join(' ');
