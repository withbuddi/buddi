/**
 * The agent catalogue on the platform's side (agent-catalogue.md §5, §7, §8):
 * where a listed package stands on this installation, and the gated tool that
 * adds one, or updates one already added.
 *
 * Adding a package is accepting a proposal by another name, so it is built on
 * the very same pieces `platform.accept_plugin_agent` is: `buildCreateEnvelope`
 * (the id and handle checks, `checkTools`, the "would this file load" parse),
 * the account the accepting agent speaks through, the same create preview
 * naming the whole grant. On top: the v1 denylist, the package's integrity
 * (checked when the listing was read), the picks rendered as "## For this
 * owner", the missions created off unless chosen, the picture, and a sidecar
 * recording `source: market`.
 *
 * Updating is the same tool with `agent`: an agent whose file is untouched is
 * written again from the new package with the same picks; one the owner
 * edited is never touched unless they ask to replace their changes, and then
 * their file goes to the trash first. Existing missions are the owner's rows
 * and are never edited; new suggested ones arrive off.
 *
 * Nothing here reaches the network: the listings, the picks' choices and the
 * picture come through a `CatalogueService` the gateway binds
 * (`web/catalogue-source.ts`), so this module never imports a web route and a
 * test hands in a fixture.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_FILE,
  applyFrontmatterPatch,
  assertApprovedEffect,
  getMission,
  HANDLE_MAX,
  hashEnvelope,
  parseAgentFile,
  parseSkillFile,
  satisfiesRange,
  setSchedule,
  SKILLS_DIR,
  STARTER_MAX,
  upsertMission,
  type AgentSummary,
  type CatalogAgent,
  type CoreToolContext,
  type InstalledPlugin,
  type MisfirePolicy,
  type SuggestedAgent,
  type ToolDefinition,
  type ToolRegistry,
  type ToolSpec,
} from '@buddi/core';
import { z } from 'zod';
import {
  composePackagePersona,
  cronAt,
  cronClock,
  deniedTools,
  fileHash,
  parseClock,
  type AgentPackage,
  type FilledPick,
  type PackageNeed,
} from './catalogue-package.js';
import { composeProvenance, fileEdited, packageOwnedText, readProvenance, PROVENANCE_FILE, type AgentProvenance } from '../plugins/provenance.js';
import { composeAgentFile, composeSkillFile, createAgentDirAtomic, trashStamp, writeFilesAtomic } from './platform-files.js';
import { diffGrant, grantChangeBlock } from './platform-grant.js';
import { agentMissionId, describeCadence } from '../missions/reminders.js';
import { normaliseAvatar } from './avatar-image.js';
import { readAvatar, writeAvatar } from './avatars.js';
import type { AccountChoice, CreateAgentEnvelope } from './platform.js';

/* ------------------------------------------------------------------ *
 * The service the gateway binds
 * ------------------------------------------------------------------ */

/** What the picks can be answered with on this installation. */
export interface FillChoices {
  /** Mailbox addresses, the one the default agent reads first. */
  mailboxes: string[];
  /** The linked calendars, by name. */
  calendars: string[];
  /** The owner's saved places. */
  places: Array<{ id: string; label: string }>;
}

export type LoadedCatalogue =
  | { fetchedAt: string; stale: boolean; packages: AgentPackage[]; problems: string[] }
  | { unavailable: string };

export interface CatalogueService {
  /**
   * The listed packages, each read strictly; listings refused are in `problems`.
   * `cachedOnly`: the kept copy however old, never a fetch (an agent's page).
   */
  load(opts?: { refresh?: boolean; cachedOnly?: boolean }): Promise<LoadedCatalogue>;
  choices(): Promise<FillChoices>;
  /** Which requirements that are not plugins are met here. */
  needs(): Promise<Record<PackageNeed, boolean>>;
  /** The package's picture, checked against its hash; null when it has none or it could not be had. */
  avatar(pkg: AgentPackage): Promise<Buffer | null>;
  /** This buddi's version, for a package's `buddi` range. */
  version(): Promise<string>;
  /** The record of installed plugins. */
  plugins(): InstalledPlugin[];
}

/** Said when there is neither a fresh list nor a copy. */
export const CATALOGUE_OFFLINE = "The catalogue needs withbuddi.com; try again when you're online.";

/* ------------------------------------------------------------------ *
 * Where a package stands
 * ------------------------------------------------------------------ */

export type PluginFix = 'install' | 'enable' | 'update';

export interface MissingPlugin {
  kind: 'plugin';
  name: string;
  range: string;
  fix: PluginFix;
  /** The version installed, when it is too old. */
  installed?: string;
}

export interface MissingNeed {
  kind: 'need';
  name: PackageNeed;
  /** Where it is fixed: Settings → Email for a mailbox, Settings → Model accounts for one that draws. */
  fix: 'mailbox' | 'accounts';
}

export type Drift = 'current' | 'update' | 'edited' | 'edited-update';

export interface InstalledAs {
  agentId: string;
  handle: string;
  /** The version written, or the older agent's own version when it came by `replaces`. */
  version: string;
  drift: Drift;
  /** `buddi/planner`, when this agent is an older one the package replaces. */
  via?: string;
}

export type PackageState =
  | { state: 'ready' }
  | { state: 'needs'; missing: Array<MissingPlugin | MissingNeed> }
  | { state: 'installed'; installed: InstalledAs }
  | { state: 'unavailable'; reason: string };

/** An agent on disk that came from the catalogue, or from something a package replaces. */
export interface AddedAgent {
  agentId: string;
  dir: string;
  file: string;
  provenance: AgentProvenance;
  /** The file is not what was written (or nothing recorded what was). */
  edited: boolean;
}

/**
 * The skills written with this agent that the owner has changed or deleted
 * since, by name. Only the skills the sidecar recorded: one the owner added
 * is theirs and no update touches it.
 */
export function editedSkills(dir: string, provenance: AgentProvenance): string[] {
  const out: string[] = [];
  for (const [name, hash] of Object.entries(provenance.skills ?? {})) {
    const file = path.join(dir, SKILLS_DIR, `${name}.md`);
    try {
      if (fileHash(readFileSync(file, 'utf8')) !== hash) out.push(name);
    } catch {
      out.push(name);
    }
  }
  return out;
}

/** Every agent directory with a sidecar, read once. */
export function addedAgents(agentsDir: string): AddedAgent[] {
  if (!existsSync(agentsDir)) return [];
  const out: AddedAgent[] = [];
  for (const name of readdirSync(agentsDir).sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(agentsDir, name);
    const file = path.join(dir, AGENT_FILE);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
    } catch {
      continue;
    }
    const provenance = readProvenance(dir);
    if (!provenance) {
      const legacy = legacyAgent(name, file);
      if (legacy) out.push(legacy);
      continue;
    }
    let edited = true;
    try {
      // The `skills:` grants are the owner's, not the package's: they never count here.
      edited = fileEdited(provenance.file, readFileSync(file, 'utf8')) || editedSkills(dir, provenance).length > 0;
    } catch {
      edited = true;
    }
    out.push({ agentId: name, dir, file, provenance, edited });
  }
  return out;
}

/**
 * Agents buddi shipped or plugins proposed before sidecars were written, by the
 * `<source>/<id>` a package's `replaces` names them with: the id (and directory)
 * and handle they were written with, and the package-owned hash of every
 * version that shipped, so an untouched copy reads as untouched.
 */
export const LEGACY_AGENTS: ReadonlyArray<{ ref: string; id: string; handle: string; shipped: readonly string[] }> = [
  {
    ref: 'buddi/scout',
    id: 'scout',
    handle: 'scout',
    shipped: [
      'd6c53334e69810b41b6b75710df8294d147b48dcfea94ad7c1d4ffd42cb0f57c',
      '294753258548cfdc61fca4b7551f5e1fb4fa7c4c8993e899dfcd686b0ecf85eb',
      'e75f52ff83d0160fbfb0fe1ca62e60ad61c5db329b6f8654c3180690c92a8843',
    ],
  },
  {
    ref: 'buddi/planner',
    id: 'planner',
    handle: 'planner',
    shipped: [
      'e1a923b8e636a69aeb6c6a9a610946d1a5970f19e0717edec408ff684f118999',
      'c070159c0881f1fe82d034bf64ce4cdb383ba569f20ad411f45fef6fc67a82c3',
      '0b71881b5c8de2eb671b8d5ffddb861d11772a4192ae5f3562320a804365fcbd',
    ],
  },
  {
    ref: 'buddi/keeper',
    id: 'keeper',
    handle: 'keeper',
    shipped: [
      '5cf57ea646667c7b7ff059e97287a9f075008c82a0facb3160ba98eac91176c2',
      '5d0cd96a7637141b17567a149c00c828080f1088c59a64589c74e6016430b267',
    ],
  },
  {
    // The finance advisor buddi shipped before the finance plugin proposed Ledger.
    ref: 'buddi/finance-advisor',
    id: 'finance-advisor',
    handle: 'ledger',
    shipped: [
      '493ebf6f81a58099b0d85ff5a374c73ed2e683cbb3494300497d88eed437fc11',
      '45460f66f51fff8dc1aaef801d2aaf9db71de9fd9b75a5164fc188ec32c57a54',
      '3542ebac3ae82e2173d52ec72fca6919c1bf1cbc39f23a0145e73e0bd399e760',
      'bb5096ebda55a3937062894df76c0df33638409e02b4e6acad898afe147754df',
    ],
  },
  { ref: 'finance/ledger', id: 'ledger', handle: 'ledger', shipped: [] },
  { ref: 'image/illustrator', id: 'illustrator', handle: 'art', shipped: [] },
];

/**
 * An agent with no sidecar, read as the older agent it is when its directory,
 * id and handle all match one in `LEGACY_AGENTS`. Edited unless its file is a
 * version that shipped; the update writes the sidecar it never had.
 */
function legacyAgent(dirName: string, file: string): AddedAgent | undefined {
  let text: string;
  let id: string;
  let handle: string;
  try {
    text = readFileSync(file, 'utf8');
    const front = parseAgentFile(text, { file }).frontmatter;
    id = front.id;
    handle = front.handle;
  } catch {
    return undefined;
  }
  const legacy = LEGACY_AGENTS.find((l) => l.id === dirName && l.id === id && l.handle === handle);
  if (!legacy) return undefined;
  const [plugin, agent] = legacy.ref.split('/') as [string, string];
  const owned = fileHash(packageOwnedText(text));
  const untouched = legacy.shipped.includes(owned);
  return {
    agentId: dirName,
    dir: path.dirname(file),
    file,
    provenance: { plugin, version: 'unknown', agent, acceptedAt: 'unknown', proposal: '', file: untouched ? owned : '' },
    edited: !untouched,
  };
}

/** Is this added agent a copy of the package, directly or by `replaces`? */
export function matchesPackage(pkg: AgentPackage, added: AddedAgent): 'package' | 'replaces' | null {
  const p = added.provenance;
  if (p.source === 'market' && p.package === pkg.manifest.name) return 'package';
  if (pkg.manifest.replaces.includes(`${p.plugin}/${p.agent}`)) return 'replaces';
  return null;
}

export function installedAsFor(
  pkg: AgentPackage,
  added: readonly AddedAgent[],
  handleOf: (agentId: string) => string,
): InstalledAs | undefined {
  const direct = added.find((a) => matchesPackage(pkg, a) === 'package');
  const match = direct ?? added.find((a) => matchesPackage(pkg, a) === 'replaces');
  if (!match) return undefined;
  const via = direct ? undefined : `${match.provenance.plugin}/${match.provenance.agent}`;
  const moved = via !== undefined || match.provenance.proposal !== pkg.manifest.integrity;
  const drift: Drift = match.edited ? (moved ? 'edited-update' : 'edited') : moved ? 'update' : 'current';
  return {
    agentId: match.agentId,
    handle: handleOf(match.agentId),
    version: match.provenance.version,
    drift,
    ...(via === undefined ? {} : { via }),
  };
}

export interface StateContext {
  registry: ToolRegistry;
  version: string;
  needs: Record<PackageNeed, boolean>;
  plugins: readonly InstalledPlugin[];
  added: readonly AddedAgent[];
  handleOf: (agentId: string) => string;
}

/** The plugins a package requires that are not loaded here in range, each with its fix. */
export function missingPlugins(pkg: AgentPackage, ctx: Pick<StateContext, 'registry' | 'plugins'>): MissingPlugin[] {
  const loaded = new Map(ctx.registry.manifests().map((m) => [m.name, m.version]));
  const out: MissingPlugin[] = [];
  for (const [name, range] of Object.entries(pkg.manifest.requires)) {
    const version = loaded.get(name);
    if (version !== undefined) {
      if (satisfiesRange(version, range) === false) out.push({ kind: 'plugin', name, range, fix: 'update', installed: version });
      continue;
    }
    const record = ctx.plugins.find((p) => p.name === name);
    if (!record) out.push({ kind: 'plugin', name, range, fix: 'install' });
    else if (satisfiesRange(record.version, range) === false) out.push({ kind: 'plugin', name, range, fix: 'update', installed: record.version });
    else out.push({ kind: 'plugin', name, range, fix: 'enable' });
  }
  return out;
}

/** The version a `buddi` range is read against: a checkout's "0.1.0 (v0.1.0-3-g…)" is its first word. */
export function plainVersion(version: string): string {
  return version.trim().split(/\s+/)[0] ?? version;
}

export function packageState(pkg: AgentPackage, ctx: StateContext): PackageState {
  const installed = installedAsFor(pkg, ctx.added, ctx.handleOf);
  if (installed) return { state: 'installed', installed };
  if (satisfiesRange(plainVersion(ctx.version), pkg.manifest.buddi) === false) {
    return { state: 'unavailable', reason: `Needs buddi ${pkg.manifest.buddi}; this is ${plainVersion(ctx.version)}. Update buddi first.` };
  }
  const missing: Array<MissingPlugin | MissingNeed> = [...missingPlugins(pkg, ctx)];
  for (const need of pkg.manifest.needs) {
    // `mailbox?` makes it better and never holds it back.
    if (need === 'mailbox?') continue;
    if (!ctx.needs[need]) missing.push({ kind: 'need', name: need, fix: need === 'mailbox' ? 'mailbox' : 'accounts' });
  }
  return missing.length === 0 ? { state: 'ready' } : { state: 'needs', missing };
}

/* ------------------------------------------------------------------ *
 * The helpers platform.ts lends this module
 * ------------------------------------------------------------------ */

/** What of the platform's resolved binding this module reads. */
export interface CatalogueBinding {
  catalog: { list(): AgentSummary[]; get(id: string): CatalogAgent | undefined; byHandle(handle: string): CatalogAgent | undefined };
  agentsDir: string;
  trashRoot: string;
}

/** Lent by platform.ts, so the tools are built from the same pieces and no import goes in a circle. */
export interface CatalogueHelpers {
  resolved(registry: ToolRegistry): CatalogueBinding;
  service(registry: ToolRegistry): CatalogueService | undefined;
  buildCreate(
    input: {
      id: string;
      handle: string;
      name: string;
      description: string;
      persona: string;
      tools: string[];
      language?: 'mirror' | 'en' | 'fr';
      idleRollover?: string;
      starters?: string[];
      roles?: string[];
      account?: string;
      model?: string;
    },
    deps: { registry: ToolRegistry; proposedBy: string },
  ): CreateAgentEnvelope;
  speakingAccount(registry: ToolRegistry, agentId: string): { account: AccountChoice; from: string | null } | null;
  checkTools(declared: readonly string[], registry: ToolRegistry, id: string): string[];
  renderCreatePreview(envelope: CreateAgentEnvelope, specs: readonly ToolSpec[]): string;
  reload(registry: ToolRegistry): { reloaded: boolean; message: string; error?: string };
  assignAccount(registry: ToolRegistry, agentId: string, account: AccountChoice | null): Promise<string>;
  proposals(registry: ToolRegistry): Array<{ plugin: string; pluginVersion: string; agent: SuggestedAgent }>;
}

export class CatalogueRefusal extends Error {
  override readonly name = 'PlatformRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function refuse(code: string, message: string): never {
  throw new CatalogueRefusal(code, message);
}

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

/** One mission an added agent arrives with. */
export interface PackageMissionPlan {
  id: string;
  slug: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  alwaysDeliver?: boolean;
  misfirePolicy?: MisfirePolicy;
}

export interface InstallAgentEnvelope {
  tool: 'platform.install_agent';
  mode: 'install' | 'update';
  proposedBy: string;
  package: { name: string; version: string; integrity: string; title: string; changes: string };
  id: string;
  handle: string;
  name: string;
  description: string;
  file: string;
  /** The whole grant, resolved. */
  tools: string[];
  declaredTools: string[];
  account: AccountChoice | null;
  inheritedFrom: string | null;
  /** The complete file, byte for byte. */
  content: string;
  skills: Array<{ name: string; description: string; file: string; content: string }>;
  missions: PackageMissionPlan[];
  picks: FilledPick[];
  avatar: { url: string; sha256: string } | null;
  /** The create preview's own envelope, for an install. */
  created?: CreateAgentEnvelope;
  update?: {
    fromVersion: string;
    /** `buddi/planner` when the agent is an older one this package replaces. */
    via: string | null;
    /** The owner changed the file; approving replaces their changes. */
    edited: boolean;
    /** sha256 of the file as it is now. */
    previousFile: string;
    /**
     * Every skill file the update writes or retires, as it is now: its sha256,
     * or null when there is none. Bound into the approval, so a skill changed
     * after the preview refuses the approval instead of being overwritten.
     */
    skillsBefore: Record<string, string | null>;
    /** Skills of the owner's own (or learned) that a package skill of the same name would replace. */
    replacesOwn: string[];
    /** Skills the earlier version wrote that this one no longer carries: they go to the trash. */
    retires: string[];
    toolsBefore: string[];
    added: string[];
    removed: string[];
    widened: boolean;
    personaDiff: string[];
  };
}

export const installAgentInput = z
  .object({
    name: z.string().min(1).describe('The package, as platform.catalogue lists it: "chef".'),
    version: z
      .string()
      .min(1)
      .optional()
      .describe('The version the owner saw. Refused when the catalogue has moved on, so they approve what they read.'),
    handle: z
      .string()
      .min(1)
      .optional()
      .describe('A handle the owner asked for. Leave it out for the package\'s own, or a free one beside it (chef-2).'),
    fills: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'The picks platform.catalogue lists for it, by id: a mailbox address, calendar names (comma-separated, empty for ' +
          'all), a saved place, a mission hour as HH:MM, or one line of text. Leave a pick out for its default.',
      ),
    missionsOn: z
      .array(z.string().min(1))
      .optional()
      .describe('The package missions the owner asked to turn on now, by id. Every other mission arrives off.'),
    account: z
      .string()
      .min(1)
      .optional()
      .describe('A named model account the owner picked. Leave it out and it speaks through the same account you do.'),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Update this agent, already added from the package (or an older one it replaces), instead of adding a new one: ' +
          'by id or handle.',
      ),
    replaceEdits: z
      .literal(true)
      .optional()
      .describe('Only when the owner said to replace their own changes to that agent\'s file. Their file goes to the trash first.'),
    plan: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The plan fingerprint the dashboard or `buddi agents` showed the owner. Refused when anything it covers moved ' +
          '(the package, the grant, the files on disk). Leave it out from chat: your approval card is the preview.',
      ),
  })
  .strict();

export type InstallAgentInput = z.infer<typeof installAgentInput>;

function freeName(base: string, taken: (name: string) => boolean, max: number): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  refuse('no-free-name', `every name from ${base} to ${base}-99 is taken`);
}

/** The picks answered, with each default filled in (§7). */
export function resolvePicks(
  pkg: AgentPackage,
  given: Record<string, string> | undefined,
  choices: FillChoices,
): FilledPick[] {
  const answers = given ?? {};
  const known = new Set(pkg.manifest.fills.map((f) => f.id));
  const stray = Object.keys(answers).filter((id) => !known.has(id));
  if (stray.length > 0) {
    refuse(
      'unknown-pick',
      `${pkg.manifest.title} asks no "${stray.join('", "')}". Its picks: ${pkg.manifest.fills.map((f) => f.id).join(', ') || 'none'}.`,
    );
  }
  return pkg.manifest.fills.map((fill): FilledPick => {
    const raw = answers[fill.id]?.trim();
    let value: string;
    switch (fill.kind) {
      case 'mailbox': {
        value = raw ?? choices.mailboxes[0] ?? '';
        if (raw !== undefined && raw !== '' && choices.mailboxes.length > 0 && !choices.mailboxes.some((m) => m.toLowerCase() === raw.toLowerCase())) {
          refuse('bad-pick', `"${raw}" is not one of your mailboxes (${choices.mailboxes.join(', ')}).`);
        }
        break;
      }
      case 'calendar': {
        value = raw ?? '';
        const names = value.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = choices.calendars.length === 0 ? [] : names.filter((n) => !choices.calendars.includes(n));
        if (raw !== undefined && unknown.length > 0) {
          refuse('bad-pick', `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a linked calendar' : 'are not linked calendars'} (${choices.calendars.join(', ')}).`);
        }
        value = names.join(', ');
        break;
      }
      case 'place': {
        const fallback =
          choices.places.find((p) => p.id === 'home')?.label ?? choices.places[0]?.label ?? '';
        const wanted = raw;
        if (wanted === undefined || wanted === '') {
          value = raw === '' ? '' : fallback;
        } else {
          const match = choices.places.find((p) => p.id === wanted.toLowerCase() || p.label.toLowerCase() === wanted.toLowerCase());
          if (!match && raw !== undefined && choices.places.length > 0) {
            refuse('bad-pick', `"${raw}" is not one of your saved places (${choices.places.map((p) => p.label).join(', ')}).`);
          }
          value = match?.label ?? wanted;
        }
        break;
      }
      case 'time': {
        const mission = pkg.manifest.missions.find((m) => m.id === fill.mission);
        value = raw ?? (mission ? cronClock(mission.cron) : null) ?? '';
        if (value !== '' && parseClock(value) === null) refuse('bad-pick', `"${value}" is not a time of day (HH:MM, like 07:30).`);
        if (value !== '') {
          const [h, m] = parseClock(value) as [number, number];
          value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        break;
      }
      case 'text': {
        value = raw ?? '';
        if (/[\r\n]/.test(value)) refuse('bad-pick', `"${fill.label}" takes one line.`);
        if (value.length > 200) refuse('bad-pick', `"${fill.label}" takes at most 200 characters.`);
        break;
      }
    }
    return { id: fill.id, kind: fill.kind, label: fill.label, value };
  });
}

/** Lines that differ, `- ` removed and `+ ` added, from a plain longest-common-subsequence. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.trim().split('\n');
  const b = after.trim().split('\n');
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

export interface BuildDeps {
  registry: ToolRegistry;
  helpers: CatalogueHelpers;
  proposedBy: string;
  timezone: string;
  db?: CoreToolContext['db'];
}

/** The package the input names, read from the catalogue the gateway keeps; a refusal otherwise. */
export async function findPackage(service: CatalogueService | undefined, name: string): Promise<AgentPackage> {
  if (!service) refuse('no-catalogue', 'this process has no catalogue bound, so no package can be added from it');
  const loaded = await service.load();
  if ('unavailable' in loaded) refuse('offline', `${CATALOGUE_OFFLINE} (${loaded.unavailable})`);
  const pkg = loaded.packages.find((p) => p.manifest.name === name.trim().toLowerCase());
  if (!pkg) {
    const refused = loaded.problems.find((p) => p.startsWith(`${name.trim().toLowerCase()}:`));
    if (refused) refuse('refused-listing', refused);
    refuse(
      'unknown-package',
      `the catalogue lists no agent "${name}". Listed: ${loaded.packages.map((p) => p.manifest.name).join(', ') || 'nothing'}. ` +
        'Call platform.catalogue to see them.',
    );
  }
  return pkg;
}

/** The example asks the agent file can carry as its starters (each at most STARTER_MAX characters). */
function starters(pkg: AgentPackage): string[] {
  return pkg.manifest.examples.filter((example) => example.trim().length <= STARTER_MAX).map((example) => example.trim());
}

function pickRecord(picks: readonly FilledPick[]): Record<string, string> {
  return Object.fromEntries(picks.map((p) => [p.id, p.value]));
}

function missionPlans(
  pkg: AgentPackage,
  agentId: string,
  picks: readonly FilledPick[],
  timezone: string,
  on: ReadonlySet<string>,
): PackageMissionPlan[] {
  return pkg.manifest.missions.map((m) => {
    const time = pkg.manifest.fills.find((f) => f.kind === 'time' && f.mission === m.id);
    const clock = time ? picks.find((p) => p.id === time.id)?.value : undefined;
    return {
      id: agentMissionId(agentId, m.id),
      slug: m.id,
      name: m.name,
      cron: clock ? cronAt(m.cron, clock) : m.cron,
      timezone,
      prompt: m.prompt,
      enabled: on.has(m.id),
      ...(m.alwaysDeliver === undefined ? {} : { alwaysDeliver: m.alwaysDeliver }),
      ...(m.misfirePolicy === undefined ? {} : { misfirePolicy: m.misfirePolicy }),
    };
  });
}

function packageSkills(pkg: AgentPackage, agentDir: string): InstallAgentEnvelope['skills'] {
  return pkg.skills.map((skill) => {
    const content = composeSkillFile({
      name: skill.name,
      description: skill.description,
      provenance: 'imported',
      source: `catalogue/${pkg.manifest.name}@${pkg.manifest.version}`,
      body: skill.body,
    });
    try {
      parseSkillFile(content, { fileName: skill.name });
    } catch (err) {
      refuse('would-not-load', `${pkg.manifest.title} carries a skill the loader refuses: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { name: skill.name, description: skill.description, file: path.join(agentDir, SKILLS_DIR, `${skill.name}.md`), content };
  });
}

function checkDenied(pkg: AgentPackage, resolvedTools: readonly string[]): void {
  const denied = deniedTools(pkg.manifest.tools, resolvedTools);
  if (denied.length > 0) {
    refuse(
      'denied-tool',
      `${pkg.manifest.title} asks for ${denied.join(', ')}, which no catalogue agent may be given. ` +
        'You can add any of them by hand after it is added.',
    );
  }
}

/**
 * The plan the owner was shown, as one fingerprint: the whole envelope but who
 * proposed it — the package's integrity, the resolved grant, the file's and
 * every affected skill's hash as they are now, the missions. The dashboard and
 * `buddi agents` send it back with the click, so the approval the route
 * records is the plan the owner read, or nothing (agent-catalogue.md §8).
 */
export function planFingerprint(envelope: InstallAgentEnvelope): string {
  const { proposedBy: _proposedBy, created, ...rest } = envelope;
  const bound = created ? { ...rest, created: { ...created, proposedBy: '' } } : rest;
  return hashEnvelope(bound);
}

/**
 * Build the envelope for adding (or, with `agent`, updating) a package, and
 * refuse it when the plan the owner was shown (`plan`) is no longer it.
 */
export async function buildInstallEnvelope(input: InstallAgentInput, deps: BuildDeps): Promise<InstallAgentEnvelope> {
  const envelope = await composeInstallEnvelope(input, deps);
  if (input.plan !== undefined && planFingerprint(envelope) !== input.plan) {
    refuse(
      'plan-moved',
      `what ${envelope.mode === 'update' ? `updating @${envelope.handle}` : `adding ${envelope.package.title}`} would do changed since ` +
        'it was shown (the package, the tools it gets, or a file on disk). Look at it again before you approve it.',
    );
  }
  return envelope;
}

/**
 * Compose the envelope. Everything knowable is checked here, before any
 * approval exists.
 */
async function composeInstallEnvelope(input: InstallAgentInput, deps: BuildDeps): Promise<InstallAgentEnvelope> {
  const { registry, helpers } = deps;
  const service = helpers.service(registry);
  const pkg = await findPackage(service, input.name);
  const m = pkg.manifest;
  if (input.version !== undefined && input.version.trim() !== m.version) {
    refuse(
      'version-moved',
      `the catalogue now lists ${m.title} ${m.version}, not ${input.version}. Look at it again before adding it.`,
    );
  }
  const version = await service!.version();
  if (satisfiesRange(plainVersion(version), m.buddi) === false) {
    refuse('buddi-too-old', `${m.title} needs buddi ${m.buddi}; this is ${plainVersion(version)}. Update buddi first.`);
  }
  const missing = missingPlugins(pkg, { registry, plugins: service!.plugins() });
  if (missing.length > 0) {
    refuse(
      'missing-plugin',
      `${m.title} needs ${missing.map((p) => `the ${p.name} plugin${p.fix === 'update' ? ` ${p.range} (${p.installed} is installed)` : p.fix === 'enable' ? ' (installed, but off)' : ''}`).join(' and ')}. ` +
        'Adding it from the catalogue installs a missing by-buddi plugin on the way; from here, install it first.',
    );
  }
  const needs = await service!.needs();
  const unmet = m.needs.filter((need): need is PackageNeed => need !== 'mailbox?' && !needs[need]);
  if (unmet.length > 0 && input.agent === undefined) {
    refuse(
      'missing-need',
      `${m.title} needs ${unmet.map((n) => (n === 'mailbox' ? 'a mailbox (Settings → Email)' : 'an account that draws (Settings → Model accounts)')).join(' and ')} first.`,
    );
  }
  const binding = helpers.resolved(registry);
  const choices = m.fills.some((f) => f.kind === 'mailbox' || f.kind === 'calendar' || f.kind === 'place')
    ? await service!.choices()
    : { mailboxes: [], calendars: [], places: [] };
  const known = new Set(m.missions.map((mission) => mission.id));
  const strayMissions = (input.missionsOn ?? []).filter((id) => !known.has(id));
  if (strayMissions.length > 0) {
    refuse('unknown-mission', `${m.title} has no mission "${strayMissions.join('", "')}". Its missions: ${[...known].join(', ') || 'none'}.`);
  }
  const avatar = pkg.avatar && pkg.avatarSha256 ? { url: pkg.avatar, sha256: pkg.avatarSha256 } : null;
  const packageInfo = { name: m.name, version: m.version, integrity: m.integrity, title: m.title, changes: m.changes };

  if (input.agent !== undefined) return buildUpdate(input, deps, pkg, binding, choices, packageInfo, avatar);
  if (input.replaceEdits !== undefined) refuse('not-an-update', '`replaceEdits` goes with `agent`, the agent being updated');

  const already = installedAsFor(pkg, addedAgents(binding.agentsDir), (id) => binding.catalog.get(id)?.handle ?? id);
  if (already) {
    refuse(
      'already-added',
      `${m.title} is already on the team as @${already.handle}${already.via ? ` (from ${already.via})` : ''}. ` +
        (already.drift === 'update' ? `To bring it to ${m.version}, update it (agent: "${already.agentId}").` : 'Nothing to add.'),
    );
  }

  const takenId = (id: string): boolean =>
    binding.catalog.get(id) !== undefined || existsSync(path.join(binding.agentsDir, id));
  const takenHandle = (handle: string): boolean =>
    binding.catalog.list().some((a) => a.handle.toLowerCase() === handle.toLowerCase());
  const id = freeName(m.name, takenId, 40);
  const handle = input.handle !== undefined ? input.handle.trim().replace(/^@/, '').toLowerCase() : freeName(m.handle, takenHandle, HANDLE_MAX);
  const picks = resolvePicks(pkg, input.fills, choices);
  const speaks = input.account === undefined ? helpers.speakingAccount(registry, deps.proposedBy) : null;
  const created = helpers.buildCreate(
    {
      id,
      handle,
      name: m.title,
      description: m.description,
      persona: composePackagePersona(pkg.persona, picks),
      tools: [...m.tools],
      ...(m.language === undefined ? {} : { language: m.language }),
      ...(m.idleRollover === undefined ? {} : { idleRollover: m.idleRollover }),
      ...(starters(pkg).length === 0 ? {} : { starters: starters(pkg) }),
      ...(m.roles === undefined || m.roles.length === 0 ? {} : { roles: [...m.roles] }),
      ...(input.account !== undefined ? { account: input.account } : speaks ? { account: speaks.account.label, model: speaks.account.model } : {}),
    },
    { registry, proposedBy: deps.proposedBy },
  );
  checkDenied(pkg, created.tools);
  const agentDir = path.dirname(created.file);
  return {
    tool: 'platform.install_agent',
    mode: 'install',
    proposedBy: deps.proposedBy,
    package: packageInfo,
    id: created.id,
    handle: created.handle,
    name: created.name,
    description: created.description,
    file: created.file,
    tools: created.tools,
    declaredTools: created.declaredTools,
    account: created.account,
    inheritedFrom: created.account === null ? null : (speaks?.from ?? null),
    content: created.content,
    skills: packageSkills(pkg, agentDir),
    missions: missionPlans(pkg, created.id, picks, deps.timezone, new Set(input.missionsOn ?? [])),
    picks,
    avatar,
    created,
  };
}

async function buildUpdate(
  input: InstallAgentInput,
  deps: BuildDeps,
  pkg: AgentPackage,
  binding: CatalogueBinding,
  choices: FillChoices,
  packageInfo: InstallAgentEnvelope['package'],
  avatar: InstallAgentEnvelope['avatar'],
): Promise<InstallAgentEnvelope> {
  const { registry, helpers } = deps;
  const m = pkg.manifest;
  const wanted = (input.agent as string).trim().replace(/^@/, '');
  const agent = binding.catalog.get(wanted) ?? binding.catalog.byHandle(wanted);
  if (!agent) refuse('unknown-agent', `there is no agent "${input.agent}" here`);
  const dir = path.dirname(agent.file);
  const added = addedAgents(path.dirname(dir)).find((a) => a.agentId === path.basename(dir));
  const how = added ? matchesPackage(pkg, added) : null;
  if (!added || how === null) {
    refuse('not-from-package', `@${agent.handle} did not come from ${m.title} in the catalogue, so there is nothing to update; it is yours as it is.`);
  }
  const via = how === 'replaces' ? `${added.provenance.plugin}/${added.provenance.agent}` : null;
  if (how === 'package' && added.provenance.proposal === m.integrity && !added.edited) {
    refuse('up-to-date', `@${agent.handle} is already ${m.title} ${m.version}, unchanged on both sides.`);
  }
  // Every skill file the update touches, as it is now. A file of the same name the
  // earlier version never wrote is the owner's (or a learned one): replacing it is
  // replacing their work. A skill the earlier version wrote and this one dropped
  // goes to the trash, or it would keep running with nobody's provenance on it.
  const skills = packageSkills(pkg, dir);
  const tracked = added.provenance.skills ?? {};
  const readNow = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const skillsBefore: Record<string, string | null> = {};
  const replacesOwn: string[] = [];
  for (const skill of skills) {
    const now = readNow(skill.file);
    skillsBefore[skill.name] = now === null ? null : fileHash(now);
    if (now !== null && !(skill.name in tracked) && now !== skill.content) replacesOwn.push(skill.name);
  }
  const retires: string[] = [];
  for (const name of Object.keys(tracked).sort()) {
    if (skills.some((skill) => skill.name === name)) continue;
    const now = readNow(path.join(dir, SKILLS_DIR, `${name}.md`));
    skillsBefore[name] = now === null ? null : fileHash(now);
    if (now !== null) retires.push(name);
  }
  const edited = added.edited || replacesOwn.length > 0;
  if (edited && input.replaceEdits !== true) {
    refuse(
      'owner-edited',
      replacesOwn.length > 0 && !added.edited
        ? `@${agent.handle} has ${replacesOwn.length === 1 ? 'a skill' : 'skills'} of your own (${replacesOwn.join(', ')}) that ` +
            `${m.title} ${m.version} would replace with ${replacesOwn.length === 1 ? 'one' : 'ones'} of the same name, so nothing will ` +
            'touch it. To replace them, the owner has to say so (replaceEdits), and theirs go to the trash first.'
        : `you have changed @${agent.handle}'s file or one of its skills, so nothing will touch it. ${m.title} ${m.version} is out; ` +
            'to replace your changes with it, the owner has to say so (replaceEdits), and their file goes to the trash first.',
    );
  }
  if (input.handle !== undefined) refuse('not-a-field', 'an update keeps the handle; rename it on the Agents page');
  if (input.missionsOn !== undefined && input.missionsOn.length > 0) {
    refuse('not-a-field', 'an update adds new missions off and never turns one on; switch them on under Agents → Missions');
  }
  const current = readFileSync(agent.file, 'utf8');
  const before = parseAgentFile(current, { file: agent.file });
  const remembered = added.provenance.fills ?? {};
  const keep = Object.fromEntries(Object.entries(remembered).filter(([id]) => m.fills.some((f) => f.id === id)));
  const picks = resolvePicks(pkg, { ...keep, ...(input.fills ?? {}) }, choices);
  const persona = composePackagePersona(pkg.persona, picks);
  const declared = [...m.tools];
  const tools = helpers.checkTools(declared, registry, agent.id);
  checkDenied(pkg, tools);
  const composed = composeAgentFile({
    id: agent.id,
    handle: agent.handle,
    name: m.title,
    description: m.description,
    tools: declared,
    ...(m.language === undefined ? {} : { language: m.language }),
    ...(m.idleRollover === undefined ? {} : { idleRollover: m.idleRollover }),
    ...(starters(pkg).length === 0 ? {} : { starters: starters(pkg) }),
    ...(m.roles === undefined || m.roles.length === 0 ? {} : { roles: [...m.roles] }),
    persona,
  });
  // The skills the owner granted it are theirs, not the package's: an update keeps them.
  const granted = before.frontmatter.skills ?? [];
  const content = granted.length === 0 ? composed : applyFrontmatterPatch(composed, { skills: [...granted] }, agent.file);
  try {
    parseAgentFile(content, { dirName: agent.id });
  } catch (err) {
    refuse('would-not-load', `this would write a file the loader refuses: ${err instanceof Error ? err.message : String(err)}`);
  }
  const grant = diffGrant(agent.tools, tools);
  const existing = new Set<string>();
  if (deps.db) {
    for (const mission of m.missions) {
      const row = await getMission(deps.db as never, agentMissionId(agent.id, mission.id)).catch(() => null);
      if (row) existing.add(mission.id);
    }
  }
  const missions = missionPlans(pkg, agent.id, picks, deps.timezone, new Set()).filter((plan) => !existing.has(plan.slug));
  return {
    tool: 'platform.install_agent',
    mode: 'update',
    proposedBy: deps.proposedBy,
    package: packageInfo,
    id: agent.id,
    handle: agent.handle,
    name: m.title,
    description: m.description,
    file: agent.file,
    tools,
    declaredTools: declared,
    account: null,
    inheritedFrom: null,
    content,
    skills,
    missions,
    picks,
    avatar,
    update: {
      fromVersion: added.provenance.version,
      via,
      edited,
      previousFile: fileHash(current),
      skillsBefore,
      replacesOwn,
      retires,
      toolsBefore: [...agent.tools],
      added: grant.added,
      removed: grant.removed,
      widened: grant.widened,
      personaDiff: lineDiff(before.body, persona),
    },
  };
}

function missionLines(missions: readonly PackageMissionPlan[]): string[] {
  return missions.map(
    (mission) =>
      `  ${mission.name}, ${describeCadence(mission.cron, mission.timezone)} — ` +
      (mission.enabled ? 'ON from the start' : 'off until you turn it on'),
  );
}

export function renderInstallPreview(
  envelope: InstallAgentEnvelope,
  specs: readonly ToolSpec[],
  renderCreate: CatalogueHelpers['renderCreatePreview'],
): string {
  const picks = envelope.picks.filter((p) => p.kind !== 'time' && p.value !== '');
  if (envelope.mode === 'update' && envelope.update) {
    const u = envelope.update;
    return [
      `Update @${envelope.handle} from the catalogue: ${envelope.package.title} ${envelope.package.version}` +
        ` (you have ${u.via ? `${u.via} ${u.fromVersion}` : u.fromVersion}).`,
      `What changed: ${envelope.package.changes}`,
      '',
      ...(u.edited
        ? [
            u.replacesOwn.length > 0
              ? `YOUR OWN SKILL${u.replacesOwn.length === 1 ? '' : 'S'} ${u.replacesOwn.join(', ')} would be replaced by the ` +
                `catalogue's of the same name. Approving replaces ${u.replacesOwn.length === 1 ? 'it' : 'them'} (and any change you made ` +
                'to its file); your versions are kept in the trash beside your agents, and moving them back restores them.'
              : `YOU CHANGED THIS FILE. Approving replaces your changes with the catalogue's; your version is kept in ` +
                'the trash beside your agents, and moving it back restores it.',
            '',
          ]
        : []),
      ...(u.retires.length > 0
        ? [
            `This version no longer carries ${u.retires.length === 1 ? 'the skill' : 'the skills'} ${u.retires.join(', ')}: ` +
              `${u.retires.length === 1 ? 'it goes' : 'they go'} to the trash beside your agents.`,
            '',
          ]
        : []),
      ...grantChangeBlock(envelope.handle, { ...diffGrant(u.toolsBefore, envelope.tools) }, specs),
      '',
      ...(u.personaDiff.length === 0
        ? ['Its persona is unchanged.']
        : ['Its persona changes:', ...u.personaDiff.slice(0, 80).map((line) => `  ${line}`), ...(u.personaDiff.length > 80 ? [`  … and ${u.personaDiff.length - 80} more lines`] : [])]),
      ...(envelope.missions.length === 0
        ? []
        : ['', 'New missions it suggests, each off until you turn it on:', ...missionLines(envelope.missions)]),
      '',
      'Missions it already has are yours and stay exactly as they are. Its handle, its account and its memory do not change.',
      `File:  ${envelope.file}`,
      `Proposed by ${envelope.proposedBy}.`,
    ].join('\n');
  }
  return [
    `Add ${envelope.package.title} ${envelope.package.version} from the catalogue (made by buddi).`,
    '',
    renderCreate(envelope.created as CreateAgentEnvelope, specs),
    '',
    ...(envelope.account === null
      ? []
      : [
          `Speaks through ${envelope.account.label} with ${envelope.account.model}` +
            `${envelope.inheritedFrom === null ? '' : ` (from @${envelope.inheritedFrom})`}; change it on the Agents page.`,
          '',
        ]),
    ...(picks.length === 0
      ? []
      : ['For this owner (written after its persona):', ...picks.map((p) => `  ${p.label.replace(/[?:.\s]+$/, '')}: ${p.value}`), '']),
    ...(envelope.skills.length === 0
      ? []
      : [
          `It arrives with ${envelope.skills.length} skill${envelope.skills.length === 1 ? '' : 's'} of its own ` +
            '(a procedure in its prompt; it grants no tool and lowers no tier):',
          ...envelope.skills.map((s) => `  ${s.name} — ${s.description}`),
          '',
        ]),
    ...(envelope.missions.length === 0
      ? []
      : [`Its missions (pause or start any of them under Agents → Missions):`, ...missionLines(envelope.missions), '']),
    `Once you approve, this file is YOURS: an update from the catalogue is always offered, never written`,
    'without your approval, and a file you change is never touched.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

/** The listing as the tool and the routes show it. */
export interface CatalogueEntryView {
  name: string;
  version: string;
  handle: string;
  title: string;
  pitch: string;
  description: string;
  about: string;
  category: string;
  trust: string;
  author: { name: string; url?: string };
  requires: Record<string, string>;
  optional: Record<string, string>;
  needs: string[];
  tools: string[];
  missions: Array<{ id: string; name: string; cron: string; when: string; prompt: string }>;
  fills: Array<{ id: string; kind: string; label: string; optional: boolean; default: string }>;
  examples: string[];
  skills: string[];
  changes: string;
  replaces: string[];
  avatar: string | null;
  page: string | null;
  claims?: Record<string, unknown>;
  state: PackageState['state'];
  missing?: Array<MissingPlugin | MissingNeed>;
  installed?: InstalledAs;
  reason?: string;
}

export function entryView(pkg: AgentPackage, state: PackageState, timezone: string, defaults?: FilledPick[]): CatalogueEntryView {
  const m = pkg.manifest;
  return {
    name: m.name,
    version: m.version,
    handle: m.handle,
    title: m.title,
    pitch: m.pitch,
    description: m.description,
    about: m.about,
    category: m.category,
    trust: m.trust,
    author: m.author,
    requires: m.requires,
    optional: m.optional,
    needs: m.needs,
    tools: m.tools,
    missions: m.missions.map((mission) => ({
      id: mission.id,
      name: mission.name,
      cron: mission.cron,
      when: describeCadence(mission.cron, timezone),
      prompt: mission.prompt,
    })),
    fills: m.fills.map((fill) => ({
      id: fill.id,
      kind: fill.kind,
      label: fill.label,
      optional: fill.optional === true,
      default: defaults?.find((d) => d.id === fill.id)?.value ?? '',
    })),
    examples: m.examples,
    skills: pkg.skills.map((s) => s.name),
    changes: m.changes,
    replaces: m.replaces,
    avatar: pkg.avatar,
    page: pkg.page,
    ...(m.claims === undefined ? {} : { claims: m.claims }),
    state: state.state,
    ...(state.state === 'needs' ? { missing: state.missing } : {}),
    ...(state.state === 'installed' ? { installed: state.installed } : {}),
    ...(state.state === 'unavailable' ? { reason: state.reason } : {}),
  };
}

/** A context for `packageState`, read once for a whole list. */
export async function stateContext(
  registry: ToolRegistry,
  service: CatalogueService,
  binding: CatalogueBinding,
): Promise<StateContext> {
  return {
    registry,
    version: await service.version(),
    needs: await service.needs(),
    plugins: service.plugins(),
    added: addedAgents(binding.agentsDir),
    handleOf: (id) => binding.catalog.get(id)?.handle ?? id,
  };
}

export function createCatalogueTools(
  registry: ToolRegistry,
  helpers: CatalogueHelpers,
): [ToolDefinition<Record<string, never>, unknown>, ToolDefinition<InstallAgentInput, unknown>] {
  const catalogue: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.catalogue',
    description:
      'The agent catalogue: ready-made teammates buddi publishes on withbuddi.com (a chef, a researcher, a CFO…), ' +
      'each with what it is for, its category, the picks it asks, its missions (they arrive off) and where it stands ' +
      'here: ready, needs a plugin or a mailbox, already added (with an update when one is out), or unavailable. ' +
      'Read this before you offer one, and before you make an agent from scratch: the owner may want one already listed.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx: CoreToolContext) {
      const service = helpers.service(registry);
      if (!service) return { unavailable: 'this process has no catalogue bound', agents: [] };
      const loaded = await service.load();
      if ('unavailable' in loaded) return { unavailable: CATALOGUE_OFFLINE, agents: [] };
      const binding = helpers.resolved(registry);
      const state = await stateContext(registry, service, binding);
      const choices = loaded.packages.some((p) => p.manifest.fills.length > 0) ? await service.choices() : null;
      return {
        fetchedAt: loaded.fetchedAt,
        ...(loaded.stale ? { stale: true } : {}),
        agents: loaded.packages.map((pkg) => {
          const view = entryView(pkg, packageState(pkg, state), ctx.timezone);
          return {
            name: view.name,
            version: view.version,
            title: view.title,
            handle: view.handle,
            pitch: view.pitch,
            category: view.category,
            about: view.about,
            state: view.state,
            ...(view.missing ? { missing: view.missing } : {}),
            ...(view.installed ? { installed: view.installed } : {}),
            ...(view.reason ? { reason: view.reason } : {}),
            picks: pkg.manifest.fills.map((fill) => ({
              id: fill.id,
              kind: fill.kind,
              question: fill.label,
              optional: fill.optional === true,
              ...(choices && fill.kind === 'mailbox' ? { choices: choices.mailboxes } : {}),
              ...(choices && fill.kind === 'calendar' ? { choices: choices.calendars } : {}),
              ...(choices && fill.kind === 'place' ? { choices: choices.places.map((p) => p.label) } : {}),
            })),
            missions: view.missions.map((mission) => ({ id: mission.id, name: mission.name, when: mission.when })),
            examples: view.examples,
            tools: view.tools,
          };
        }),
        fromPlugins: helpers
          .proposals(registry)
          .filter(({ plugin, agent }) => !loaded.packages.some((p) => p.manifest.replaces.includes(`${plugin}/${agent.id}`)))
          .map(({ plugin, agent }) => ({
            plugin,
            id: agent.id,
            name: agent.name,
            description: agent.description,
            accepted: binding.catalog.get(agent.id) !== undefined,
          })),
        note:
          'Add one with platform.install_agent: ask the owner each pick in a sentence first (a missing answer takes its ' +
          'default), and which missions to turn on now. Agents "from" a plugin are added with platform.accept_plugin_agent.',
      };
    },
  };

  const install: ToolDefinition<InstallAgentInput, unknown> = {
    name: 'platform.install_agent',
    description:
      'Add an agent from the catalogue (platform.catalogue) to the owner\'s team, or update one already added (`agent`). ' +
      'Its persona is written verbatim with the owner\'s picks after it; it gets exactly the tools the package asks for, ' +
      'shown to the owner tool by tool; its missions arrive off unless the owner asked for them. Needs the owner\'s ' +
      'approval, and the file is theirs once written. A package whose plugin is not installed is refused here: the ' +
      'dashboard\'s catalogue installs a by-buddi plugin on the way, so send the owner there, or install the plugin first.',
    tier: 'gated',
    input: installAgentInput,
    async describe(input, ctx: CoreToolContext) {
      const envelope = await buildInstallEnvelope(input, {
        registry,
        helpers,
        proposedBy: ctx.agentId ?? 'unknown',
        timezone: ctx.timezone,
        ...(ctx.db ? { db: ctx.db } : {}),
      });
      return { envelope, preview: renderInstallPreview(envelope, registry.list(), helpers.renderCreatePreview) };
    },
    async execute(input, ctx: CoreToolContext) {
      const envelope = await buildInstallEnvelope(input, {
        registry,
        helpers,
        proposedBy: ctx.agentId ?? 'unknown',
        timezone: ctx.timezone,
        ...(ctx.db ? { db: ctx.db } : {}),
      });
      assertApprovedEffect(ctx, envelope);
      const binding = helpers.resolved(registry);
      const dir = path.dirname(envelope.file);
      const sidecar = composeProvenance({
        source: 'market',
        plugin: 'market',
        package: envelope.package.name,
        version: envelope.package.version,
        agent: envelope.package.name,
        acceptedAt: ctx.now(),
        proposal: envelope.package.integrity,
        // Hashed without the owner's `skills:` grants, which an update carries over.
        file: packageOwnedText(envelope.content),
        fills: pickRecord(envelope.picks),
        skills: Object.fromEntries(envelope.skills.map((skill) => [skill.name, skill.content])),
      });
      let trashed: string | null = null;
      /** Put the tree back as it was, when the catalogue will not load with the change. */
      let undo: () => void;
      if (envelope.mode === 'install') {
        createAgentDirAtomic(dir, {
          [AGENT_FILE]: envelope.content,
          [PROVENANCE_FILE]: sidecar,
          ...Object.fromEntries(envelope.skills.map((skill) => [path.join(SKILLS_DIR, `${skill.name}.md`), skill.content])),
        });
        undo = () => rmSync(dir, { recursive: true, force: true });
      } else {
        const u = envelope.update as NonNullable<InstallAgentEnvelope['update']>;
        const retiredFile = (name: string): string => path.join(dir, SKILLS_DIR, `${name}.md`);
        // Every path this touches, as it is now: what an undo writes back.
        const before = new Map<string, string | null>();
        for (const file of [envelope.file, path.join(dir, PROVENANCE_FILE), ...envelope.skills.map((s) => s.file), ...u.retires.map(retiredFile)]) {
          before.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null);
        }
        // What goes to the trash, where a deleted agent goes: moving it back restores it.
        // The owner's file when they changed it; any skill of theirs a package skill
        // replaces; every skill this version retires.
        const aside = path.join(binding.trashRoot, 'agents', `${envelope.id}-${trashStamp(ctx.now())}-replaced`);
        const kept: Array<{ path: string; content: string }> = [];
        if (u.edited) {
          trashed = path.join(aside, AGENT_FILE);
          kept.push({ path: trashed, content: before.get(envelope.file) ?? '' });
        }
        for (const skill of envelope.skills) {
          const now = before.get(skill.file);
          if (now !== null && now !== undefined && now !== skill.content) kept.push({ path: path.join(aside, SKILLS_DIR, `${skill.name}.md`), content: now });
        }
        for (const name of u.retires) {
          const now = before.get(retiredFile(name));
          if (now !== null && now !== undefined) kept.push({ path: path.join(aside, SKILLS_DIR, `${name}.md`), content: now });
        }
        if (kept.length > 0) writeFilesAtomic(kept);
        writeFilesAtomic([
          { path: envelope.file, content: envelope.content },
          { path: path.join(dir, PROVENANCE_FILE), content: sidecar },
          ...envelope.skills.map((skill) => ({ path: skill.file, content: skill.content })),
        ]);
        for (const name of u.retires) rmSync(retiredFile(name), { force: true });
        undo = () => {
          writeFilesAtomic([...before].filter((e): e is [string, string] => e[1] !== null).map(([file, content]) => ({ path: file, content })));
          for (const [file, content] of before) if (content === null) rmSync(file, { force: true });
          if (kept.length > 0) rmSync(aside, { recursive: true, force: true });
        };
      }
      const reload = helpers.reload(registry);
      if (!reload.reloaded) {
        // A tree the catalogue refuses would not boot either: nothing stays written.
        undo();
        helpers.reload(registry);
        refuse(
          'would-not-load',
          `${envelope.mode === 'install' ? `${envelope.package.title} was not added` : `@${envelope.handle} was not updated`}, and ` +
            `nothing was changed: the agents would not load with it (${reload.error ?? reload.message}).`,
        );
      }
      const assigned = envelope.mode === 'install' ? await helpers.assignAccount(registry, envelope.id, envelope.account) : '';
      let pictured = false;
      // The package's picture is kept in the database at install, so every page draws it without asking
      // the market again. An update gives one only to an agent that has none (the fetch failed at install,
      // or it came through `replaces`); a face the owner chose is never replaced.
      const wantsPicture =
        envelope.mode === 'install' || (ctx.db ? (await readAvatar(ctx.db as never, envelope.id).catch(() => null)) === null : false);
      if (wantsPicture && envelope.avatar && ctx.db) {
        // Best effort: an agent without its face is still the agent the owner approved.
        try {
          const service = helpers.service(registry);
          const pkg = service ? await findPackage(service, envelope.package.name) : null;
          const bytes = pkg ? await service!.avatar(pkg) : null;
          if (bytes) {
            await writeAvatar(ctx.db, envelope.id, await normaliseAvatar(bytes));
            pictured = true;
          }
        } catch {
          pictured = false;
        }
      }
      const created: string[] = [];
      if (ctx.db) {
        for (const mission of envelope.missions) {
          if (envelope.mode === 'update' && (await getMission(ctx.db as never, mission.id).catch(() => null))) continue;
          await upsertMission(ctx.db as never, {
            id: mission.id,
            name: mission.name,
            agentId: envelope.id,
            prompt: mission.prompt,
            enabled: mission.enabled,
            alwaysDeliver: mission.alwaysDeliver ?? false,
          });
          await setSchedule(ctx.db as never, mission.id, {
            cron: mission.cron,
            timezone: mission.timezone,
            // The owner's zone of the moment: it follows the owner.
            timezoneExplicit: false,
            misfirePolicy: mission.misfirePolicy ?? 'coalesce',
          });
          created.push(mission.id);
        }
      }
      return {
        ok: true,
        mode: envelope.mode,
        id: envelope.id,
        handle: envelope.handle,
        file: envelope.file,
        package: { name: envelope.package.name, version: envelope.package.version },
        tools: envelope.tools,
        skills: envelope.skills.map((s) => s.name),
        missions: created,
        ...(pictured ? { picture: true } : {}),
        ...(trashed ? { previousFile: trashed } : {}),
        live: reload.reloaded,
        message:
          (envelope.mode === 'install'
            ? `@${envelope.handle} is on the team, and the file is the owner's now. `
            : `@${envelope.handle} is ${envelope.package.title} ${envelope.package.version} now${trashed ? `; the owner's previous file is at ${trashed}` : ''}. `) +
          `${reload.message}${assigned}`,
      };
    },
  };
  return [catalogue, install];
}

/** The plan the dashboard's sheet draws: the envelope and its preview, nothing written. */
export async function planInstall(
  registry: ToolRegistry,
  helpers: CatalogueHelpers,
  input: InstallAgentInput,
  ctx: Pick<CoreToolContext, 'timezone' | 'db'> & { agentId?: string },
): Promise<{ envelope: InstallAgentEnvelope; preview: string; plan: string }> {
  const envelope = await buildInstallEnvelope(input, {
    registry,
    helpers,
    proposedBy: ctx.agentId ?? 'owner',
    timezone: ctx.timezone,
    ...(ctx.db ? { db: ctx.db } : {}),
  });
  return { envelope, preview: renderInstallPreview(envelope, registry.list(), helpers.renderCreatePreview), plan: planFingerprint(envelope) };
}
