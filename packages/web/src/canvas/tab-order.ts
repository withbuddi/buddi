/**
 * Which tab a result belongs to, which tabs are on the strip, and which have
 * closed themselves.
 *
 * A long session used to open a tab per call, titled by the tool: "Staged
 * import" twice, "Artifacts · Write" three times, none of them saying what
 * they were about. So a tab is now known by *(tool, subject)* — the file, the
 * account, the page, the site the call was about — and a second call on the
 * same subject updates the tab it already has, keeping the earlier results a
 * step back inside it. The subject is read from the call's arguments and then
 * its result, by the *shape* of the fields; this file knows no tool's name.
 *
 * The strip holds three, most recently looked at first. Everything else is a
 * timeline behind one control, grouped Now / Earlier this turn / Earlier.
 */
import type { Renderable, TabVersion } from './types';

/** At most this many tabs on the strip; the rest are in the timeline. */
export const STRIP_TABS = 3;

/** How recent "Now" is in the timeline. */
export const NOW_MS = 2 * 60_000;

/** The longest subject a title carries before it is cut. */
const SUBJECT_MAX = 40;

const FILE_KEYS = ['filename', 'fileName', 'file_name', 'file', 'filePath', 'file_path', 'path'];
const ACCOUNT_KEYS = ['accountName', 'account_name', 'account'];
const PAGE_KEYS = ['pageId', 'page_id', 'page'];
const URL_KEYS = ['url', 'href', 'link'];
/** Ids that say where a call ran, not what it was about. */
const CONTEXT_IDS = new Set(['conversationId', 'agentId', 'runId', 'toolUseId', 'ownerId', 'requestId']);

function cut(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length > SUBJECT_MAX ? `${trimmed.slice(0, SUBJECT_MAX - 1)}…` : trimmed;
}

function basename(value: string): string | null {
  const bare = value.split(/[?#]/)[0] ?? '';
  return cut(bare.split(/[\\/]/).filter(Boolean).at(-1) ?? '');
}

function host(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!parsed.host) return null;
    return cut(parsed.host.replace(/^www\./, ''));
  } catch {
    return null;
  }
}

function named(value: unknown): string | null {
  if (typeof value === 'string') return cut(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['name', 'filename', 'title']) {
      if (typeof record[key] === 'string') return cut(record[key] as string);
    }
  }
  return null;
}

function fromRecord(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of FILE_KEYS) {
    const field = record[key];
    if (typeof field === 'string') {
      const found = basename(field);
      if (found) return found;
    } else if (key === 'file') {
      const found = named(field);
      if (found) return basename(found);
    }
  }
  for (const key of ACCOUNT_KEYS) {
    const found = named(record[key]);
    if (found) return found;
  }
  for (const key of PAGE_KEYS) {
    const found = named(record[key]);
    if (found) return found;
  }
  for (const key of URL_KEYS) {
    const field = record[key];
    if (typeof field === 'string') {
      const found = host(field);
      if (found) return found;
    }
  }
  return null;
}

/** An id argument (`importId`, `staging_id`) as a last resort, shortened. */
function fromId(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (CONTEXT_IDS.has(key) || !/(?:[a-z]Id|_id)$/.test(key)) continue;
    if (typeof value === 'string' && value.trim() !== '') return value.length > 8 ? value.slice(0, 8) : value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * What a call was about: a file name, an account, a page, a site — read from
 * its arguments first, then its result, then any id it was given. Null when
 * nothing says, and the tab is then the call's own.
 */
export function subjectOf(input: unknown, output: unknown): string | null {
  return fromRecord(input) ?? fromRecord(output) ?? fromId(input);
}

/** When a result says it stops being good (`expiresAt`), if it does. */
export function expiryOf(output: unknown): string | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  for (const key of ['expiresAt', 'expires_at', 'expires']) {
    const value = record[key];
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  }
  return null;
}

/** The version a tab shows by default: its newest. */
export function latestVersion(item: Renderable): TabVersion | null {
  return item.versions?.at(-1) ?? null;
}

/**
 * What closing a tab records. The newest call it holds: a later call on the
 * same subject is news, and reopens it.
 */
export function tabStamp(item: Renderable): string {
  return latestVersion(item)?.id ?? item.id;
}

/** The tab holding this call among its earlier versions, when one does. */
export function versionHolding(items: readonly Renderable[], callId: string): Renderable | null {
  return items.find((item) => item.id !== callId && (item.versions ?? []).some((version) => version.id === callId)) ?? null;
}

/**
 * Has this tab closed itself?
 *
 *  - `gone`: a result past its own expiry (a staged import nobody committed).
 *    Off the strip and out of the timeline; its chat row still opens it.
 *  - `parked`: a failure that never produced a view. Off the strip, kept in
 *    the timeline with its red dot.
 *
 * A result superseded by the next call on its subject never gets here: it is
 * folded into that tab as an earlier version (`renderablesFrom`).
 */
export function selfClosed(item: Renderable, now: number): 'gone' | 'parked' | null {
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return 'gone';
  if (item.source === 'fallback' && item.tone === 'critical') {
    const versions = item.versions ?? [];
    const failed = (props: unknown): boolean => (props as { failed?: unknown } | null)?.failed === true;
    if (versions.length > 0 ? versions.every((version) => failed(version.props)) : failed(item.props)) return 'parked';
  }
  return null;
}

function time(at: string | null | undefined): number {
  if (!at) return 0;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** When a tab last changed or was looked at, whichever is later. */
export function recencyOf(item: Renderable, touched: Readonly<Record<string, number>>): number {
  return Math.max(time(latestVersion(item)?.at ?? item.at), touched[item.id] ?? 0);
}

/** Most recent first; the conversation's own order breaks a tie, later first. */
export function byRecency(items: readonly Renderable[], touched: Readonly<Record<string, number>> = {}): Renderable[] {
  return items
    .map((item, index) => ({ item, index, at: recencyOf(item, touched) }))
    .sort((a, b) => b.at - a.at || b.index - a.index)
    .map(({ item }) => item);
}

/**
 * Which tabs are on the strip and which are in the timeline.
 *
 * The most recently looked-at few are on the strip, newest first, so opening a
 * fourth moves the oldest into the timeline. Three claims beat recency: the
 * tab being read, a decision waiting on the owner, and platform state marked
 * as happening now (`pinned`) — those can together exceed the room and still
 * all show. A parked failure is never brought back by recency alone.
 * Pinned panels lead the strip; the timeline is newest first.
 */
export function splitTabs(
  renderables: readonly Renderable[],
  activeId: string,
  fits: number = STRIP_TABS,
  touched: Readonly<Record<string, number>> = {},
): { shown: Renderable[]; hidden: Renderable[] } {
  const ordered = byRecency(renderables, touched);
  const keep = new Set(
    renderables
      .filter((item) => item.id === activeId || item.source === 'approval' || item.pinned === true)
      .map((item) => item.id),
  );
  for (const item of ordered) {
    if (keep.size >= fits) break;
    if (item.parked) continue;
    keep.add(item.id);
  }
  const shown = ordered.filter((item) => keep.has(item.id));
  return {
    shown: [...shown.filter((item) => item.pinned === true), ...shown.filter((item) => item.pinned !== true)],
    hidden: ordered.filter((item) => !keep.has(item.id)),
  };
}

export type TimelineGroup = { label: 'Now' | 'Earlier this turn' | 'Earlier'; items: Renderable[] };

/**
 * The timeline behind the strip: Now (the last couple of minutes), Earlier
 * this turn (since the owner last spoke), Earlier. Newest first within each;
 * empty groups are left out.
 */
export function timelineOf(
  items: readonly Renderable[],
  { now, turnStartedAt, touched = {} }: { now: number; turnStartedAt?: string | null; touched?: Readonly<Record<string, number>> },
): TimelineGroup[] {
  const turn = time(turnStartedAt);
  const groups: TimelineGroup[] = [
    { label: 'Now', items: [] },
    { label: 'Earlier this turn', items: [] },
    { label: 'Earlier', items: [] },
  ];
  for (const item of byRecency(items, touched)) {
    const at = time(latestVersion(item)?.at ?? item.at);
    const inTurn = turn > 0 && at >= turn;
    if (at > 0 && at >= now - NOW_MS && (turn === 0 || inTurn)) groups[0]!.items.push(item);
    else if (inTurn) groups[1]!.items.push(item);
    else groups[2]!.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}
