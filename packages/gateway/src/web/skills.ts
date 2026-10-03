/**
 * The Skills page's server side (specs/skills-zone.md, part 1): every skill
 * on this computer, grouped, who holds each, and the owner's writes — write a
 * skill, take one from a single `.md`, edit its text, give it to agents or take
 * it away, mark an uploaded one as theirs, download, delete.
 *
 * Skills stay files; nothing here is a store of its own.
 *
 *  - **Yours**: the owner's shared skills folder (`private/skills`, or the
 *    packaged install's), written by hand, on this page, or uploaded; and a
 *    skill the owner put in one agent's own folder by hand.
 *  - **Learned**: kept from a learning proposal, in the agent's folder
 *    (`learned-skills.ts`); an edit is a new version, a delete keeps them.
 *  - **From plugins**: accepted from a plugin (`source: <plugin>@<version>`);
 *    its text reads only, and it is deleted with the plugin, not here.
 *  - **From the catalogue**: came with a catalogue agent, in its folder
 *    (`source: catalogue/<package>@<version>`). The owner's to change; an edit
 *    or a delete counts as an owner edit for the catalogue's update drift,
 *    because the sidecar records each skill's hash (`plugins/provenance.ts`).
 *
 * Grants are written in the *agent's* file, so the file stays the record: a
 * shared skill given to some agents carries `agents: []` (it loads for nobody
 * by itself) and each holder names it in `skills:`; one given to every agent
 * carries no `agents` key at all. Another agent's own skill is granted by its
 * qualified name, `<agent>/<skill>`. Every write is checked by reloading the
 * catalog; a reload that refuses puts every file back as it was.
 *
 * An uploaded file is `untrusted: true` until the owner marks it as theirs,
 * and until then its text enters the prompt fenced as outside text
 * (`skillsSection` in core).
 *
 * The shipped examples (`examples/agents`, `examples/skills`) belong to the
 * platform and are not listed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  applyFrontmatterPatch,
  currentSkillFile,
  parseAgentFile,
  parseSkillBundle,
  parseSkillFile,
  parseYamlSubset,
  selectSkills,
  serializeYamlValue,
  skillRequestable,
  skillBundleNames,
  skillSlug,
  skillVersions,
  skillVersionsDir,
  splitFrontmatter,
  SKILLS_DIR,
  SKILL_SCRIPT_TOOL,
  BUNDLE_SKILL_FILE,
  type AgentCatalog,
  type FrontmatterPatch,
  type Skill,
} from '@buddi/core';
import type { Pool } from 'pg';
import { readProvenance } from '../plugins/provenance.js';
import { removeLearnedSkillFromWeb } from '../agents/learned-skills.js';
import { replaceBody, trashStamp, writeFilesAtomic, type FileWrite } from '../agents/platform-files.js';
import { bundleFileRows, bundleFileView, bundleImage, incomingDirFor, readStaged, zipBundle, type BundleFileRow } from './skill-bundles.js';

export interface RouteReply {
  status: number;
  body: unknown;
}

export interface SkillsDeps {
  catalog: AgentCatalog & { reload?: () => void };
  /** The owner's agents directory: an agent's own skills are under `<id>/skills`. */
  agentsDir: string;
  /** The owner's shared skills folder: where a written or uploaded skill goes. */
  skillsDir: string;
  /** Where a deleted skill goes: `<private>/.trash/skills`. */
  trashRoot: string;
  /** The names of the plugins installed now. */
  plugins: () => readonly string[];
  now: () => Date;
  /** For a learned skill's delete, which counts its proposal as discarded. */
  pool?: Pool;
  /** Where an uploaded bundle waits for the owner's yes; `<private>/.incoming/skills` by default. */
  incomingDir?: string;
}

export type SkillGroup = 'mine' | 'learned' | 'plugin' | 'catalogue';

export type SkillFrom =
  | { kind: 'plugin'; plugin: string; version: string; installed: boolean }
  | { kind: 'catalogue'; package: string; version: string; agent: string }
  | { kind: 'upload'; filename: string };

export interface SkillHolder {
  agent: string;
  /** home: it lives in this agent's folder; every: no `agents` filter; filter: named by one; granted: the agent's file asks for it. */
  how: 'home' | 'every' | 'filter' | 'granted';
}

export interface SkillRow {
  /** The name, or `<agent>/<name>` for a skill in one agent's folder. Encode it in a path (`%2F`). */
  id: string;
  name: string;
  title: string;
  description: string;
  group: SkillGroup;
  file: string;
  /** The agent whose folder holds it; null for a shared skill. */
  home: string | null;
  /** A shared skill with no `agents` filter: the policy, not membership — see `holders` and `shadowedBy`. */
  every: boolean;
  /** The agents that actually load it, as the catalog resolves each one's skills. */
  holders: SkillHolder[];
  /** A shared skill's: the agents with their own skill of this name, which use theirs instead. */
  shadowedBy: string[];
  /** upload: a file the owner has not marked as theirs (read as outside text); page: untrusted text was in view when it was learned. */
  untrusted: 'upload' | 'page' | null;
  provenance: Skill['provenance'];
  source: string | null;
  created: string | null;
  updatedAt: string | null;
  learned: { by: string; version: number; edited: boolean; keptAt: string } | null;
  from: SkillFrom | null;
  /** Its text can be changed here (not a plugin's). */
  editable: boolean;
  /** It can be deleted here (not while its plugin is installed). */
  deletable: boolean;
  /** It can be given to every agent (a shared skill; one in an agent's folder is granted agent by agent). */
  shareable: boolean;
  /** A bundle (SKILL.md with files beside it): how many files besides the text, its scripts, its size in bytes. */
  bundle: { files: number; scripts: string[]; size: number } | null;
}

export interface SkillsAgent {
  id: string;
  handle: string;
  name: string;
  /** Its file is the owner's, so a grant can be written there (not a shipped example). */
  writable: boolean;
  /** It holds the tool a bundle's scripts run through (`host.exec`), so it can run them, asking each time. */
  canRunScripts: boolean;
}

/** The largest skill text accepted, in characters. */
export const SKILL_TEXT_MAX = 50_000;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 300;

/** `mail@0.1.3`: what `platform.accept_plugin_skill` and a plugin's agent write in `source`. */
const PLUGIN_SOURCE = /^([a-z0-9][a-z0-9._-]*)@([^\s/]+)$/;
const CATALOGUE_SOURCE = /^catalogue\/(.+)@([^@\s]+)$/;
const UPLOAD_SOURCE = /^upload\/(.+)$/;

const fail = (status: number, error: string): RouteReply => ({ status, body: { error } });

/* ------------------------------------------------------------------ *
 * Reading the inventory
 * ------------------------------------------------------------------ */

interface Entry {
  skill: Skill;
  home: string | null;
  /** The agent's sidecar, for a skill that came with a catalogue agent. */
  catalogueOf?: { package: string; version: string };
}

interface AgentRecord {
  id: string;
  handle: string;
  name: string;
  file: string;
  writable: boolean;
  declared: string[];
  canRunScripts: boolean;
}

function readDir(dir: string, scope: 'private' | 'shared'): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const fileName of names) {
    const file = path.join(dir, fileName);
    try {
      out.push(parseSkillFile(readFileSync(file, 'utf8'), { fileName: fileName.slice(0, -3), file, scope }));
    } catch {
      // A file the loader refuses is the catalog's to report; it is not a skill anybody holds.
    }
  }
  // Bundles: `<name>/SKILL.md` with its files beside it.
  for (const name of skillBundleNames(dir)) {
    try {
      out.push(parseSkillBundle(path.join(dir, name), { scope }));
    } catch {
      // As above: the catalog reports it.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function agentRecords(catalog: AgentCatalog): AgentRecord[] {
  return catalog
    .list()
    .map((summary) => catalog.get(summary.id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined)
    .map((agent) => {
      let declared: string[] = [];
      try {
        declared = [...(parseAgentFile(readFileSync(agent.file, 'utf8'), { file: agent.file }).frontmatter.skills ?? [])];
      } catch {
        declared = [];
      }
      return {
        id: agent.id, handle: agent.handle, name: agent.name, file: agent.file, writable: agent.source === 'private', declared,
        canRunScripts: (agent.tools ?? []).includes(SKILL_SCRIPT_TOOL),
      };
    });
}

function inventory(deps: SkillsDeps, agents: readonly AgentRecord[]): Entry[] {
  const entries: Entry[] = readDir(deps.skillsDir, 'shared').map((skill) => ({ skill, home: null }));
  for (const agent of agents) {
    if (!agent.writable) continue;
    const dir = path.dirname(agent.file);
    const sidecar = readProvenance(dir);
    const catalogueOf = sidecar?.source === 'market' && sidecar.package ? { package: sidecar.package, version: sidecar.version } : undefined;
    for (const skill of readDir(path.join(dir, SKILLS_DIR), 'private')) {
      entries.push({ skill, home: agent.id, ...(catalogueOf ? { catalogueOf } : {}) });
    }
  }
  return entries;
}

function idOf(entry: Pick<Entry, 'home'> & { skill: Pick<Skill, 'name'> }): string {
  return entry.home === null ? entry.skill.name : `${entry.home}/${entry.skill.name}`;
}

function groupOf(entry: Entry): { group: SkillGroup; from: SkillFrom | null } {
  const { skill } = entry;
  if (skill.learned) return { group: 'learned', from: null };
  const source = skill.source ?? '';
  const catalogue = CATALOGUE_SOURCE.exec(source);
  if (catalogue && entry.home !== null) {
    return { group: 'catalogue', from: { kind: 'catalogue', package: catalogue[1] as string, version: catalogue[2] as string, agent: entry.home } };
  }
  const plugin = skill.provenance === 'imported' ? PLUGIN_SOURCE.exec(source) : null;
  if (plugin) return { group: 'plugin', from: { kind: 'plugin', plugin: plugin[1] as string, version: plugin[2] as string, installed: false } };
  const upload = UPLOAD_SOURCE.exec(source);
  return { group: 'mine', from: upload ? { kind: 'upload', filename: upload[1] as string } : null };
}

/** The first `# heading` of the text, else the name in words. */
function titleOf(skill: Skill): string {
  if (skill.title) return skill.title;
  const heading = /^#\s+(.+)$/m.exec(skill.body)?.[1]?.trim();
  if (heading) return heading;
  const words = skill.name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether `agentId` has its own skill called `name`, which shadows a shared one for it. */
function ownsName(entries: readonly Entry[], agentId: string, name: string): boolean {
  return entries.some((e) => e.home === agentId && e.skill.name === name);
}

/** An agent's own skills: from the inventory for the owner's agents, from its folder for a shipped one. */
function privateSkillsOf(agents: readonly AgentRecord[], entries: readonly Entry[], agentId: string): Skill[] | undefined {
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return undefined;
  if (agent.writable) return entries.filter((e) => e.home === agentId).map((e) => e.skill);
  return readDir(path.join(path.dirname(agent.file), SKILLS_DIR), 'private');
}

/**
 * The skills an agent loads, as core's `selectSkills` picks them from these
 * entries — with `declared` in place of its file's list when given. A plain
 * name that is not a shared skill here (a shipped one) is left out rather
 * than refused: the catalog's own load says what is wrong with it.
 */
function resolvedFor(agent: AgentRecord, agents: readonly AgentRecord[], entries: readonly Entry[], declared: readonly string[] = agent.declared): Skill[] {
  const shared = entries.filter((e) => e.home === null).map((e) => e.skill);
  const own = privateSkillsOf(agents, entries, agent.id) ?? [];
  const asked = declared.filter((name) => name.includes('/') || own.some((s) => s.name === name) || shared.some((s) => s.name === name && skillRequestable(s, agent.id)));
  return selectSkills(agent.id, asked, own, shared, (id) => privateSkillsOf(agents, entries, id));
}

function holdersOf(entry: Entry, agents: readonly AgentRecord[], entries: readonly Entry[] = []): { every: boolean; holders: SkillHolder[] } {
  const { skill } = entry;
  if (entry.home !== null) {
    const ref = idOf(entry);
    return {
      every: false,
      holders: [
        { agent: entry.home, how: 'home' },
        // Granted, and not displaced by another skill of the name the agent loads first.
        ...agents
          .filter((a) => a.id !== entry.home && a.declared.includes(ref) && resolvedFor(a, agents, entries).some((s) => s.file === skill.file))
          .map((a) => ({ agent: a.id, how: 'granted' as const })),
      ],
    };
  }
  // An agent with its own skill of this name does not use the shared one.
  agents = agents.filter((a) => !ownsName(entries, a.id, skill.name));
  if (skill.agents === undefined) return { every: true, holders: agents.map((a) => ({ agent: a.id, how: 'every' as const })) };
  const holders: SkillHolder[] = [];
  for (const a of agents) {
    if (skill.agents.includes(a.id)) holders.push({ agent: a.id, how: 'filter' });
    else if (a.declared.includes(skill.name)) holders.push({ agent: a.id, how: 'granted' });
  }
  return { every: false, holders };
}

function rowOf(entry: Entry, agents: readonly AgentRecord[], installed: ReadonlySet<string>, entries: readonly Entry[] = []): SkillRow {
  const { skill } = entry;
  const grouped = groupOf(entry);
  const from: SkillFrom | null =
    grouped.from?.kind === 'plugin' ? { ...grouped.from, installed: installed.has(grouped.from.plugin) } : grouped.from;
  let updatedAt: string | null = null;
  try {
    updatedAt = statSync(skill.file).mtime.toISOString();
  } catch {
    updatedAt = null;
  }
  const { every, holders } = holdersOf(entry, agents, entries);
  return {
    id: idOf(entry),
    name: skill.name,
    title: titleOf(skill),
    description: skill.description,
    group: grouped.group,
    file: skill.file,
    home: entry.home,
    every,
    holders,
    shadowedBy: entry.home === null ? agents.filter((a) => ownsName(entries, a.id, skill.name)).map((a) => a.id) : [],
    untrusted: !skill.untrusted ? null : skill.learned ? 'page' : 'upload',
    provenance: skill.provenance,
    source: skill.source ?? null,
    created: skill.created ?? null,
    updatedAt,
    learned: skill.learned
      ? { by: skill.learned.agent || entry.home || '', version: skill.learned.version, edited: skill.learned.edited, keptAt: skill.learned.keptAt }
      : null,
    from,
    editable: grouped.group !== 'plugin',
    deletable: !(from?.kind === 'plugin' && from.installed),
    shareable: entry.home === null,
    bundle: skill.bundle ? { files: skill.bundle.files.length, scripts: skill.bundle.scripts, size: skill.bundle.size } : null,
  };
}

interface Snapshot {
  agents: AgentRecord[];
  entries: Entry[];
  installed: Set<string>;
}

function snapshot(deps: SkillsDeps): Snapshot {
  const agents = agentRecords(deps.catalog);
  return { agents, entries: inventory(deps, agents), installed: new Set(deps.plugins()) };
}

function find(snap: Snapshot, id: string): Entry | undefined {
  return snap.entries.find((e) => idOf(e) === id);
}

const GROUP_ORDER: readonly SkillGroup[] = ['mine', 'learned', 'plugin', 'catalogue'];

/** `GET /api/skills`: every skill, grouped, and the agents a picker offers. */
export function listSkillsRoute(deps: SkillsDeps): RouteReply {
  const snap = snapshot(deps);
  const skills = snap.entries
    .map((e) => rowOf(e, snap.agents, snap.installed, snap.entries))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.title.localeCompare(b.title));
  return { status: 200, body: { skills, agents: agentsView(snap.agents) } };
}

function agentsView(agents: readonly AgentRecord[]): SkillsAgent[] {
  return agents.map(({ id, handle, name, writable, canRunScripts }) => ({ id, handle, name, writable, canRunScripts }));
}

function detail(snap: Snapshot, entry: Entry): Record<string, unknown> {
  const row = rowOf(entry, snap.agents, snap.installed, snap.entries);
  const versions = entry.skill.learned && entry.home !== null ? skillVersions(path.dirname(entry.skill.file), entry.skill.name) : [];
  return {
    skill: row,
    body: entry.skill.body,
    text: readFileSync(entry.skill.file, 'utf8'),
    ...(versions.length > 0 ? { versions } : {}),
    ...(entry.skill.bundle ? { bundle: { files: bundleFileRows(entry.skill.bundle.dir), size: entry.skill.bundle.size, scripts: entry.skill.bundle.scripts } } : {}),
    /*
     * What a delete does, for the confirmation: who stops using it, and what
     * becomes of the file (the trash; a learned one's versions stay and it is
     * not proposed again for 90 days; a catalogue one's next update asks
     * before bringing it back).
     */
    onDelete: {
      stops: row.holders.map((h) => h.agent),
      every: row.every,
      then: row.group === 'learned' ? 'versions-kept' : row.group === 'catalogue' ? 'catalogue-asks' : 'trash',
    },
    agents: agentsView(snap.agents),
  };
}

/** `GET /api/skills/:id`: one skill whole — the row, its text and the file as written. */
export function skillDetailRoute(deps: SkillsDeps, id: string): RouteReply {
  const snap = snapshot(deps);
  const entry = find(snap, id);
  if (!entry) return fail(404, `There is no skill "${id}".`);
  return { status: 200, body: detail(snap, entry) };
}

/** `GET /api/skills/:id/download`: the file as it is on disk, or a bundle as a .zip. Null when there is none. */
export function skillDownload(deps: SkillsDeps, id: string): { filename: string; text: string } | { filename: string; zip: Uint8Array } | null {
  const entry = find(snapshot(deps), id);
  if (!entry) return null;
  if (entry.skill.bundle) return { filename: `${entry.skill.name}.zip`, zip: zipBundle(entry.skill.bundle.dir, entry.skill.name) };
  return { filename: `${entry.skill.name}.md`, text: readFileSync(entry.skill.file, 'utf8') };
}

/** `GET /api/skills/:id/file?path=`: one of a bundle's files, for the sheet's viewer. */
export function skillFileRoute(deps: SkillsDeps, id: string, rel: string): RouteReply {
  const entry = find(snapshot(deps), id);
  if (!entry) return fail(404, `There is no skill "${id}".`);
  if (!entry.skill.bundle) return fail(404, `"${id}" is one file, not a bundle.`);
  return bundleFileView(entry.skill.bundle.dir, rel);
}

/** `GET /api/skills/:id/image?path=`: a bundle's picture. Null when it is not one. */
export function skillImage(deps: SkillsDeps, id: string, rel: string): { bytes: Buffer; type: string } | null {
  const entry = find(snapshot(deps), id);
  return entry?.skill.bundle ? bundleImage(entry.skill.bundle.dir, rel) : null;
}

/* ------------------------------------------------------------------ *
 * Writing, checked by a reload
 * ------------------------------------------------------------------ */

/**
 * Write every file at once, then reload the catalog. A reload that refuses
 * puts every file back (and removes the ones that were new) and answers 409
 * with the loader's sentence: a write here never leaves an installation whose
 * agents do not load.
 */
function commit(deps: SkillsDeps, writes: readonly FileWrite[], removes: ReadonlyArray<{ from: string; to: string }> = []): string | null {
  const before = writes.map((w) => ({ path: w.path, content: existsSync(w.path) ? readFileSync(w.path, 'utf8') : null }));
  writeFilesAtomic(writes);
  const moved: Array<{ from: string; to: string }> = [];
  for (const move of removes) {
    mkdirSync(path.dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
    moved.push(move);
  }
  if (!deps.catalog.reload) return null;
  try {
    deps.catalog.reload();
    return null;
  } catch (err) {
    for (const move of moved.reverse()) renameSync(move.to, move.from);
    writeFilesAtomic(before.filter((b) => b.content !== null).map((b) => ({ path: b.path, content: b.content as string })));
    for (const b of before) if (b.content === null) rmQuiet(b.path);
    try {
      deps.catalog.reload();
    } catch {
      // The previous catalog is still serving; the next load says what is wrong.
    }
    return err instanceof Error ? err.message : String(err);
  }
}

function rmQuiet(file: string): void {
  rmSync(file, { force: true });
}

/** An agent file's `skills:` patched to `list`, the whole file checked as the loader reads it. */
function agentWithSkills(agent: AgentRecord, list: readonly string[]): FileWrite {
  const source = readFileSync(agent.file, 'utf8');
  const unique = [...new Set(list)];
  const text = applyFrontmatterPatch(source, { skills: unique.length === 0 ? null : unique }, agent.file);
  parseAgentFile(text, { file: agent.file });
  return { path: agent.file, content: text };
}

/** A skill file's front matter patched, its body kept or replaced. */
function patchedSkill(entry: Entry, patch: FrontmatterPatch, body?: string): string {
  const source = readFileSync(entry.skill.file, 'utf8');
  const patched = applyFrontmatterPatch(source, patch, entry.skill.file);
  const text = body === undefined ? patched : replaceBody(patched, body, entry.skill.file);
  parseSkillFile(text, { fileName: entry.skill.name, file: entry.skill.file });
  return text;
}

interface GrantPlan {
  writes: FileWrite[];
  error?: RouteReply;
}

/**
 * The files a grant changes: the skill's own `agents` key for a shared skill,
 * and the `skills:` line of every agent whose holding changes.
 */
function planGrant(snap: Snapshot, entry: Entry, every: boolean, wanted: readonly string[], skillText?: string): GrantPlan {
  const unknown = wanted.filter((id) => !snap.agents.some((a) => a.id === id));
  if (unknown.length > 0) return { writes: [], error: fail(400, `No agent is called ${unknown.join(', ')}.`) };
  const ref = idOf(entry);
  const writes: FileWrite[] = [];
  const agentWrite = (agent: AgentRecord, hold: boolean): RouteReply | null => {
    const has = agent.declared.includes(ref);
    if (has === hold) return null;
    if (!agent.writable) {
      return fail(409, `${agent.name} ships with buddi, so its file is not yours to change. Ask Agent Father to make it yours first; then it can be given skills.`);
    }
    writes.push(agentWithSkills(agent, hold ? [...agent.declared, ref] : agent.declared.filter((s) => s !== ref)));
    return null;
  };

  if (entry.home !== null) {
    if (every) return { writes, error: fail(409, `"${titleOf(entry.skill)}" lives in ${entry.home}'s folder, so it is given agent by agent, not to every agent.`) };
    if (!wanted.includes(entry.home)) {
      return { writes, error: fail(409, `"${titleOf(entry.skill)}" lives in ${entry.home}'s folder, so ${entry.home} always uses it. Delete it to stop that.`) };
    }
    for (const agent of snap.agents) {
      if (agent.id === entry.home) continue;
      const hold = wanted.includes(agent.id);
      if (hold) {
        // Checked for a grant already written too: a shared skill given later may have taken the name.
        const others = resolvedFor(agent, snap.agents, snap.entries, agent.declared.filter((s) => s !== ref));
        if (others.some((s) => s.name === entry.skill.name)) {
          return { writes, error: fail(409, `${agent.name} already has a skill called "${entry.skill.name}"; one name, one procedure.`) };
        }
      }
      const refused = agentWrite(agent, hold);
      if (refused) return { writes, error: refused };
    }
    return { writes };
  }

  // A shared skill: its `agents` key says "every agent" (absent) or "those that ask" ([]).
  const patch: FrontmatterPatch = { agents: every ? null : [] };
  const source = skillText ?? readFileSync(entry.skill.file, 'utf8');
  const skillFile = applyFrontmatterPatch(source, patch, entry.skill.file);
  parseSkillFile(skillFile, { fileName: entry.skill.name, file: entry.skill.file });
  if (skillFile !== source || skillText !== undefined) writes.push({ path: entry.skill.file, content: skillFile });
  const shadowedFor = wanted.filter((id) => ownsName(snap.entries, id, entry.skill.name));
  if (!every && shadowedFor.length > 0) {
    const names = shadowedFor.map((id) => snap.agents.find((a) => a.id === id)?.name ?? id).join(', ');
    return {
      writes,
      error: fail(409, `${names} already ${shadowedFor.length === 1 ? 'has its' : 'have their'} own skill called "${entry.skill.name}", which ${shadowedFor.length === 1 ? 'it uses' : 'they use'} instead of the shared one. Give the shared one to other agents, or delete the agent's own first.`),
    };
  }
  /*
   * An agent given this skill that loads another agent's own skill of the
   * same name (`<agent>/<name>`) would lose that one to it: refuse, naming
   * them, rather than report a grant that no longer runs.
   */
  const displaced = snap.agents.flatMap((agent) => {
    if (ownsName(snap.entries, agent.id, entry.skill.name)) return [];
    if (!every && !wanted.includes(agent.id)) return [];
    const loaded = resolvedFor(agent, snap.agents, snap.entries).find((s) => s.name === entry.skill.name);
    const owner = loaded && snap.entries.find((e) => e.skill.file === loaded.file && e.home !== null && e.home !== agent.id)?.home;
    return owner ? [{ agent, owner }] : [];
  });
  if (displaced.length > 0) {
    const lines = displaced.map(({ agent, owner }) => `${agent.name} uses ${owner}'s own "${entry.skill.name}" (${owner}/${entry.skill.name})`);
    return {
      writes,
      error: fail(409, `${lines.join('; ')}. The shared one would replace it; take that grant away first${every ? '' : `, or leave ${displaced.length === 1 ? 'that agent' : 'those agents'} out`}.`),
    };
  }
  for (const agent of snap.agents) {
    const hold = !every && wanted.includes(agent.id);
    if (!agent.writable) {
      // An example's file cannot change; it can only lose the skill by the skill's own key.
      if (hold !== agent.declared.includes(ref) && (hold || agent.declared.includes(ref))) {
        return { writes, error: fail(409, `${agent.name} ships with buddi, so its file is not yours to change. Ask Agent Father to make it yours first; then its skills can change.`) };
      }
      continue;
    }
    const refused = agentWrite(agent, hold);
    if (refused) return { writes, error: refused };
  }
  return { writes };
}

function parseGrant(body: Record<string, unknown>): { every: boolean; agents: string[] } | string {
  const every = body.every === true;
  const agents = body.agents ?? [];
  if (!Array.isArray(agents) || !agents.every((a) => typeof a === 'string')) return '`agents` must be a list of agent ids.';
  if (body.every !== undefined && typeof body.every !== 'boolean') return '`every` must be true or false.';
  return { every, agents: [...new Set(agents as string[])] };
}

function answer(deps: SkillsDeps, id: string, status = 200, extra: Record<string, unknown> = {}): RouteReply {
  const snap = snapshot(deps);
  const entry = find(snap, id);
  return { status, body: { ...(entry ? { skill: rowOf(entry, snap.agents, snap.installed, snap.entries) } : {}), ...extra } };
}

/** `POST /api/skills/:id/grants` `{ every?, agents }`: who uses it, written in each agent's file. */
export function grantSkillRoute(deps: SkillsDeps, id: string, body: Record<string, unknown>): RouteReply {
  const grant = parseGrant(body);
  if (typeof grant === 'string') return fail(400, grant);
  const snap = snapshot(deps);
  const entry = find(snap, id);
  if (!entry) return fail(404, `There is no skill "${id}".`);
  const plan = planGrant(snap, entry, grant.every, grant.agents);
  if (plan.error) return plan.error;
  const refused = commit(deps, plan.writes);
  if (refused) return fail(409, refused);
  return answer(deps, id);
}

/* ---------------- write a new one, or take one from a .md ---------------- */

function oneLine(value: unknown, field: string, max: number): string | { error: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `\`${field}\` is required.` };
  const line = value.replace(/\s+/g, ' ').trim();
  if (line.length > max) return { error: `\`${field}\` is at most ${max} characters.` };
  return line;
}

/** A free name for a new shared skill: not a shared one, and not any agent's own (that would collide in its prompt). */
function freeName(snap: Snapshot, wanted: string): string {
  // `bundles` is the upload's own path under /api/skills.
  const taken = new Set([...snap.entries.map((e) => e.skill.name), 'bundles']);
  // The owner's agents' own skills are in the inventory already; the shipped ones' are not.
  for (const agent of snap.agents) {
    if (agent.writable) continue;
    for (const s of readDir(path.join(path.dirname(agent.file), SKILLS_DIR), 'private')) taken.add(s.name);
  }
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted.slice(0, 56)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * `POST /api/skills` `{ title, description, body, every?, agents?, upload?: { filename, mine? } }`.
 * The new file goes in the owner's shared skills folder; an upload not marked
 * as theirs is `untrusted: true`.
 */
export function createSkillRoute(deps: SkillsDeps, body: Record<string, unknown>): RouteReply {
  const title = oneLine(body.title, 'title', TITLE_MAX);
  if (typeof title !== 'string') return fail(400, title.error);
  const description = oneLine(body.description, 'description', DESCRIPTION_MAX);
  if (typeof description !== 'string') return fail(400, description.error);
  if (typeof body.body !== 'string' || body.body.trim() === '') return fail(400, '`body` is required: the steps the skill holds.');
  const text = body.body.replace(/\r\n/g, '\n');
  if (text.length > SKILL_TEXT_MAX) return fail(413, `A skill is at most ${SKILL_TEXT_MAX / 1000} KB of text.`);
  const grant = parseGrant(body);
  if (typeof grant === 'string') return fail(400, grant);
  let upload: { filename: string; mine: boolean } | null = null;
  if (body.upload !== undefined) {
    const u = body.upload as Record<string, unknown> | null;
    if (u === null || typeof u !== 'object' || typeof u.filename !== 'string') return fail(400, '`upload` is `{ filename, mine? }`.');
    const filename = path.basename(u.filename).replace(/[\r\n"]/g, '').trim();
    if (!/\.md$/i.test(filename)) return fail(415, 'Only a Markdown file (.md) can be taken as a skill. Bundles (.zip) come later.');
    upload = { filename, mine: u.mine === true };
  }

  const snap = snapshot(deps);
  const name = freeName(snap, skillSlug(title));
  const file = path.join(deps.skillsDir, `${name}.md`);
  const today = deps.now().toISOString().slice(0, 10);
  const lines = [
    `name: ${name}`,
    `title: ${serializeYamlValue(title)}`,
    `description: ${serializeYamlValue(description)}`,
    `provenance: ${upload && !upload.mine ? 'imported' : 'owner'}`,
    ...(upload ? [`source: ${serializeYamlValue(`upload/${upload.filename}`)}`] : []),
    `created: "${today}"`,
    ...(grant.every ? [] : ['agents: []']),
    ...(upload && !upload.mine ? ['untrusted: true'] : []),
  ];
  const content = `---\n${lines.join('\n')}\n---\n\n${text.trim()}\n`;
  let skill: Skill;
  try {
    skill = parseSkillFile(content, { fileName: name, file, scope: 'shared' });
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : String(err));
  }
  const entry: Entry = { skill, home: null };
  const plan = planGrant({ ...snap, entries: [...snap.entries, entry] }, entry, grant.every, grant.agents, content);
  if (plan.error) return plan.error;
  const writes = plan.writes.some((w) => w.path === file) ? plan.writes : [{ path: file, content }, ...plan.writes];
  const refused = commit(deps, writes);
  if (refused) return fail(409, refused);
  return answer(deps, name, 201);
}

/* ---------------- edit the text ---------------- */

/** What an edit asks for: the whole file as the Source view shows it, or the fields. */
function editOf(entry: Entry, body: Record<string, unknown>): { description?: string; title?: string; body: string; ignored: string[] } | string {
  if (typeof body.text === 'string') {
    const raw = body.text.replace(/\r\n/g, '\n');
    if (raw.length > SKILL_TEXT_MAX) return `A skill is at most ${SKILL_TEXT_MAX / 1000} KB of text.`;
    if (!raw.trimStart().startsWith('---')) return { body: raw, ignored: [] };
    let fm: Record<string, unknown>;
    let rest: string;
    try {
      const split = splitFrontmatter(raw.trimStart());
      fm = parseYamlSubset(split.frontmatter) as Record<string, unknown>;
      rest = split.body;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (fm.name !== undefined && fm.name !== entry.skill.name) return `The name is the file's name ("${entry.skill.name}") and stays; change the title instead.`;
    const out: { description?: string; title?: string; body: string; ignored: string[] } = {
      body: rest,
      ignored: Object.keys(fm).filter((k) => !['name', 'description', 'title'].includes(k) && JSON.stringify(fm[k]) !== JSON.stringify(currentKey(entry, k))),
    };
    if (typeof fm.description === 'string') out.description = fm.description;
    if (typeof fm.title === 'string') out.title = fm.title;
    return out;
  }
  if (typeof body.body !== 'string') return 'Send `text` (the whole file) or `body` (the steps), with `description` and `title` if they change.';
  if (body.body.length > SKILL_TEXT_MAX) return `A skill is at most ${SKILL_TEXT_MAX / 1000} KB of text.`;
  return {
    body: body.body.replace(/\r\n/g, '\n'),
    ignored: [],
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
  };
}

function currentKey(entry: Entry, key: string): unknown {
  try {
    const split = splitFrontmatter(readFileSync(entry.skill.file, 'utf8'));
    return (parseYamlSubset(split.frontmatter) as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * `PUT /api/skills/:id` `{ text }` or `{ body, description?, title? }`.
 * A learned skill's edit is version n+1 marked as the owner's correction (the
 * earlier versions stay); a catalogue skill's counts as an owner edit, so the
 * next update asks before replacing it; a plugin's reads only. The front
 * matter's other keys (who holds it, where it came from, the untrusted mark)
 * are not changed by an edit; they are named back in `ignored`.
 */
export function editSkillRoute(deps: SkillsDeps, id: string, body: Record<string, unknown>): RouteReply {
  const snap = snapshot(deps);
  const entry = find(snap, id);
  if (!entry) return fail(404, `There is no skill "${id}".`);
  const row = rowOf(entry, snap.agents, snap.installed, snap.entries);
  if (!row.editable) {
    return fail(409, `"${row.title}" comes with the ${row.from?.kind === 'plugin' ? row.from.plugin : ''} plugin, so it is changed there. To stop an agent using it, take it away.`);
  }
  const edit = editOf(entry, body);
  if (typeof edit === 'string') return fail(400, edit);
  if (edit.body.trim() === '') return fail(400, 'A skill needs its steps; to remove it, delete it.');
  const patch: FrontmatterPatch = {};
  if (edit.description !== undefined) {
    const d = oneLine(edit.description, 'description', DESCRIPTION_MAX);
    if (typeof d !== 'string') return fail(400, d.error);
    patch.description = d;
  }
  if (edit.title !== undefined) {
    const t = oneLine(edit.title, 'title', TITLE_MAX);
    if (typeof t !== 'string') return fail(400, t.error);
    patch.title = t;
  }
  const writes: FileWrite[] = [];
  let version: number | undefined;
  try {
    if (entry.skill.learned && entry.home !== null) {
      const dir = path.dirname(entry.skill.file);
      version = Math.max(entry.skill.learned.version, ...skillVersions(dir, entry.skill.name)) + 1;
      const text = patchedSkill(entry, { ...patch, version, edited: true }, edit.body);
      writes.push({ path: path.join(skillVersionsDir(dir, entry.skill.name), `v${version}.md`), content: text });
      writes.push({ path: currentSkillFile(dir, entry.skill.name), content: text });
    } else {
      writes.push({ path: entry.skill.file, content: patchedSkill(entry, patch, edit.body) });
    }
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : String(err));
  }
  const refused = commit(deps, writes);
  if (refused) return fail(409, refused);
  return answer(deps, id, 200, {
    ...(version === undefined ? {} : { version }),
    ...(edit.ignored.length > 0 ? { ignored: edit.ignored } : {}),
  });
}

/* ---------------- mark as mine ---------------- */

/** `POST /api/skills/:id/trust`: the owner has read it; its text is composed as theirs from now on. */
export function trustSkillRoute(deps: SkillsDeps, id: string): RouteReply {
  const snap = snapshot(deps);
  const entry = find(snap, id);
  if (!entry) return fail(404, `There is no skill "${id}".`);
  if (!entry.skill.untrusted) return answer(deps, id);
  let text: string;
  try {
    text = patchedSkill(entry, { untrusted: entry.skill.learned ? false : null });
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : String(err));
  }
  const refused = commit(deps, [{ path: entry.skill.file, content: text }]);
  if (refused) return fail(409, refused);
  return answer(deps, id);
}

/* ---------------- delete ---------------- */

/**
 * `DELETE /api/skills/:id`. Every agent that asked for it by name stops (its
 * `skills:` line loses the name in the same write). A learned one's current
 * file goes and its versions stay, and its proposal counts as discarded, so
 * the agent does not propose it again for 90 days; anything else goes to the
 * trash folder beside the agents. A plugin's is deleted with the plugin.
 */
export async function deleteSkillRoute(deps: SkillsDeps, id: string): Promise<RouteReply> {
  const snap = snapshot(deps);
  const entry = find(snap, id);
  if (!entry) return fail(404, `There is no skill "${id}".`);
  const row = rowOf(entry, snap.agents, snap.installed, snap.entries);
  if (!row.deletable && row.from?.kind === 'plugin') {
    return fail(409, `"${row.title}" comes with the ${row.from.plugin} plugin and goes with it. To stop an agent using it, take it away.`);
  }
  const ref = idOf(entry);
  const stopped = row.holders.map((h) => h.agent);
  const writes: FileWrite[] = [];
  for (const agent of snap.agents) {
    if (!agent.declared.includes(ref)) continue;
    if (!agent.writable) {
      return fail(409, `${agent.name} ships with buddi and its file asks for "${entry.skill.name}", so it cannot be deleted while that file needs it.`);
    }
    writes.push(agentWithSkills(agent, agent.declared.filter((s) => s !== ref)));
  }

  if (entry.skill.learned && entry.home !== null) {
    if (!deps.pool) return fail(503, 'A learned skill is removed with its proposal, and the database is not reachable.');
    // The references first, so the reload that follows the removal finds nothing dangling.
    if (writes.length > 0) {
      const refused = commit(deps, writes);
      if (refused) return fail(409, refused);
    }
    const removed = await removeLearnedSkillFromWeb(
      { pool: deps.pool, catalog: deps.catalog, now: deps.now, reload: () => deps.catalog.reload?.() },
      entry.home,
      entry.skill.name,
    );
    if (!removed.ok) return fail(removed.status, removed.error);
    return {
      status: 200,
      body: { deleted: id, stopped, versionsKept: skillVersionsDir(path.dirname(entry.skill.file), entry.skill.name) },
    };
  }

  const stamp = trashStamp(deps.now());
  const bundleDir = entry.skill.bundle?.dir;
  const movedTo = path.join(deps.trashRoot, 'skills', `${entry.home === null ? '' : `${entry.home}-`}${entry.skill.name}-${stamp}${bundleDir ? '' : '.md'}`);
  const refused = commit(deps, writes, [{ from: bundleDir ?? entry.skill.file, to: movedTo }]);
  if (refused) return fail(409, refused);
  return { status: 200, body: { deleted: id, stopped, movedTo } };
}

/* ------------------------------------------------------------------ *
 * Bundles: taking a staged upload, and what the exec tool asks
 * ------------------------------------------------------------------ */

/** Where a staged upload waits: beside the skills folder, never inside it. */
function incomingOf(deps: SkillsDeps): string {
  return deps.incomingDir ?? incomingDirFor(deps.skillsDir);
}

/** `GET /api/skills/bundles/:staged/file?path=`: one file of an upload not kept yet, for the preview's viewer. */
export function stagedFileRoute(deps: SkillsDeps, stagedId: string, rel: string): RouteReply {
  const found = readStaged(incomingOf(deps), stagedId);
  if (!found) return fail(404, 'That upload is gone: upload the .zip again.');
  return bundleFileView(found.dir, rel);
}

/** `GET /api/skills/bundles/:staged/image?path=`. */
export function stagedImage(deps: SkillsDeps, stagedId: string, rel: string): { bytes: Buffer; type: string } | null {
  const found = readStaged(incomingOf(deps), stagedId);
  return found ? bundleImage(found.dir, rel) : null;
}

/**
 * `POST /api/skills/bundles/:staged` `{ every?, agents?, mine? }`: keep a
 * checked upload. Its files move into the skills folder under their own
 * directory, its SKILL.md is written in buddi's front matter (the name, the
 * title, when it's used, where it came from, untrusted unless `mine`), and
 * the grant is written in each agent's file — all checked by a reload, and
 * undone, folder included, when the reload refuses.
 */
export function acceptBundleRoute(deps: SkillsDeps, stagedId: string, body: Record<string, unknown>): RouteReply {
  const grant = parseGrant(body);
  if (typeof grant === 'string') return fail(400, grant);
  if (body.mine !== undefined && typeof body.mine !== 'boolean') return fail(400, '`mine` must be true or false.');
  const mine = body.mine === true;
  const found = readStaged(incomingOf(deps), stagedId);
  if (!found) return fail(404, 'That upload is gone: upload the .zip again.');
  const { staged } = found;

  const snap = snapshot(deps);
  const name = freeName(snap, skillSlug(staged.skill.name || staged.skill.title));
  const dir = path.join(deps.skillsDir, name);
  if (existsSync(dir)) return fail(409, `A folder called "${name}" is already in the skills folder.`);
  const today = deps.now().toISOString().slice(0, 10);
  const lines = [
    `name: ${name}`,
    `title: ${serializeYamlValue(staged.skill.title)}`,
    `description: ${serializeYamlValue(staged.skill.description.replace(/\s+/g, ' ').trim())}`,
    `provenance: ${mine ? 'owner' : 'imported'}`,
    `source: ${serializeYamlValue(`upload/${staged.filename}`)}`,
    `created: "${today}"`,
    ...(grant.every ? [] : ['agents: []']),
    ...(mine ? [] : ['untrusted: true']),
    ...(staged.skill.network === true ? ['network: true'] : []),
  ];
  const skillText = `---\n${lines.join('\n')}\n---\n\n${staged.skill.body.trim()}\n`;

  mkdirSync(deps.skillsDir, { recursive: true });
  try {
    renameSync(found.dir, dir);
  } catch {
    cpSync(found.dir, dir, { recursive: true });
  }
  rmSync(found.root, { recursive: true, force: true });
  const undo = (): void => rmSync(dir, { recursive: true, force: true });
  let entry: Entry;
  try {
    const file = path.join(dir, BUNDLE_SKILL_FILE);
    parseSkillFile(skillText, { fileName: name, file, scope: 'shared' });
    writeFilesAtomic([{ path: file, content: skillText }]);
    entry = { skill: parseSkillBundle(dir, { scope: 'shared' }), home: null };
  } catch (err) {
    undo();
    return fail(400, err instanceof Error ? err.message : String(err));
  }
  const plan = planGrant({ ...snap, entries: [...snap.entries, entry] }, entry, grant.every, grant.agents, skillText);
  if (plan.error) {
    undo();
    return plan.error;
  }
  const refused = commit(deps, plan.writes);
  if (refused) {
    undo();
    try {
      deps.catalog.reload?.();
    } catch {
      // The previous catalog is still serving.
    }
    return fail(409, refused);
  }
  return answer(deps, name, 201);
}

/**
 * What `host.exec`'s `skill` form asks (tools/host `SkillBundles`): the
 * bundle called `name` that this agent loads, read fresh from its SKILL.md so
 * a mark made a moment ago counts. Only a shared bundle in the owner's skills
 * folder, and only one the catalog composes into this agent's prompt.
 */
export function skillBundlesFor(deps: Pick<SkillsDeps, 'catalog' | 'skillsDir'>): {
  held(agentId: string, name: string): { name: string; title: string; dir: string; untrusted: boolean; network: boolean; files: string[]; scripts: string[] } | null;
  root(): string;
} {
  return {
    root: () => deps.skillsDir,
    held(agentId, name) {
      const agent = deps.catalog.get(agentId);
      const dir = path.join(deps.skillsDir, name);
      const file = path.join(dir, BUNDLE_SKILL_FILE);
      if (!agent || !agent.skills.some((s) => s.name === name && path.resolve(s.file) === path.resolve(file))) return null;
      let skill: Skill;
      try {
        skill = parseSkillBundle(dir, { scope: 'shared' });
      } catch {
        return null;
      }
      const bundle = skill.bundle!;
      return {
        name,
        title: titleOf(skill),
        dir,
        untrusted: skill.untrusted && !skill.learned,
        network: skill.network === true,
        files: [BUNDLE_SKILL_FILE, ...bundle.files.map((f) => f.path)],
        scripts: bundle.scripts,
      };
    },
  };
}

export type { BundleFileRow };
