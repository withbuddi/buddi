/**
 * The Skills page's data: the gateway's `/api/skills` routes and the words
 * the page says about a skill (who uses it, where it came from, why it is
 * untrusted). Kept apart from api.ts so the page owns its own shapes.
 */
import { AGENTS_ROUTE } from '../../routes';
import { del, get, post } from '../../api';
import { fmtDay, fmtRelative } from '../../format';

export type SkillGroup = 'mine' | 'learned' | 'plugin' | 'catalogue';

export interface SkillHolder {
  agent: string;
  /** home: in this agent's folder; every: no filter; filter: named by the skill; granted: the agent's file asks for it. */
  how: 'home' | 'every' | 'filter' | 'granted';
}

export type SkillFrom =
  | { kind: 'plugin'; plugin: string; version: string; installed: boolean }
  | { kind: 'catalogue'; package: string; version: string; agent: string }
  | { kind: 'upload'; filename: string };

export interface SkillRow {
  /** The name, or `<agent>/<name>` for one in an agent's folder. */
  id: string;
  name: string;
  title: string;
  description: string;
  group: SkillGroup;
  file: string;
  home: string | null;
  every: boolean;
  holders: SkillHolder[];
  untrusted: 'upload' | 'page' | null;
  provenance: string;
  source: string | null;
  created: string | null;
  updatedAt: string | null;
  learned: { by: string; version: number; edited: boolean; keptAt: string } | null;
  from: SkillFrom | null;
  editable: boolean;
  deletable: boolean;
  shareable: boolean;
}

export interface SkillsAgent {
  id: string;
  handle: string;
  name: string;
  /** Its file is the owner's, so a grant can be written there. */
  writable: boolean;
}

export interface SkillsView {
  skills: SkillRow[];
  agents: SkillsAgent[];
}

export interface SkillDetail {
  skill: SkillRow;
  body: string;
  /** The file as written: front matter and text, what Source shows and Edit changes. */
  text: string;
  versions?: number[];
  onDelete: { stops: string[]; every: boolean; then: 'trash' | 'versions-kept' | 'catalogue-asks' };
}

export interface NewSkill {
  title: string;
  description: string;
  body: string;
  every?: boolean;
  agents?: string[];
  upload?: { filename: string; mine?: boolean };
}

const skillPath = (id: string): string => `/skills/${encodeURIComponent(id)}`;

export const skillsApi = {
  list: () => get<SkillsView>('/skills'),
  detail: (id: string) => get<SkillDetail>(skillPath(id)),
  downloadUrl: (id: string) => `/api${skillPath(id)}/download`,
  create: (skill: NewSkill) => post<{ skill: SkillRow }>('/skills', skill),
  saveText: (id: string, text: string) => post<{ skill: SkillRow; version?: number; ignored?: string[] }>(`${skillPath(id)}/text`, { text }),
  grant: (id: string, grant: { every?: boolean; agents: string[] }) => post<{ skill: SkillRow }>(`${skillPath(id)}/grants`, grant),
  trust: (id: string) => post<{ skill: SkillRow }>(`${skillPath(id)}/trust`),
  remove: (id: string) => del<{ deleted: string; stopped: string[]; movedTo?: string; versionsKept?: string }>(skillPath(id)),
};

/** The Skills tab, optionally opening one skill's sheet. */
export function skillsRoute(id?: string | null): string {
  return `${AGENTS_ROUTE}?tab=skills${id ? `&skill=${encodeURIComponent(id)}` : ''}`;
}

/** The skill a Skills route opens, if any. */
export function parseSkillParam(hash: string): string | null {
  const raw = /[?&]skill=([^&]+)/.exec(hash)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Hands over the file as it is on disk: the gateway answers as an attachment. */
export function downloadSkill(id: string): void {
  const link = document.createElement('a');
  link.href = skillsApi.downloadUrl(id);
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ------------------------------------------------------------------ *
 * words
 * ------------------------------------------------------------------ */

export const SKILL_GROUPS: ReadonlyArray<{ id: SkillGroup; title: string; aside: string }> = [
  { id: 'mine', title: 'Yours', aside: 'Written or uploaded by you.' },
  { id: 'learned', title: 'Learned', aside: 'An agent proposed it and you kept it.' },
  { id: 'plugin', title: 'From plugins', aside: 'Comes with a plugin and goes with it.' },
  { id: 'catalogue', title: 'From the catalogue', aside: 'Came with a teammate. Yours to change.' },
];

export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function agentName(agents: readonly SkillsAgent[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id;
}

export function pluginTitle(plugin: string): string {
  return plugin.charAt(0).toUpperCase() + plugin.slice(1);
}

/** Who uses it, in one phrase. */
export function holdersLine(row: SkillRow, agents: readonly SkillsAgent[]): string {
  if (row.every) return 'Every agent';
  const names = row.holders.map((h) => agentName(agents, h.agent));
  return names.length ? andList(names) : 'No agent uses it yet';
}

export function nobodyUses(row: SkillRow): boolean {
  return !row.every && row.holders.length === 0;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function onDay(day: string): string {
  return day.slice(0, 10) === today() ? 'today' : `on ${fmtDay(day, { compact: true })}`;
}

/**
 * Where it came from. On a row, a learned skill leaves out "learned by" when
 * the agent that proposed it is one of its users, since the line names them.
 */
export function originLine(row: SkillRow, agents: readonly SkillsAgent[], onRow = false): string {
  if (row.learned) {
    const by = row.learned.by;
    const named = onRow && row.holders.some((h) => h.agent === by);
    const kept = row.learned.keptAt ? ` · kept ${fmtRelative(row.learned.keptAt)}` : '';
    return `${named ? '' : `learned by ${agentName(agents, by)} · `}v${row.learned.version}${row.learned.edited ? ' with your correction' : ''}${kept}`;
  }
  const from = row.from;
  if (from?.kind === 'plugin') return `from ${pluginTitle(from.plugin)} ${from.version}`;
  if (from?.kind === 'catalogue') return `came with ${agentName(agents, from.agent)} ${from.version}`;
  if (from?.kind === 'upload') return `uploaded${row.created ? ` ${onDay(row.created)}` : ''} · ${from.filename}`;
  const created = row.created?.slice(0, 10) ?? null;
  const changed = row.updatedAt?.slice(0, 10) ?? null;
  if (created && (!changed || changed <= created)) return `written by you ${onDay(created)}`;
  if (row.updatedAt) return `edited by you ${fmtRelative(row.updatedAt)}`;
  return 'written by you';
}

export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function untrustedLine(row: SkillRow, agents: readonly SkillsAgent[]): string {
  return row.untrusted === 'page'
    ? `Untrusted: a web page was in view when ${agentName(agents, row.learned?.by ?? row.home ?? '')} proposed it.`
    : 'Untrusted: it came from a file, so agents read it as outside text.';
}

/** The path as the owner knows it: `skills/x.md`, or `agents/dev/skills/x.md`. */
export function shortFile(row: SkillRow): string {
  const base = row.file.split(/[\\/]/).pop() ?? row.file;
  return row.home ? `agents/${row.home}/skills/${base}` : `skills/${base}`;
}

/** The agent ids a grant keeps as they are: everyone holding it now. */
export function currentHolders(row: SkillRow): string[] {
  return row.every ? [] : row.holders.map((h) => h.agent);
}

/** What saving an edit means, said under the editor. */
export function editNote(row: SkillRow, agents: readonly SkillsAgent[]): string | null {
  if (row.learned) {
    const by = agentName(agents, row.learned.by);
    return `Saved as v${row.learned.version + 1}, your correction. v${row.learned.version} stays in ${by}’s folder.`;
  }
  if (row.from?.kind === 'catalogue') return `${agentName(agents, row.from.agent)}’s next update will ask before it replaces your change.`;
  return null;
}

/** The delete confirmation's sentence, from what the gateway says a delete does. */
export function deleteSentence(row: SkillRow, onDelete: SkillDetail['onDelete'], agents: readonly SkillsAgent[]): string {
  const names = onDelete.stops.map((id) => agentName(agents, id));
  const by = row.learned ? agentName(agents, row.learned.by) : '';
  if (row.learned && !onDelete.every && onDelete.stops.length === 1 && onDelete.stops[0] === row.learned.by) {
    return `${by} stops using it and won’t propose it again for 90 days. Earlier versions stay in its folder.`;
  }
  const who = onDelete.every
    ? 'Every agent stops using it.'
    : names.length === 0
      ? 'No agent uses it, so nothing changes.'
      : `${andList(names)} ${names.length > 1 ? 'stop' : 'stops'} using it.`;
  const then =
    onDelete.then === 'versions-kept'
      ? `${by} won’t propose it again for 90 days. Earlier versions stay in its folder.`
      : onDelete.then === 'catalogue-asks'
        ? `${row.from?.kind === 'catalogue' ? agentName(agents, row.from.agent) : 'Its teammate'}’s next update asks before bringing it back.`
        : 'The file goes to the trash folder.';
  return `${who} ${then}`;
}

/** What a single `.md` file holds: its name and "when" from the front matter, the title from its first heading. */
export function readSkillFile(filename: string, text: string): { title: string; description: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n*/.exec(normalized);
  const field = (key: string): string => {
    const value = fm ? new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm[1] as string)?.[1] ?? '' : '';
    return value.trim().replace(/^(['"])(.*)\1$/, '$2');
  };
  const body = fm ? normalized.slice(fm[0].length) : normalized;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const named = field('name');
  return {
    title: heading || (named ? capitalized(named.replace(/-/g, ' ')) : filename.replace(/\.md$/i, '')),
    description: field('description'),
    body,
  };
}
