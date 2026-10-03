/**
 * An agent package from the catalogue (buddi-planning/specs/agent-catalogue.md
 * §3): what one listing in the market's `agents` index is, read strictly.
 *
 * A package is configuration, never code: a persona, a few text skills, a
 * tool grant, missions that arrive off, the picks the install sheet asks, and
 * three example asks. Nothing in it runs. So the reading here is strict on
 * purpose: an unknown field is refused, a field v1 does not allow (`model`,
 * `provider`, `account`, `delegates`, `bundles`, roles) is refused by name, and
 * the integrity the market wrote is recomputed and must match before anything
 * is planned from it.
 *
 * The index carries each package as its `agent.json` plus what the folder
 * holds beside it (buddi-market `scripts/index.mjs`): `persona` (persona.md,
 * inline), `skills` (`[{ file, text }]`, each `skills/<file>`), `avatar`
 * (`{ url, sha256 }`: the picture on withbuddi.com and its hash) and `page`.
 *
 * The integrity (buddi-market `scripts/agents.mjs`, `agentIntegrity`) is
 * `sha256-<base64>` of one canonical JSON document:
 *
 *     { "agent.json": <agent.json without integrity and claims>,
 *       "persona.md": <its text>,
 *       "skills": { "<file>.md": <its text>, … },
 *       "avatar.png": "sha256-<base64 of the picture's sha256>" | null }
 *
 * canonical: keys sorted at every depth, no whitespace. Key order and
 * whitespace in the file therefore never move it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  REPORT_MAX_LIMIT,
  missionExtrasProblem,
  HANDLE,
  HANDLE_MIN,
  IDLE_ROLLOVERS,
  KEBAB,
  parseCron,
  parseSkillFile,
  STARTERS_MAX,
} from '@buddi/core';

/** The catalogue's categories, in the order the chips are drawn (§13: Life is the sixth). */
export const CATALOGUE_CATEGORIES = ['work', 'money', 'home', 'health', 'learning', 'life'] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];

/** What the install sheet may ask (§7). */
export const FILL_KINDS = ['mailbox', 'calendar', 'place', 'time', 'text'] as const;
export type FillKind = (typeof FILL_KINDS)[number];

/** Requirements that are not plugins (§3 `needs`). */
export const PACKAGE_NEEDS = ['mailbox', 'image-account'] as const;
/** As a package writes them: `mailbox?` is a mailbox that makes it better, never one it waits for. */
export const PACKAGE_NEED_WORDS = ['mailbox', 'mailbox?', 'image-account'] as const;
export type PackageNeed = (typeof PACKAGE_NEEDS)[number];

/** Sizes the market check holds a package to; buddi holds the index to the same. */
export const MAX_PERSONA_BYTES = 16 * 1024;
export const MAX_SKILL_BYTES = 8 * 1024;
export const MAX_SKILLS = 8;

/**
 * Tools no package may ask for in v1 (§9), on top of `checkTools`' own rule
 * that no `platform.*` write is grantable. Owner-only tools are left out of
 * every grant by the registry already. The owner may add any of these by hand
 * after the install; a package never carries them.
 */
export const CATALOGUE_DENIED: readonly string[] = [
  'host.*',
  'secret.*',
  'secrets.*',
  'developer.*',
  'mcp.*',
  'agent.delegate',
  'owner.set_profile',
  'owner.finish_onboarding',
  'owner.rename_me',
  'email.send',
  'email.add_account',
  'email.remove_account',
  'email.set_password',
];

/** Fields a v1 package may not carry, refused by name rather than as "unknown". */
const NOT_IN_V1 = ['model', 'provider', 'account', 'delegates', 'bundles'] as const;

const semverLike = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/, 'a semver version, like 1.0.0');
const kebab = z.string().regex(KEBAB, 'kebab-case');
const ident = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'lower-case letters, digits and hyphens');
const rangeMap = z.record(kebab, z.string().min(1).max(64));

const missionSchema = z
  .object({
    id: ident,
    name: z.string().min(1).max(60),
    cron: z.string().regex(/^\S+ \S+ \S+ \S+ \S+$/, 'five cron fields'),
    prompt: z.string().min(1).max(4000),
    misfirePolicy: z.enum(['replay-all', 'coalesce', 'latest-only', 'skip-after-deadline']).optional(),
    alwaysDeliver: z.boolean().optional(),
    /** Host API 1.27: the longest report it takes, 200–6,000 characters. */
    reportMax: z.number().int().min(200).max(REPORT_MAX_LIMIT).optional(),
    /** Host API 1.27: an export of a required plugin, read before each run. */
    context: z
      .object({
        plugin: kebab,
        export: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/, 'an export name'),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const fillSchema = z
  .object({
    id: ident,
    kind: z.enum(FILL_KINDS),
    label: z.string().min(1).max(80),
    optional: z.boolean().optional(),
    /** For a `time` pick: which mission's hour it sets. */
    mission: ident.optional(),
  })
  .strict();

/** `agent.json`, strict. */
export const agentManifestSchema = z
  .object({
    kind: z.literal('agent'),
    name: ident,
    version: semverLike,
    handle: z.string().min(HANDLE_MIN).max(32).regex(HANDLE, 'a handle: lower-case letters, digits and hyphens'),
    title: z.string().min(1).max(40),
    pitch: z.string().min(1).max(120),
    description: z.string().min(1).max(240),
    about: z.string().min(1).max(600),
    category: z.enum(CATALOGUE_CATEGORIES),
    trust: z.literal('by-buddi'),
    author: z.object({ name: z.string().min(1).max(80), url: z.string().regex(/^https:\/\//).optional() }).strict(),
    license: z.string().min(1).max(60),
    buddi: z.string().min(1).max(64),
    requires: rangeMap,
    optional: rangeMap,
    needs: z.array(z.enum(PACKAGE_NEED_WORDS)).max(4),
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.([a-z][a-z0-9_]*|\*)\??$/, 'a tool name or family glob')).min(1).max(64),
    missions: z.array(missionSchema).max(6),
    fills: z.array(fillSchema).max(6),
    examples: z.array(z.string().min(1).max(120)).max(STARTERS_MAX),
    language: z.enum(['mirror', 'en', 'fr']),
    idleRollover: z.enum(IDLE_ROLLOVERS).optional(),
    /** By-buddi packages may answer for roles (CFO: overview, recap, credit), so role missions and watchers reach them. */
    roles: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/)).max(6).optional(),
    replaces: z.array(z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/, '<source>/<agent id>')).max(4),
    changes: z.string().min(1).max(200),
    integrity: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/, 'sha256-<base64>'),
    claims: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type PackageMission = z.infer<typeof missionSchema>;
export type PackageFill = z.infer<typeof fillSchema>;

/** One text skill as the package carries it. */
export interface PackageSkill {
  /** `skills/<file>` in the folder. */
  file: string;
  text: string;
  /** Read out of the file's frontmatter. */
  name: string;
  description: string;
  body: string;
}

/** A listing, read and checked. */
export interface AgentPackage {
  manifest: AgentManifest;
  persona: string;
  skills: PackageSkill[];
  /** The picture's URL on withbuddi.com, or null. */
  avatar: string | null;
  /** Its hash as the integrity covers it: `sha256-<base64>`. */
  avatarSha256: string | null;
  page: string | null;
}

export class PackageRefusal extends Error {
  override readonly name = 'PackageRefusal';
}

const indexExtras = z
  .object({
    persona: z.string().min(1),
    skills: z.array(z.object({ file: z.string().regex(/^[a-z][a-z0-9-]{1,63}\.md$/), text: z.string() }).strict()).max(MAX_SKILLS).optional(),
    avatar: z
      .object({ url: z.string().url(), sha256: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/) })
      .strict()
      .nullable()
      .optional(),
    page: z.string().url().nullable().optional(),
  })
  .strict();

const INDEX_EXTRA_KEYS = ['persona', 'skills', 'avatar', 'page'] as const;

function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `sha256-<base64>`: how the market writes a hash. */
export function sriSha256(bytes: string | Buffer): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

/** Keys sorted at every depth, no whitespace: the form the integrity hashes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The package integrity (see the header): over the manifest, the persona, each skill and the picture's hash. */
export function packageIntegrity(input: {
  manifest: Record<string, unknown>;
  persona: string;
  skills: ReadonlyArray<{ file: string; text: string }>;
  /** `sha256-<base64>` of the picture, or null. */
  avatarSha256: string | null;
}): string {
  const { integrity: _integrity, claims: _claims, ...manifest } = input.manifest;
  const doc = {
    'agent.json': manifest,
    'persona.md': input.persona,
    skills: Object.fromEntries(input.skills.map((skill) => [skill.file, skill.text])),
    'avatar.png': input.avatarSha256,
  };
  return sriSha256(Buffer.from(canonicalJson(doc), 'utf8'));
}

/** The first zod problem, as one sentence with its path. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'not a package';
  if (issue.code === 'unrecognized_keys') return `unknown field ${issue.keys.map((k) => `"${k}"`).join(', ')}`;
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  return `${where}${issue.message}`;
}

/**
 * Read one index listing into a package, or refuse with the reason. Checks the
 * shape, the v1 limits, the sizes, the skills' own frontmatter, the missions'
 * schedules, the fills' references, the `?` tools against `optional`, the
 * denylist, and the integrity.
 */
export function parseAgentPackage(raw: unknown): AgentPackage {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PackageRefusal('a listing is an object');
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '?';
  for (const field of NOT_IN_V1) {
    if (field in record) throw new PackageRefusal(`${name}: "${field}" is not allowed in a v1 package`);
  }
  const manifestPart: Record<string, unknown> = {};
  const extraPart: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((INDEX_EXTRA_KEYS as readonly string[]).includes(key)) extraPart[key] = value;
    else manifestPart[key] = value;
  }
  const manifest = agentManifestSchema.safeParse(manifestPart);
  if (!manifest.success) throw new PackageRefusal(`${name}: ${firstIssue(manifest.error)}`);
  const extras = indexExtras.safeParse(extraPart);
  if (!extras.success) throw new PackageRefusal(`${name}: ${firstIssue(extras.error)}`);
  const m = manifest.data;
  const persona = extras.data.persona;
  if (Buffer.byteLength(persona, 'utf8') > MAX_PERSONA_BYTES) throw new PackageRefusal(`${name}: persona.md is larger than 16 KB`);

  const skills: PackageSkill[] = (extras.data.skills ?? []).map((skill) => {
    if (Buffer.byteLength(skill.text, 'utf8') > MAX_SKILL_BYTES) {
      throw new PackageRefusal(`${name}: skills/${skill.file} is larger than 8 KB`);
    }
    const fileName = skill.file.slice(0, -'.md'.length);
    let parsed: ReturnType<typeof parseSkillFile>;
    try {
      parsed = parseSkillFile(skill.text, { fileName });
    } catch (err) {
      throw new PackageRefusal(`${name}: skills/${skill.file} does not load: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { file: skill.file, text: skill.text, name: parsed.name, description: parsed.description, body: parsed.body };
  });

  if ((m.roles?.length ?? 0) > 0 && m.trust !== 'by-buddi') throw new PackageRefusal(`${name}: roles are for by-buddi packages only`);
  if (m.needs.includes('mailbox') && m.needs.includes('mailbox?')) throw new PackageRefusal(`${name}: needs names mailbox and mailbox? both`);
  for (const mission of m.missions) {
    if (mission.misfirePolicy === 'skip-after-deadline') {
      throw new PackageRefusal(`${name}: mission "${mission.id}" skips after a deadline it cannot name; buddi takes another misfire policy`);
    }
    try {
      parseCron(mission.cron);
    } catch (err) {
      throw new PackageRefusal(`${name}: mission "${mission.id}" has a schedule that does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const mission of m.missions) {
    // A mission's context reads a plugin the package requires: it must be there when the run starts.
    const problem = missionExtrasProblem(mission, Object.keys(m.requires));
    if (problem !== undefined) throw new PackageRefusal(`${name}: ${problem}`);
  }
  const missionIds = new Set(m.missions.map((mission) => mission.id));
  if (missionIds.size !== m.missions.length) throw new PackageRefusal(`${name}: two missions share an id`);
  const fillIds = new Set(m.fills.map((fill) => fill.id));
  if (fillIds.size !== m.fills.length) throw new PackageRefusal(`${name}: two picks share an id`);
  for (const fill of m.fills) {
    if (fill.kind === 'time') {
      if (fill.mission === undefined || !missionIds.has(fill.mission)) {
        throw new PackageRefusal(`${name}: the time pick "${fill.id}" must name one of the package's missions`);
      }
    } else if (fill.mission !== undefined) {
      throw new PackageRefusal(`${name}: only a time pick names a mission ("${fill.id}" is ${fill.kind})`);
    }
  }
  for (const tool of m.tools) {
    const trimmed = tool.trim();
    if (trimmed.endsWith('?')) {
      const family = trimmed.slice(0, -1).split('.')[0] ?? '';
      // A mail tool holds only if provided when the mailbox is optional (`mailbox?`).
      if (family === 'email' && m.needs.includes('mailbox?')) continue;
      if (!(family in m.optional)) {
        throw new PackageRefusal(`${name}: "${trimmed}" holds only if provided, so its plugin "${family}" must be in "optional"`);
      }
    }
  }
  const denied = deniedTools(m.tools, []);
  if (denied.length > 0) throw new PackageRefusal(`${name}: a package may not ask for ${denied.join(', ')}`);
  for (const plugin of Object.keys(m.requires)) {
    if (plugin in m.optional) throw new PackageRefusal(`${name}: "${plugin}" is both required and optional`);
  }

  const avatar = extras.data.avatar?.url ?? null;
  const avatarSha256 = extras.data.avatar?.sha256 ?? null;
  const computed = packageIntegrity({ manifest: manifestPart, persona, skills, avatarSha256 });
  if (computed !== m.integrity) {
    throw new PackageRefusal(`${name}: what withbuddi.com lists does not hash to its integrity (${m.integrity}), so buddi will not use it`);
  }
  return { manifest: m, persona, skills, avatar, avatarSha256, page: extras.data.page ?? null };
}

function globMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/**
 * The tools the denylist refuses: any resolved name it covers, and any
 * declared entry that names a denied family or tool even while nothing here
 * provides it (`host.*?`).
 */
export function deniedTools(declared: readonly string[], resolved: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of resolved) if (CATALOGUE_DENIED.some((deny) => globMatches(deny, name))) out.add(name);
  for (const entry of declared) {
    const pattern = entry.trim().replace(/\?$/, '');
    for (const deny of CATALOGUE_DENIED) {
      const denyFamily = deny.endsWith('.*') ? deny.slice(0, -2) : null;
      const entryFamily = pattern.endsWith('.*') ? pattern.slice(0, -2) : null;
      if (
        globMatches(deny, pattern) ||
        (denyFamily !== null && (pattern === denyFamily || pattern.startsWith(`${denyFamily}.`))) ||
        // `email.*` would reach `email.send`: refused as the family it is.
        (entryFamily !== null && !deny.includes('*') && deny.startsWith(`${entryFamily}.`))
      ) {
        out.add(pattern);
      }
    }
  }
  return [...out];
}

/** `17:00` → [17, 0]; null when it is not a time of day. */
export function parseClock(value: string): [number, number] | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The hour a cron fires at, as HH:MM, when it names exactly one. */
export function cronClock(cron: string): string | null {
  const [minute, hour] = cron.trim().split(/\s+/);
  if (!minute || !hour || !/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** The cron with its minute and hour moved to `clock`; unchanged when either is not a plain number. */
export function cronAt(cron: string, clock: string): string {
  const parts = cron.trim().split(/\s+/);
  const at = parseClock(clock);
  if (!at || parts.length !== 5 || cronClock(cron) === null) return cron;
  return [String(at[1]), String(at[0]), ...parts.slice(2)].join(' ');
}

/** One pick as the owner answered it (or as its default left it). */
export interface FilledPick {
  id: string;
  kind: FillKind;
  label: string;
  value: string;
}

/**
 * The persona as written into the agent file: the package's verbatim, then
 * "## For this owner" built from the picks and nothing else (§7). A time pick
 * moves its mission instead; an empty pick says nothing. The owner's name,
 * timezone, language and places are never written: every agent is told them
 * on every turn.
 */
export function composePackagePersona(persona: string, picks: readonly FilledPick[]): string {
  const lines = picks
    .filter((pick) => pick.kind !== 'time' && pick.value.trim() !== '')
    .map((pick) => `- ${pick.label.trim().replace(/[?:.\s]+$/, '')}: ${pick.value.trim()}`);
  if (lines.length === 0) return persona.trim();
  return `${persona.trim()}\n\n## For this owner\n\n${lines.join('\n')}`;
}

/** sha256 hex of a text, for the sidecar's file hash. */
export function fileHash(text: string): string {
  return sha256Hex(text);
}
