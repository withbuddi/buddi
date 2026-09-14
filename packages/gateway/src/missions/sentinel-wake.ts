/**
 * `sentinel-wake` — the mission a watcher enqueues when something is urgent.
 *
 * It has no cron: an occurrence of it exists only because `runSentinels` wrote
 * one, carrying the finding as the occurrence payload. The finding is evidence,
 * not a verdict — the prompt's whole job is to make the agent *verify it with
 * tools* before the owner's phone buzzes, and to let it call `mission.silent`
 * when the check says it does not matter after all.
 */
import { SENTINEL_WAKE_MISSION_ID, type Severity, type UpsertMissionInput } from '@buddi/core';

export const SENTINEL_WAKE_ID = SENTINEL_WAKE_MISSION_ID;

/** The finding as it travels in `core.occurrences.payload`. */
export interface FindingPayload {
  key: string;
  sentinelId: string;
  severity: Severity;
  title: string;
  detail: string;
  agentId?: string | null;
  data?: unknown;
}

/** Read a finding out of an occurrence payload, or null if it carries none. */
export function findingOf(payload: unknown): FindingPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const finding = (payload as { finding?: unknown }).finding;
  if (finding === null || typeof finding !== 'object') return null;
  const f = finding as Partial<FindingPayload>;
  if (typeof f.key !== 'string' || typeof f.title !== 'string') return null;
  return {
    key: f.key,
    sentinelId: typeof f.sentinelId === 'string' ? f.sentinelId : 'unknown',
    severity: f.severity === 'info' ? 'info' : 'urgent',
    title: f.title,
    detail: typeof f.detail === 'string' ? f.detail : '',
    agentId: typeof f.agentId === 'string' ? f.agentId : null,
    data: f.data ?? null,
  };
}

/** The finding, rendered as the block appended to the wake prompt. */
export function renderFinding(finding: FindingPayload): string {
  const lines = [
    `Watcher: ${finding.sentinelId} (severity ${finding.severity})`,
    `Finding: ${finding.title}`,
  ];
  if (finding.detail.trim() !== '') lines.push(`Detail: ${finding.detail}`);
  if (finding.data !== null && finding.data !== undefined) {
    lines.push(`Data: ${JSON.stringify(finding.data)}`);
  }
  return lines.join('\n');
}

export const SENTINEL_WAKE_PROMPT = `A deterministic watcher found something it thinks is urgent. It is evidence, not a verdict.

1. Verify it with your own tools before saying anything — re-read the numbers the finding refers to. The watcher can be out of date; the tools are the truth.
2. If it holds and the owner would want to know now, call mission.report with urgency 'urgent': at most 600 characters, plain text, no markdown. Say what is happening, the number and the date it rests on, and exactly one recommended action.
3. If it does not hold, or it is not worth an interruption, call mission.silent with the one-line reason instead.

Do not greet, do not ask a question, do not offer to do anything on confirmation.`;

export const SENTINEL_WAKE_MISSION: UpsertMissionInput = {
  id: SENTINEL_WAKE_ID,
  name: 'Sentinel wake',
  // The default speaker. A finding naming its own agentId overrides it per run.
  agentId: 'finance-advisor',
  prompt: SENTINEL_WAKE_PROMPT,
  enabled: true,
  alwaysDeliver: false,
};
