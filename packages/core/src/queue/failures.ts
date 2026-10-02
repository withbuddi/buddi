/**
 * Failed jobs, grouped by what broke them.
 *
 * The footer said "10 failed" for days. Ten rows of raw provider errors is not
 * something the owner can decide about; "Gemini quota (429) · 4" and "Gemini
 * thought_signature (400) · 6", each with one sentence on why and whether a
 * retry has a chance, is. This file is that reading: one cause per failed job,
 * from its raw `last_error` and the reason the retry policy recorded on its
 * last `job.failed` event, and the jobs with the same cause as one group.
 *
 * The rule for a group is "the same thing broke": a known family (a quota, a
 * refused key, a lost connection, a known defect) by its family and provider,
 * anything else by its HTTP status and its first line with the numbers, ids
 * and quoted values taken out — so ten 400s about ten different message ids are
 * one group, and a 400 about a schema is not grouped with a 400 about a key.
 *
 * The sentence is plain words for a person, never the raw error; families we
 * do not know read the same sentence a chat turn would (failures/owner-message).
 */
import type { Pool } from 'pg';
import { describeFailure } from '../failures/owner-message.js';
import { listJobs } from './jobs.js';
import type { Job } from './types.js';

export interface FailureCause {
  /** Stable for the same cause: what a group is keyed and acted on by. */
  key: string;
  /** Short, for the group's title: "Gemini quota (429)". */
  label: string;
  /** Why it failed, for the owner: one or two plain sentences. */
  reason: string;
  /**
   * Has the cause plausibly gone away, so a retry is worth it now? A quota
   * that has reset, a connection blip, a defect fixed since: yes. A refused
   * key: not until the owner changes it. Retry is offered either way.
   */
  likelyFixed: boolean;
}

export interface FailureInput {
  lastError: string | null;
  /** The retry policy's one line from the last `job.failed` event, when there is one. */
  failureReason?: string | null;
  failureClass?: string | null;
  /** When the job gave up. */
  diedAt: Date;
  now: Date;
}

const HOUR = 3_600_000;

/** The provider a message is about, when it says. */
function providerOf(message: string): string | null {
  if (/gemini|generativelanguage|ai\.google\.dev|googleapis/i.test(message)) return 'Gemini';
  if (/anthropic|claude/i.test(message)) return 'Claude';
  if (/openrouter/i.test(message)) return 'OpenRouter';
  if (/chatgpt|codex/i.test(message)) return 'ChatGPT';
  if (/openai|gpt-/i.test(message)) return 'OpenAI';
  if (/ollama/i.test(message)) return 'Ollama';
  return null;
}

/** The HTTP status, from the policy's line ("the provider answered 429") or the message's start. */
function statusOf(message: string, reason: string): number | null {
  const fromReason = /answered (\d{3})\b/.exec(reason)?.[1];
  if (fromReason) return Number(fromReason);
  const lead = /^\s*(?:Error:\s*)?(\d{3})\b/.exec(message)?.[1];
  if (lead && Number(lead) >= 400 && Number(lead) < 600) return Number(lead);
  const coded = /"code"\s*:\s*(\d{3})\b/.exec(message)?.[1];
  return coded ? Number(coded) : null;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The first line with what varies between occurrences taken out: ids, numbers,
 * quoted values, URLs. Two failures with the same shape have the same text.
 */
export function failureShape(message: string): string {
  const first = (message.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return first
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/(["'`“])[^"'`”]{0,200}(["'`”])/g, '<value>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

/** What broke one failed job. Total: it never throws. */
export function failureCause(input: FailureInput): FailureCause {
  const message = input.lastError ?? '';
  const reason = input.failureReason ?? '';
  const age = input.now.getTime() - input.diedAt.getTime();
  const status = statusOf(message, reason);
  const provider = providerOf(message);
  const who = provider ?? 'The provider';

  if (/thought_signature/i.test(message)) {
    return {
      key: 'gemini-thought-signature',
      label: 'Gemini thought_signature (400)',
      reason:
        'Gemini refused the turn after a tool call because buddi did not send back the signature Google attaches to each call. ' +
        'That was a defect in buddi, fixed since, so running them again should work.',
      likelyFixed: true,
    };
  }

  if (/^no handler for job kind/i.test(message)) {
    const kind = /"([^"]+)"/.exec(message)?.[1] ?? 'this kind';
    return {
      key: `no-handler-${slug(kind)}`,
      label: `Nothing runs ${kind} jobs`,
      reason: 'Nothing in this buddi runs this kind of job, usually because the plugin that did was removed. A retry helps only once it is back.',
      likelyFixed: false,
    };
  }

  const daily = /per ?day|daily|PerDay|requests a day/i.test(message);
  if (status === 429 || /exceeded your current quota|resource[_ ]exhausted|rate.?limit|too many requests|quota/i.test(message)) {
    const label = `${provider ?? 'Provider'} quota (429)`;
    return {
      key: `${slug(provider ?? 'provider')}-quota`,
      label,
      reason: daily
        ? `${who} said the account had used up its allowance for the day. Daily quotas reset on their own (Google's at midnight Pacific), so once a day has passed these can run.`
        : `${who} refused because the account had used up its quota or was sending too fast. That passes on its own, usually within a day; if it keeps happening, give the agent another account in Settings → Model accounts.`,
      likelyFixed: age > 24 * HOUR,
    };
  }

  if (status === 401 || status === 403 || /api key|x-api-key|unauthori[sz]ed|authentication|permission denied|credential|environment variable [A-Z0-9_]+ is (not set|empty)/i.test(message)) {
    return {
      key: `${slug(provider ?? 'provider')}-credential`,
      label: `${provider ?? 'Provider'} refused the key${status ? ` (${status})` : ''}`,
      reason: `${who} refused the key or sign-in the agent uses. Change it in Settings → Model accounts first; until then a retry fails the same way.`,
      likelyFixed: false,
    };
  }

  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network|timed? ?out/i.test(message) || /connection failed/.test(reason)) {
    return {
      key: 'connection',
      label: 'Connection failed',
      reason: 'buddi could not reach the provider, try after try, until it gave up. That is a network or provider outage, and those pass.',
      likelyFixed: age > HOUR,
    };
  }

  if (/^lease expired$/i.test(message.trim())) {
    return {
      key: 'interrupted',
      label: 'Interrupted',
      reason: 'buddi stopped while these were running, more times than they are allowed to start over.',
      likelyFixed: true,
    };
  }

  // Anything else: grouped by status and shape, said the way a chat turn would say it.
  const shape = failureShape(message) || 'no error recorded';
  const described = describeFailure(
    Object.assign(new Error(message || 'failed'), status ? { status } : {}),
    { now: input.now },
  );
  const first = (message.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const title = first.length > 64 ? `${first.slice(0, 63).trimEnd()}…` : first || 'Failed without an error';
  return {
    key: `other-${status ?? 'x'}-${slug(shape).slice(0, 80)}`,
    label: status ? `${title} (${status})` : title,
    reason: described.text,
    likelyFixed: described.class === 'transient' || (input.failureClass === 'transient'),
  };
}

/** One job inside a group, with who it was for. */
export interface FailedJob {
  job: Job;
  /** The agent it ran as, when the payload says. */
  agentId: string | null;
  /** The mission it ran for, when it was a mission run. */
  missionId: string | null;
  missionName: string | null;
}

export interface FailureGroup extends FailureCause {
  jobs: FailedJob[];
  count: number;
  /** The first and last time a job of this group gave up. */
  firstAt: Date;
  lastAt: Date;
  /** The agents involved, most jobs first. */
  agentIds: string[];
}

/** Group failed jobs by cause, the most recent group first. Pure. */
export function groupFailures(
  jobs: ReadonlyArray<FailedJob & { failureReason?: string | null; failureClass?: string | null }>,
  now: Date,
): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const item of jobs) {
    const cause = failureCause({
      lastError: item.job.lastError,
      failureReason: item.failureReason ?? null,
      failureClass: item.failureClass ?? null,
      diedAt: item.job.updatedAt,
      now,
    });
    const { failureReason: _r, failureClass: _c, ...failed } = item;
    const group = groups.get(cause.key);
    if (!group) {
      groups.set(cause.key, { ...cause, jobs: [failed], count: 1, firstAt: item.job.updatedAt, lastAt: item.job.updatedAt, agentIds: [] });
      continue;
    }
    group.jobs.push(failed);
    group.count += 1;
    if (item.job.updatedAt < group.firstAt) group.firstAt = item.job.updatedAt;
    if (item.job.updatedAt > group.lastAt) group.lastAt = item.job.updatedAt;
    // Worth retrying only if every job's cause says so: one recent failure
    // means the cause may still be there.
    if (!cause.likelyFixed) group.likelyFixed = false;
  }
  for (const group of groups.values()) {
    group.jobs.sort((a, b) => b.job.updatedAt.getTime() - a.job.updatedAt.getTime());
    const tally = new Map<string, number>();
    for (const j of group.jobs) if (j.agentId) tally.set(j.agentId, (tally.get(j.agentId) ?? 0) + 1);
    group.agentIds = [...tally].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  return [...groups.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * The failed jobs, grouped: the ones still asking for the owner (`open`), or
 * the ones he dismissed and the ones quiet by age (`dismissed`). Bounded.
 */
export async function listFailureGroups(
  pool: Pool,
  input: { which: 'open' | 'dismissed'; now: Date; limit?: number },
): Promise<FailureGroup[]> {
  const jobs = await listJobs(pool, { state: 'failed', failed: input.which, limit: input.limit ?? 500 });
  if (jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);
  const { rows: events } = await pool.query<{ job_id: string; reason: string | null; class: string | null }>(
    `select distinct on (payload->>'jobId') payload->>'jobId' as job_id,
            payload->>'failureReason' as reason, payload->>'failureClass' as class
       from core.events
      where kind = 'job.failed' and payload->>'jobId' = any($1::text[])
      order by payload->>'jobId', id desc`,
    [ids],
  );
  const why = new Map(events.map((e) => [e.job_id, e]));
  const missionIds = [...new Set(jobs.map((j) => str((j.payload as Record<string, unknown> | null)?.missionId)).filter((v): v is string => v !== null))];
  const { rows: missions } = missionIds.length === 0
    ? { rows: [] as Array<{ id: string; name: string; agent_id: string }> }
    : await pool.query<{ id: string; name: string; agent_id: string }>(
        `select id, name, agent_id from core.missions where id = any($1::text[])`,
        [missionIds],
      );
  const mission = new Map(missions.map((m) => [m.id, m]));
  return groupFailures(
    jobs.map((job) => {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const missionId = str(payload.missionId);
      const m = missionId ? mission.get(missionId) : undefined;
      const e = why.get(job.id);
      return {
        job,
        agentId: str(payload.agentId) ?? m?.agent_id ?? null,
        missionId,
        missionName: m?.name ?? null,
        failureReason: e?.reason ?? null,
        failureClass: e?.class ?? null,
      };
    }),
    input.now,
  );
}
