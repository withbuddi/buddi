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
import type { PluginManifest, ToolDefinition } from '@buddi/core';
import { z } from 'zod';

/** Plugin family name for the mission-run tools. */
export const MISSION_PLUGIN = 'mission';

/** The longest report the owner should get from an unattended run. */
export const MAX_REPORT_CHARS = 1500;

export type MissionDecision =
  | { kind: 'report'; urgency: 'urgent' | 'normal'; text: string }
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
      'Send this text to the owner as the result of this scheduled run, and finish. Call it once, with the finished message; the text you pass is exactly what is delivered. If there is nothing worth an interruption, call mission.silent instead.',
    tier: 'auto',
    input: reportInput,
    async execute(input) {
      sink.decision = { kind: 'report', urgency: input.urgency, text: input.text.trim() };
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
].join(' ');
