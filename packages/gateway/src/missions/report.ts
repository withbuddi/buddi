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
  REPORT_MAX_DEFAULT,
  REPORT_MAX_LIMIT,
  getArtifact,
  type CoreToolContext,
  type OfferedAction,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import { z } from 'zod';

/** Plugin family name for the mission-run tools. */
export const MISSION_PLUGIN = 'mission';

/**
 * The longest report the owner should get from an unattended run, unless its
 * mission declares `reportMax` (host API 1.27, at most `REPORT_MAX_LIMIT`).
 */
export const MAX_REPORT_CHARS = REPORT_MAX_DEFAULT;

/** A mission's `reportMax`, made sound: the default when absent, never past the limit. */
export function reportMaxOf(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 200) return MAX_REPORT_CHARS;
  return Math.min(value, REPORT_MAX_LIMIT);
}

/** The voice note a report carries, as the chat draws it. */
export interface ReportAudio {
  fileId: string;
  mime: string;
  filename: string | null;
  sizeBytes: number;
}

export type MissionDecision =
  | {
      kind: 'report';
      urgency: 'urgent' | 'normal';
      text: string;
      /** The few things the owner might want to do about it. Usually empty. */
      actions: readonly OfferedAction[];
      /** A dashboard route the report opens, since 1.27. */
      link?: string;
      /** The words on its button in the chat ("Open edition"). */
      linkLabel?: string;
      /** A voice note in Files made by this run, sent before the text, since 1.27. */
      audio?: ReportAudio;
    }
  | { kind: 'silent'; reason: string };

/** Where the tools record what the run decided. One per run. */
export interface DecisionSink {
  decision?: MissionDecision;
}

/** A dashboard route: `#/` and a path, no scheme, no host. */
const ROUTE = /^#\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,300}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reportInputFor = (max: number) => z.object({
  urgency: z
    .enum(['urgent', 'normal'])
    .describe(
      "'urgent' means this is worth interrupting the owner for right now; 'normal' means it is the expected scheduled message.",
    ),
  text: z
    .string()
    .min(1)
    .max(max)
    .describe(
      `Exactly what the owner should read, in plain text with no markdown, at most ${max} characters. This is delivered verbatim; nothing else you write in this run is sent.`,
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
  link: z
    .string()
    .regex(ROUTE, 'a dashboard route, starting #/')
    .optional()
    .describe('Optional: a dashboard route the message opens, such as a plugin page where the whole thing lives ("#/p/news/stories"). Never a web address.'),
  linkLabel: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('Optional, with link: the words on its button in the chat ("Open edition"). "Open" when absent.'),
  audio: z
    .string()
    .regex(UUID, 'a Files id')
    .optional()
    .describe('Optional: the Files id of a voice note you made in this run (speech.say). Sent before the text where the owner listens; left out where they cannot.'),
});

type ReportInput = z.infer<ReturnType<typeof reportInputFor>>;

const silentInput = z.object({
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Why nothing needs to be sent, in one line, e.g. "projection holds, no charge due within 3 days". Recorded in the event log, not shown to the owner.',
    ),
});

export type ReportResult = { delivered: 'queued'; chars: number; link?: string; linkLabel?: string; audio?: ReportAudio };
export type SilentResult = { delivered: 'none' };

/**
 * The voice note a report names, checked: a file in Files, audio, made in
 * this run's own conversation. Anything else is refused with the sentence
 * why, so the run can report without it.
 */
async function reportAudio(fileId: string, ctx: CoreToolContext): Promise<ReportAudio> {
  const row = await getArtifact(ctx.db, fileId).catch(() => null);
  if (!row) throw new Error(`audio: there is no file ${fileId} in Files`);
  if (!row.mime.toLowerCase().startsWith('audio/')) throw new Error(`audio: ${fileId} is ${row.mime}, not a voice note`);
  const made = await ctx.db.query<{ conversation_id: string | null }>(`select conversation_id from core.artifacts where id = $1`, [fileId]);
  const conversation = made.rows[0]?.conversation_id == null ? null : String(made.rows[0].conversation_id);
  // A run always has its conversation; a context without one cannot prove the note is this run's, so it is refused.
  if (!ctx.conversationId || conversation !== ctx.conversationId) {
    throw new Error(`audio: ${fileId} was not made in this run; give the id speech.say answered here`);
  }
  return { fileId: row.id, mime: row.mime, filename: row.filename ?? null, sizeBytes: row.sizeBytes };
}

export function createMissionManifest(sink: DecisionSink, opts: { reportMax?: number | null } = {}): PluginManifest {
  const max = reportMaxOf(opts.reportMax);
  const report: ToolDefinition<ReportInput, ReportResult> = {
    name: 'mission.report',
    description:
      'Send this text to the owner as the result of this scheduled run, and finish. Call it once, with the finished message; the text you pass is exactly what is delivered. You may attach a few actions the owner can take about it — they become buttons where the surface has them and a plain list where it does not. ' +
      'You may also give a dashboard link it opens, and the Files id of a voice note you made in this run. If there is nothing worth an interruption, call mission.silent instead.',
    tier: 'auto',
    sideEffect: true,
    input: reportInputFor(max),
    async execute(input, ctx) {
      const audio = input.audio ? await reportAudio(input.audio, ctx as CoreToolContext) : undefined;
      sink.decision = {
        kind: 'report',
        urgency: input.urgency,
        text: input.text.trim(),
        actions: input.actions ?? [],
        ...(input.link ? { link: input.link } : {}),
        ...(input.link && input.linkLabel ? { linkLabel: input.linkLabel.trim() } : {}),
        ...(audio ? { audio } : {}),
      };
      return {
        delivered: 'queued',
        chars: input.text.trim().length,
        ...(input.link ? { link: input.link } : {}),
        ...(input.link && input.linkLabel ? { linkLabel: input.linkLabel.trim() } : {}),
        ...(audio ? { audio } : {}),
      };
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
