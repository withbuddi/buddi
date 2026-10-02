/**
 * Alerts: decisions, not chores (docs/dashboard.md, "Alerts").
 *
 * What the watchers found, shaped for the owner. Three rules, and every
 * surface that lists findings — the Alerts page, Home's Needs you — reads them
 * from here so none of them can drift:
 *
 *  1. **Only the owner's line is ever sent.** A finding's `detail` is the agent
 *     brief, written for a model; it never leaves this file. A finding without
 *     an owner line shows its title.
 *  2. **Only decisions are listed.** An `info` finding goes to the recap
 *     silently: it is counted in one line ("12 notes saved for Friday's
 *     recap") and listed only in that line's preview.
 *  3. **Repeats are one row.** Open findings of the same watcher and kind are
 *     one group, titled by the watcher's group spec, with the subjects inside.
 *
 * Every row carries the actions its findings declared (host API 1.23), shaped
 * so the page can only ask for what was declared: a `run` or a `fill` is named
 * by finding key and action index, and resolved again here before anything
 * runs.
 */
import {
  OWNER_AGENT_ID,
  getActiveSchedule,
  isMuted,
  isSnoozed,
  muteFindings,
  nextAfter,
  ownerLineOf,
  sentinelMutes,
  SENTINEL_FINDING_COLUMNS,
  toSentinelFinding,
  type CoreToolContext,
  type FindingAction,
  type PluginManifest,
  type SentinelFinding,
  type SentinelFindingRow,
  type SentinelMute,
  type ToolRegistry,
} from '@buddi/core';
import type { Pool } from 'pg';
import { recapMissionId } from '../missions/recap.js';
import { renderFindings, type FindingPayload } from '../missions/sentinel-wake.js';

/* ------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------ */

export interface AlertItemView {
  key: string;
  /** The owner's line (or the title). Never the brief. */
  line: string;
  subject: { id: string; label: string } | null;
  /** Beside the subject inside a group: its last value ("2,340.00 USD on 2026-09-14"), else its line. */
  note: string;
  firstSeenAt: string;
}

export type AlertActionView =
  | { kind: 'open'; label: string; plugin: string | null; page?: string; item?: string; place?: 'files' }
  | { kind: 'run'; label: string; key: string; index: number; confirm?: string; tone?: 'danger' }
  | {
      kind: 'fill';
      label: string;
      title: string;
      fields: Array<{ key: string; index: number; label: string; type: 'number' | 'text' | 'date'; value: string | number | null; hint: string | null }>;
    }
  | { kind: 'ask'; label: string | null }
  | { kind: 'dismiss'; label: string };

export interface AlertGroupView {
  /** `<sentinel>:<kind>` for a group, the finding's key for a single one. */
  id: string;
  sentinelId: string;
  /** The plugin that ships the watcher, when it is installed. */
  plugin: string | null;
  kind: string;
  /** The row's words: the owner line, or the group's title. */
  title: string;
  /** The group's owner line under the title, when the watcher wrote one. */
  line: string | null;
  urgent: boolean;
  since: string;
  /** Who answers for it: Ask goes there. Null: the wake mission's agent. */
  agentId: string | null;
  keys: string[];
  items: AlertItemView[];
  actions: AlertActionView[];
  /** What "Stop telling me this" silences: one subject, or the whole kind. */
  stop: { scope: 'subject' | 'kind'; label: string };
  snoozedUntil: string | null;
  resolvedAt: string | null;
}

export interface AlertsView {
  /** Urgent, open, not snoozed, not silenced: the decisions. */
  open: AlertGroupView[];
  /** Urgent ones the owner put off ("Not now") or set aside ("Not needed"). */
  snoozed: AlertGroupView[];
  /** What stopped being true lately. */
  resolved: AlertGroupView[];
  /** The notes waiting for the recap: a count, when, and the preview's groups. */
  recap: { count: number; missionId: string | null; nextAt: string | null; groups: AlertGroupView[] };
  /** "Stop telling me this", as Settings → Watchers lists them. */
  mutes: Array<{ id: string; sentinelId: string; label: string; createdAt: string }>;
}

/** Which plugin ships each watcher. */
export function sentinelPlugins(manifests: readonly PluginManifest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of manifests) for (const s of m.sentinels ?? []) out.set(s.id, m.name);
  return out;
}

/**
 * The owner's line for a surface: the plugin's own fences round quoted mail
 * (`<<<QUOTED MAIL …>>>`) are for a model reading it, not for a person, so a
 * surface draws the words without them. The finding keeps them for the agent.
 */
export function plainLine(f: { ownerLine?: string | null; title: string }): string {
  return unfenced(ownerLineOf(f));
}

function unfenced(text: string): string {
  return text.replace(/<<<[^<>]*>>>/g, '').replace(/\s+/g, ' ').trim();
}

function groupKey(f: SentinelFinding): string {
  return `${f.sentinelId}:${f.kind}`;
}

function fill(template: string, count: number): string {
  return template.split('{count}').join(String(count));
}

/** The action a single finding offers, as the page draws it. */
function actionView(f: SentinelFinding, a: FindingAction, index: number, plugin: string | null): AlertActionView {
  switch (a.kind) {
    case 'open':
      return { kind: 'open', label: a.label, plugin, ...(a.page ? { page: a.page } : {}), ...(a.item ? { item: a.item } : {}), ...(a.place ? { place: a.place } : {}) };
    case 'run':
      return { kind: 'run', label: a.label, key: f.key, index, ...(a.confirm ? { confirm: a.confirm } : {}), ...(a.tone ? { tone: a.tone } : {}) };
    case 'fill':
      return {
        kind: 'fill',
        label: a.label,
        title: a.title ?? a.label,
        fields: [{ key: f.key, index, label: a.field.label, type: a.field.type, value: a.field.value ?? null, hint: a.field.hint ?? null }],
      };
    case 'ask':
      return { kind: 'ask', label: a.label ?? null };
    case 'dismiss':
      return { kind: 'dismiss', label: a.label };
  }
}

/**
 * A group's actions, from its first finding's: what makes sense for many at
 * once. A `fill` gathers a field from every finding that offers the same tool
 * — one quick form for nine balances. An `open` stays when every finding opens
 * the same page (without an item when the items differ). A `run` is about one
 * thing, so a group drops it; each finding's own is a row inside the group.
 */
function groupActions(findings: SentinelFinding[], plugin: string | null): AlertActionView[] {
  const first = findings[0] as SentinelFinding;
  if (findings.length === 1) {
    const own = first.actions.map((a, i) => actionView(first, a, i, plugin));
    return own.length > 0 ? own : [{ kind: 'ask', label: null }];
  }
  const out: AlertActionView[] = [];
  first.actions.forEach((a) => {
    if (a.kind === 'run') return;
    if (a.kind === 'fill') {
      const fields: Extract<AlertActionView, { kind: 'fill' }>['fields'] = [];
      for (const f of findings) {
        const index = f.actions.findIndex((x) => x.kind === 'fill' && x.tool === a.tool);
        const own = f.actions[index];
        if (own === undefined || own.kind !== 'fill') continue;
        fields.push({ key: f.key, index, label: own.field.label, type: own.field.type, value: own.field.value ?? null, hint: own.field.hint ?? null });
      }
      out.push({ kind: 'fill', label: a.groupLabel ?? a.label, title: a.title ?? a.groupLabel ?? a.label, fields });
      return;
    }
    if (a.kind === 'open') {
      const same = findings.every((f) => f.actions.some((x) => x.kind === 'open' && x.page === a.page && x.place === a.place));
      if (!same) return;
      const oneItem = findings.every((f) => f.actions.some((x) => x.kind === 'open' && x.item === a.item));
      out.push({ kind: 'open', label: a.label, plugin, ...(a.page ? { page: a.page } : {}), ...(oneItem && a.item ? { item: a.item } : {}), ...(a.place ? { place: a.place } : {}) });
      return;
    }
    out.push(actionView(first, a, 0, plugin));
  });
  return out.length > 0 ? out : [{ kind: 'ask', label: null }];
}

/** One row per watcher and kind; a fact on its own is a row of one. */
export function groupFindings(findings: readonly SentinelFinding[], plugins: ReadonlyMap<string, string>): AlertGroupView[] {
  const buckets = new Map<string, SentinelFinding[]>();
  for (const f of findings) {
    const key = groupKey(f);
    const list = buckets.get(key);
    if (list) list.push(f);
    else buckets.set(key, [f]);
  }
  const groups: AlertGroupView[] = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.key.localeCompare(b.key));
    const first = list[0] as SentinelFinding;
    const plugin = plugins.get(first.sentinelId) ?? null;
    const many = list.length > 1;
    const spec = list.find((f) => f.group !== null)?.group ?? null;
    const title = !many
      ? plainLine(first)
      : spec
        ? fill(spec.title, list.length)
        : `${plainLine(first)} — and ${list.length - 1} more like it`;
    const line = many && spec?.ownerLine ? fill(spec.ownerLine, list.length) : null;
    const subject = !many ? first.subject : null;
    groups.push({
      id: many ? groupKey(first) : first.key,
      sentinelId: first.sentinelId,
      plugin,
      kind: first.kind,
      title,
      line,
      urgent: list.some((f) => f.severity === 'urgent'),
      since: first.firstSeenAt.toISOString(),
      agentId: list.find((f) => f.agentId !== null)?.agentId ?? null,
      keys: list.map((f) => f.key),
      items: list.map((f) => {
        const fillAction = f.actions.find((a) => a.kind === 'fill');
        const hint = fillAction?.kind === 'fill' ? fillAction.field.hint : undefined;
        return {
          key: f.key,
          line: plainLine(f),
          subject: f.subject ? { id: f.subject.id, label: unfenced(f.subject.label) } : null,
          note: hint ?? plainLine(f),
          firstSeenAt: f.firstSeenAt.toISOString(),
        };
      }),
      actions: groupActions(list, plugin),
      stop: subject
        ? { scope: 'subject', label: `${unfenced(subject.label)}: ${plainLine(first)}` }
        : { scope: 'kind', label: title },
      snoozedUntil: list.map((f) => f.snoozedUntil).find((d) => d !== null)?.toISOString() ?? null,
      resolvedAt: list.every((f) => f.resolvedAt !== null) ? (list[list.length - 1]!.resolvedAt as Date).toISOString() : null,
    });
  }
  // Urgent first, then the longest waiting.
  groups.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.since.localeCompare(b.since));
  return groups;
}

async function loadFindings(pool: Pool, where: string, params: unknown[] = []): Promise<SentinelFinding[]> {
  const { rows } = await pool.query<SentinelFindingRow>(
    `select ${SENTINEL_FINDING_COLUMNS} from core.sentinel_findings where ${where}`,
    params,
  );
  return rows.map(toSentinelFinding);
}

function notMuted(mutes: readonly SentinelMute[]) {
  return (f: SentinelFinding): boolean => !isMuted(mutes, f.sentinelId, f.kind, f.subject?.id ?? null);
}

/** The decisions alone: what the Alerts page lists and Home's Needs you counts. */
export async function readAlertDecisions(pool: Pool, registry: ToolRegistry, now: Date): Promise<AlertGroupView[]> {
  const mutes = await sentinelMutes(pool);
  const open = await loadFindings(pool, `resolved_at is null and severity = 'urgent'`);
  const live = open.filter(notMuted(mutes)).filter((f) => !isSnoozed(f, now));
  return groupFindings(live, sentinelPlugins(registry.manifests()));
}

/** When the recap runs next, if a plugin ships one and it is on. */
async function nextRecap(pool: Pool, manifests: readonly PluginManifest[], now: Date): Promise<{ missionId: string | null; nextAt: string | null }> {
  const missionId = recapMissionId(manifests) ?? null;
  if (missionId === null) return { missionId, nextAt: null };
  const { rows } = await pool.query<{ enabled: boolean }>(`select enabled from core.missions where id = $1`, [missionId]);
  if (rows[0]?.enabled !== true) return { missionId, nextAt: null };
  const spec = await getActiveSchedule(pool, missionId).catch(() => null);
  if (!spec) return { missionId, nextAt: null };
  const next = nextAfter(spec.cron, now, spec.timezone);
  return { missionId, nextAt: next ? next.toISOString() : null };
}

export async function readAlerts(pool: Pool, registry: ToolRegistry, now: Date): Promise<AlertsView> {
  const manifests = registry.manifests();
  const plugins = sentinelPlugins(manifests);
  const mutes = await sentinelMutes(pool);
  const shown = notMuted(mutes);

  const urgentOpen = (await loadFindings(pool, `resolved_at is null and severity = 'urgent'`)).filter(shown);
  const open = urgentOpen.filter((f) => !isSnoozed(f, now));
  const snoozed = urgentOpen.filter((f) => isSnoozed(f, now));
  const resolved = (
    await loadFindings(pool, `resolved_at is not null and resolved_at > $1 order by resolved_at desc limit 20`, [
      new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    ])
  ).filter(shown);

  // The recap's notes: what is queued for it, in the owner's words.
  const queued = await loadFindings(
    pool,
    `key in (select finding_key from core.digest_items where consumed_at is null)`,
  );
  const notes = queued.filter(shown);
  const recap = await nextRecap(pool, manifests, now);

  return {
    open: groupFindings(open, plugins),
    snoozed: groupFindings(snoozed, plugins),
    resolved: groupFindings(resolved, plugins),
    recap: { count: notes.length, ...recap, groups: groupFindings(notes, plugins) },
    mutes: mutes.map((m) => ({ id: m.id, sentinelId: m.sentinelId, label: m.label, createdAt: m.createdAt.toISOString() })),
  };
}

/* ------------------------------------------------------------------ *
 * The owner's verbs
 * ------------------------------------------------------------------ */

export type AlertReply = { status: number; body: unknown };

async function openFinding(pool: Pool, key: string): Promise<SentinelFinding | null> {
  const [f] = await loadFindings(pool, `key = $1 and resolved_at is null`, [key]);
  return f ?? null;
}

/**
 * "Stop telling me this" on a row. A finding with a subject silences that
 * subject; a group, or a finding about nothing in particular, its whole kind.
 * `group` says which the page drew.
 */
export async function muteAlert(pool: Pool, body: Record<string, unknown>, now: Date): Promise<AlertReply> {
  const key = typeof body.key === 'string' ? body.key : '';
  const f = key ? await openFinding(pool, key) : null;
  if (!f) return { status: 404, body: { error: 'No open alert has that key.' } };
  const scope = body.scope === 'kind' || f.subject === null ? 'kind' : 'subject';
  const label =
    typeof body.label === 'string' && body.label.trim() !== ''
      ? body.label.trim()
      : scope === 'subject' && f.subject
        ? `${f.subject.label}: ${plainLine(f)}`
        : plainLine(f);
  const mute = await muteFindings(
    pool,
    { sentinelId: f.sentinelId, kind: f.kind, subjectId: scope === 'subject' && f.subject ? f.subject.id : '', label },
    now,
  );
  return { status: 200, body: { id: mute.id, label: mute.label } };
}

export interface AlertActDeps {
  pool: Pool;
  registry: ToolRegistry;
  ctx: CoreToolContext;
  now: () => Date;
}

/** At most this many entries in one act: a quick form of every balance, not a script. */
export const ALERT_ACT_MAX = 50;

/**
 * Run what a finding declared: a `run`, or a `fill` with the value the owner
 * typed. The page names a finding key and an action index, never a tool, so
 * it can only run what the watcher put on the row — and only a tool of the
 * plugin that ships the watcher. A gated tool answers its approval, exactly
 * as from the plugin's own page.
 */
export async function actOnAlerts(deps: AlertActDeps, body: Record<string, unknown>, session: { via?: string }): Promise<AlertReply> {
  const entries = Array.isArray(body.entries) ? body.entries : null;
  if (entries === null || entries.length === 0) return { status: 400, body: { error: 'Send `{ entries: [{ key, action, value? }] }`.' } };
  if (entries.length > ALERT_ACT_MAX) return { status: 400, body: { error: `At most ${ALERT_ACT_MAX} at once.` } };
  const plugins = sentinelPlugins(deps.registry.manifests());
  const results: Array<{ key: string; result?: unknown; approvalId?: string; error?: string }> = [];
  for (const raw of entries) {
    const entry = (raw ?? {}) as { key?: unknown; action?: unknown; value?: unknown };
    const key = typeof entry.key === 'string' ? entry.key : '';
    const index = typeof entry.action === 'number' && Number.isInteger(entry.action) ? entry.action : -1;
    const f = key ? await openFinding(deps.pool, key) : null;
    const action = f?.actions[index];
    if (!f || !action || (action.kind !== 'run' && action.kind !== 'fill')) {
      results.push({ key, error: 'That alert has no such action any more.' });
      continue;
    }
    const plugin = plugins.get(f.sentinelId);
    if (plugin === undefined || deps.registry.pluginOf(action.tool) !== plugin) {
      results.push({ key, error: `${action.tool} is not a tool of the plugin that raised this alert.` });
      continue;
    }
    const args: Record<string, unknown> = { ...(action.args ?? {}) };
    if (action.kind === 'fill') {
      const value = entry.value;
      if (action.field.type === 'number') {
        const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.replace(/[,\s]/g, '')) : NaN;
        if (!Number.isFinite(n)) {
          results.push({ key, error: `${action.field.label}: a number, please.` });
          continue;
        }
        args[action.field.name] = n;
      } else {
        if (typeof value !== 'string' || value.trim() === '') {
          results.push({ key, error: `${action.field.label}: nothing typed.` });
          continue;
        }
        args[action.field.name] = value.trim();
      }
    }
    const result = await deps.registry.invoke(action.tool, args, { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now }, { askOnly: session.via === 'token' });
    if (result.ok) results.push({ key, result: result.output });
    else if (result.reason === 'approval-required') results.push({ key, approvalId: result.actionId });
    else if (result.reason === 'ask-only') results.push({ key, error: `An API token cannot run ${action.tool}: it runs without an approval.` });
    else results.push({ key, error: result.message });
  }
  return { status: 200, body: { results } };
}

/**
 * "Ask <agent>": a turn with the agent that answers for the findings. The
 * thread shows the owner's line as what he asked about; the agent reads the
 * findings — brief, data and all — inside the watcher fence, the way a wake
 * hands them over.
 */
export function askPrompt(findings: readonly SentinelFinding[]): { label: string; prompt: string } {
  const payloads: FindingPayload[] = findings.map((f) => ({
    key: f.key,
    sentinelId: f.sentinelId,
    severity: f.severity,
    title: f.title,
    ...(f.ownerLine ? { ownerLine: f.ownerLine } : {}),
    detail: f.detail,
    agentId: f.agentId,
    data: f.data ?? null,
  }));
  const label =
    findings.length === 1
      ? `About: ${plainLine(findings[0] as SentinelFinding)}`
      : `About ${findings.length} alerts: ${plainLine(findings[0] as SentinelFinding)}…`;
  const prompt = [
    findings.length === 1
      ? 'The owner pressed "Ask" on this alert on his Alerts page. Check it with your own tools first, then tell him in a few plain sentences what it means and what you suggest — offer to do the part you can do.'
      : 'The owner pressed "Ask" on these alerts, grouped on his Alerts page. Check them with your own tools first, then answer once, in a few plain sentences: what they mean together and what you suggest — offer to do the part you can do.',
    '',
    renderFindings(payloads),
  ].join('\n');
  return { label: label.length > 160 ? `${label.slice(0, 157)}…` : label, prompt };
}

export async function findingsForAsk(pool: Pool, keys: readonly string[]): Promise<SentinelFinding[]> {
  if (keys.length === 0) return [];
  return loadFindings(pool, `key = any($1::text[]) order by first_seen_at`, [[...keys].slice(0, ALERT_ACT_MAX)]);
}
