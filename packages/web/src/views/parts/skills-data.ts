/**
 * The Skills page's data: the gateway's `/api/skills` routes and the words
 * the page says about a skill (who uses it, where it came from, why it is
 * untrusted). Kept apart from api.ts so the page owns its own shapes.
 */
import { AGENTS_ROUTE } from '../../routes';
import { ApiError, del, get, post, sendFile } from '../../api';
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
  /** The every-agent policy (no `agents` filter) — not membership: `holders` says who loads it. */
  every: boolean;
  /** The agents that actually load it. */
  holders: SkillHolder[];
  /** A shared skill's: agents with their own skill of this name, which use theirs instead. */
  shadowedBy?: string[];
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
  /** A bundle: SKILL.md with files beside it. `files` counts the others. */
  bundle?: { files: number; scripts: string[]; size: number } | null;
}

export interface SkillsAgent {
  id: string;
  handle: string;
  name: string;
  /** Its file is the owner's, so a grant can be written there. */
  writable: boolean;
  /** It holds host.exec, so it can run a bundle's scripts, asking each time. */
  canRunScripts?: boolean;
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
  bundle?: { files: BundleFile[]; size: number; scripts: string[] };
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

export type BundleFileKind = 'skill' | 'script' | 'font' | 'image' | 'template' | 'data' | 'other';

export interface BundleFile {
  path: string;
  size: number;
  kind: BundleFileKind;
  setup?: boolean;
}

/** One file as the viewer reads it: its text, or only its size when it is not text. */
export interface BundleFileView extends BundleFile {
  text?: string;
  binary?: boolean;
  image?: boolean;
}

/** A .zip read and checked by the gateway, waiting for "Add the skill". */
export interface StagedBundle {
  id: string;
  filename: string;
  packed: number;
  size: number;
  files: BundleFile[];
  scripts: string[];
  skill: { name: string; title: string; description: string; firstLines: string };
  createdAt: string;
}

export type BundleRefusalKind = 'notzip' | 'big' | 'count' | 'noskill' | 'paths' | 'frontmatter' | 'executable' | 'damaged';

/** Why a .zip was not taken, as the gateway saw it (or the page, before sending it). */
export interface BundleRefusal {
  kind: BundleRefusalKind;
  filename: string;
  size?: number;
  files?: number;
  entries?: Array<{ path: string; why: string; target?: string }>;
  looked?: string[];
  /** The gateway's own sentence, for a kind the page has no words of its own for. */
  error?: string;
}

/** A bundle is at most this big unpacked, and holds at most this many files. */
export const BUNDLE_MAX_BYTES = 20 * 1024 * 1024;
export const BUNDLE_MAX_FILES = 500;

const skillPath = (id: string): string => `/skills/${encodeURIComponent(id)}`;
const stagedPath = (id: string): string => `/skills/bundles/${encodeURIComponent(id)}`;

/** Send a .zip; answer what is inside, or throw the refusal. */
async function uploadBundle(file: File): Promise<StagedBundle> {
  try {
    const { staged } = await sendFile<{ staged: StagedBundle }>('/skills/bundles', file, 'bundle.zip');
    return staged;
  } catch (err) {
    const refusal = err instanceof ApiError ? (err.detail as { refusal?: BundleRefusal } | null)?.refusal : undefined;
    if (refusal) throw new BundleRefused({ ...refusal, filename: file.name, error: err instanceof Error ? err.message : undefined });
    throw err;
  }
}

/** A refusal thrown by `skillsApi.uploadBundle`, carrying what the gateway saw. */
export class BundleRefused extends Error {
  override readonly name = 'BundleRefused';
  constructor(readonly refusal: BundleRefusal) {
    super(refusal.error ?? `“${refusal.filename}” was refused.`);
  }
}

export const skillsApi = {
  list: () => get<SkillsView>('/skills'),
  detail: (id: string) => get<SkillDetail>(skillPath(id)),
  downloadUrl: (id: string) => `/api${skillPath(id)}/download`,
  create: (skill: NewSkill) => post<{ skill: SkillRow }>('/skills', skill),
  saveText: (id: string, text: string) => post<{ skill: SkillRow; version?: number; ignored?: string[] }>(`${skillPath(id)}/text`, { text }),
  grant: (id: string, grant: { every?: boolean; agents: string[] }) => post<{ skill: SkillRow }>(`${skillPath(id)}/grants`, grant),
  trust: (id: string) => post<{ skill: SkillRow }>(`${skillPath(id)}/trust`),
  remove: (id: string) => del<{ deleted: string; stopped: string[]; movedTo?: string; versionsKept?: string }>(skillPath(id)),
  file: (id: string, path: string) => get<{ file: BundleFileView }>(`${skillPath(id)}/file`, { path }),
  imageUrl: (id: string, path: string) => `/api${skillPath(id)}/image?path=${encodeURIComponent(path)}`,
  uploadBundle,
  stagedFile: (id: string, path: string) => get<{ file: BundleFileView }>(`${stagedPath(id)}/file`, { path }),
  stagedImageUrl: (id: string, path: string) => `/api${stagedPath(id)}/image?path=${encodeURIComponent(path)}`,
  acceptBundle: (id: string, body: { every?: boolean; agents: string[]; mine: boolean }) => post<{ skill: SkillRow }>(stagedPath(id), body),
  discardBundle: (id: string) => del<{ discarded: string }>(stagedPath(id)),
};

/** The Skills tab, optionally opening one skill's sheet (and one of a bundle's files in it). */
export function skillsRoute(id?: string | null, file?: string | null): string {
  return `${AGENTS_ROUTE}?tab=skills${id ? `&skill=${encodeURIComponent(id)}` : ''}${id && file ? `&skfile=${encodeURIComponent(file)}` : ''}`;
}

/** The bundle file a Skills route opens, if any. */
export function parseSkillFileParam(hash: string): string | null {
  const raw = /[?&]skfile=([^&]+)/.exec(hash)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
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

/** The every-agent policy in one phrase, naming the agents that use their own skill of the name instead. */
export function everyLine(row: SkillRow, agents: readonly SkillsAgent[]): string {
  const except = row.shadowedBy ?? [];
  if (!except.length) return 'Every agent';
  const handles = except.map((id) => `@${agents.find((a) => a.id === id)?.handle ?? id}`);
  return `Every agent except ${andList(handles)} (${except.length === 1 ? 'has its own' : 'each has its own'})`;
}

/** Whether this agent actually loads it (an every-agent skill it shadows with its own does not count). */
export function heldBy(row: SkillRow, agent: string): boolean {
  return row.holders.some((h) => h.agent === agent);
}

/** Who uses it, in one phrase. */
export function holdersLine(row: SkillRow, agents: readonly SkillsAgent[]): string {
  if (row.every) return everyLine(row, agents);
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
    : row.bundle
      ? 'Untrusted: it came in a .zip, so agents read its text as outside text and its scripts can’t run.'
      : 'Untrusted: it came from a file, so agents read it as outside text.';
}

/* ------------------------------------------------------------------ *
 * bundles: words
 * ------------------------------------------------------------------ */

/** 413 KB, 2 MB: what a file or a bundle weighs, as the kit writes it. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, '')} MB`;
}

/** The agents that use it, by id: every agent when it's every agent's. */
export function holderIds(row: SkillRow, agents: readonly SkillsAgent[]): string[] {
  return row.every ? agents.filter((a) => !(row.shadowedBy ?? []).includes(a.id)).map((a) => a.id) : row.holders.map((h) => h.agent);
}

/** One line on a bundle's scripts, for its row: who can run them, who holds the text only. */
export function scriptsLine(row: SkillRow, agents: readonly SkillsAgent[]): string | null {
  const b = row.bundle;
  if (!b) return null;
  const n = b.scripts.length;
  if (!n) return `No scripts · ${b.files} file${b.files === 1 ? '' : 's'} beside the text`;
  const ids = holderIds(row, agents);
  const can = (id: string): boolean => agents.find((a) => a.id === id)?.canRunScripts === true;
  const run = ids.filter(can).map((id) => agentName(agents, id));
  const read = ids.filter((id) => !can(id)).map((id) => agentName(agents, id));
  const scripts = `${n} script${n > 1 ? 's' : ''}`;
  if (row.untrusted) return `${scripts} · they can’t run until you mark it as yours`;
  if (!ids.length) return `${scripts} · they run only through an agent you allow, and ask first`;
  if (!run.length) return `${scripts} · nobody holding it can run them, so it’s text only`;
  return `${scripts} · ${andList(run)} can run them, asking first${read.length ? `; ${andList(read)} ${read.length > 1 ? 'read' : 'reads'} the text only` : ''}`;
}

/** A refusal's title and its lines, as the kit's upload sheet says them. */
export function refusalWords(r: BundleRefusal): { title: string; body: string; items?: Array<{ path: string; rest: string }> } {
  switch (r.kind) {
    case 'big':
      return {
        title: `“${r.filename}” is too big`,
        body: `${r.size ? `It’s ${sizeWords(r.size)}; a` : 'A'} bundle can be up to 20 MB unpacked. Leave large files out — SKILL.md can say where to find them.`,
      };
    case 'count':
      return { title: `“${r.filename}” holds too many files`, body: `It holds ${r.files ?? 'over 500'} files; a bundle can hold up to ${BUNDLE_MAX_FILES}.` };
    case 'noskill': {
      const inside = (r.looked ?? []).filter((l) => l !== '');
      return {
        title: `No SKILL.md in “${r.filename}”`,
        body: `buddi looked at the top${inside.length ? ` and inside ${inside.join(', ')}` : ''}. A bundle needs SKILL.md in one of them, with scripts/ and assets/ beside it.`,
      };
    }
    case 'paths': {
      const n = r.entries?.length ?? 0;
      return {
        title: `“${r.filename}” was refused`,
        body: `${n === 1 ? 'One entry reaches' : `${n === 2 ? 'Two' : n} entries reach`} outside the bundle, so nothing was unpacked. A bundle holds plain files inside its own folder.`,
        items: (r.entries ?? []).map((e) => ({ path: e.path, rest: e.why === 'is a link' && e.target ? `is a link to ${e.target}` : e.why })),
      };
    }
    case 'executable':
      return {
        title: `“${r.filename}” was refused`,
        body: 'Something that runs is outside scripts/, so nothing was kept. A bundle keeps anything that runs in scripts/.',
        items: (r.entries ?? []).map((e) => ({ path: e.path, rest: e.why })),
      };
    case 'frontmatter':
      return { title: `“${r.filename}” has no usable SKILL.md`, body: 'Its SKILL.md needs front matter with a description (when it’s used) between --- lines, then the steps.' };
    case 'notzip':
      return { title: `“${r.filename}” isn’t a .zip or a .md`, body: 'A skill is one Markdown file, or a .zip bundle with SKILL.md inside.' };
    default:
      return { title: `“${r.filename}” was refused`, body: r.error ?? 'It could not be read as a bundle.' };
  }
}

/** The path as the owner knows it: `skills/x.md`, `skills/x/SKILL.md`, or `agents/dev/skills/x.md`. */
export function shortFile(row: SkillRow): string {
  const base = row.file.split(/[\\/]/).pop() ?? row.file;
  if (row.bundle) return `skills/${row.name}/${base}`;
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
