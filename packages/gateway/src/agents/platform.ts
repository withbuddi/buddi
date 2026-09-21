/**
 * The `platform.*` tools — the owner can make an agent by asking for one.
 *
 * Until now, adding an agent meant opening an editor, learning a frontmatter
 * schema, guessing which tool names this build actually registers, and
 * restarting the service. Every one of those is a small tax, and together they
 * are the reason most installations have exactly the agents they were shipped
 * with. This family removes all four: the owner says what they want, an agent
 * proposes a file, the owner approves it, and the new agent answers in the same
 * process a second later.
 *
 * What makes that safe is not a rule about what may be written — it is where
 * the rules are enforced:
 *
 *  - **Every write is `gated`.** No exceptions, no "small" edit, no tier that
 *    lets an agent quietly adjust its own file. Creating an agent is creating a
 *    principal; editing one is editing a principal's privileges.
 *  - **The grant is the boundary, so the grant is the preview.** `tools:` is
 *    the only thing that decides what an agent can reach, so the loudest thing
 *    in every preview is what the grant reaches, in the registered tools' own
 *    words (`platform-grant.ts`), and an update that *widens* a grant says so
 *    in capitals with the added names listed separately.
 *  - **Validation happens before the action exists.** Everything knowable —
 *    shapes, uniqueness, whether each tool is registered, whether the model
 *    belongs to the provider, whether the composed file parses — is checked in
 *    `describe`, which runs before any approval is recorded. So a preview never
 *    describes something that cannot happen, and an approval never fails on
 *    something the machine already knew. A failure there is a refusal with the
 *    reason, never a pending action.
 *  - **`examples/` is the platform's.** Nothing here writes into it. An owner
 *    who wants to change a shipped example is offered a private copy instead,
 *    which is the mechanism the search path already documents.
 *  - **Self-edits are labelled.** An agent may propose changes to its own file
 *    — that is how an agent learns — but the preview says whose file it is, so
 *    "grant myself the finance tools" can never read like routine maintenance.
 *
 * And then it is live: after a successful write the process catalog is rebuilt
 * and swapped behind the façade every surface holds (`catalog.ts`), so the CLI
 * session, Telegram, the web chat and the mission runner all resolve the new
 * agent on their next turn without `buddi service restart`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  assertApprovedEffect,
  HANDLE,
  HANDLE_MAX,
  HANDLE_MIN,
  AGENT_FILE,
  KEBAB,
  PROVIDER_KINDS,
  accountModelProblem,
  modelProblem,
  parseAgentFile,
  parseSkillFile,
  patchAgentSource,
  resolveToolNames,
  SKILLS_DIR,
  type FrontmatterPatch,
  type PluginManifest,
  type ProviderKind,
  type SuggestedAgent,
  type SuggestedSkill,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolSpec,
  listGroups as coreListGroups,
  createGroup as coreCreateGroup,
  updateGroup as coreUpdateGroup,
  archiveGroup as coreArchiveGroup,
  planGroupChange,
  GroupRefusal,
  type GroupCandidate,
  type GroupRow,
  type CatalogAgent,
} from '@buddi/core';
import { z } from 'zod';
import { composeProvenance, driftFor, proposalChecksum, PROVENANCE_FILE } from '../plugins/provenance.js';
import { agentSearchPath, EXAMPLES_AGENTS_DIR, type ReloadableAgentCatalog } from './catalog.js';
import { DELEGATES_FILE, readDelegates } from './delegation.js';
import { insideExamples } from './owner-tools.js';
import {
  composeAgentFile,
  composeSkillFile,
  createAgentDirAtomic,
  moveAgentAside,
  replaceBody,
  skillFilePath,
  trashStamp,
  writeFilesAtomic,
  TRASH_DIR,
  type AgentFileSpec,
} from './platform-files.js';
import {
  delegateToWriterRefusal,
  PLATFORM_READ_TOOLS,
  writeToolsIn,
} from './platform-names.js';
import {
  diffGrant,
  grantBlock,
  grantChangeBlock,
  type GrantChange,
} from './platform-grant.js';


/** Plugin family name. Eight tools, no tables of its own. */
export const PLATFORM_PLUGIN = 'platform';

/** The longest agent id this family will write. A directory name, not an essay. */
export const MAX_AGENT_ID = 40;

/**
 * The sentence the write tools end with.
 *
 * Repeated per tool rather than stated once, for the same reason the `owner.*`
 * family repeats its interview rules: a model reads one description at the
 * moment it decides to call that tool, not a preamble it saw earlier.
 */
const CONDUCT =
  'Ask what the agent is FOR before you propose anything, and propose the smallest tool grant ' +
  'that does that job. Never hand an agent finance or mail access it does not need. Say in one ' +
  'sentence what the owner is about to approve before the approval arrives.';

/* ------------------------------------------------------------------ *
 * Binding
 * ------------------------------------------------------------------ */

export interface PlatformBinding {
  /** Every agent installed here, and the thing a write reloads. */
  catalog: ReloadableAgentCatalog;
  /** Rebuild the catalog in this process. Throws if the tree will not load. */
  reload: () => void;
  /** The owner's private agents directory. Defaults to the search path's. */
  agentsDir?: string;
  /** The owner's private shared-skills directory. */
  skillsDir?: string;
  /** The shipped examples, for the "never write here" check. */
  examplesDir?: string;
  /**
   * The named model accounts, when this installation has them. Read at call
   * time, because the service arrives after the tools are bound. Absent on an
   * installation still on environment credentials, where the agent file's own
   * `provider`/`model` is what runs.
   */
  accounts?: () => PlatformAccounts | undefined;
  /**
   * Record which agent is the default for this installation. Absent in a
   * process with no database (a unit test, a fixture), where `default: true`
   * is refused rather than silently doing nothing.
   */
  setDefaultAgent?: (agentId: string) => Promise<void>;
}

/** One named account, as the platform tools see it. */
export interface PlatformAccount {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  configured: boolean;
  defaultModel: string;
  assignedAgents: string[];
}

export interface PlatformAccounts {
  list(): PlatformAccount[];
  bindingOf(agentId: string): { accountId: string; model: string } | undefined;
  assign(agentId: string, accountId: string, model: string): Promise<unknown>;
}

interface ResolvedBinding
  extends Required<Omit<PlatformBinding, 'reload' | 'catalog' | 'accounts' | 'setDefaultAgent'>> {
  catalog: ReloadableAgentCatalog;
  accounts: PlatformAccounts | undefined;
  setDefaultAgent: ((agentId: string) => Promise<void>) | undefined;
  reload: () => void;
  /** Where a deleted agent goes: `<private>/.trash`. */
  trashRoot: string;
}

const bindings = new WeakMap<ToolRegistry, PlatformBinding>();

/** Wire a registry's platform tools once the catalog exists. */
export function bindPlatformTools(registry: ToolRegistry, binding: PlatformBinding): void {
  bindings.set(registry, binding);
}

/** A refusal the owner (or the model) can act on. Never becomes an action. */
export class PlatformRefusal extends Error {
  override readonly name = 'PlatformRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function resolved(registry: ToolRegistry, env: NodeJS.ProcessEnv = process.env): ResolvedBinding {
  const binding = bindings.get(registry);
  if (!binding) {
    throw new PlatformRefusal(
      'unbound',
      'this process has no agent catalog bound, so no agent file can be read or written',
    );
  }
  const search = agentSearchPath(env);
  const agentsDir = binding.agentsDir ?? search.owner.dir;
  return {
    catalog: binding.catalog,
    reload: binding.reload,
    accounts: binding.accounts?.(),
    setDefaultAgent: binding.setDefaultAgent,
    agentsDir,
    skillsDir: binding.skillsDir ?? search.owner.skillsDir,
    examplesDir: binding.examplesDir ?? EXAMPLES_AGENTS_DIR,
    trashRoot: path.join(path.dirname(path.resolve(agentsDir)), TRASH_DIR),
  };
}

/* ------------------------------------------------------------------ *
 * Refusal sentences
 * ------------------------------------------------------------------ */

/**
 * The offer that replaces an edit to a shipped example.
 *
 * `examples/` is the platform's half of the search path: an edit there is
 * overwritten by the next `git pull` and leaves a dirty tree in the meantime.
 * The private half exists precisely so an owner can override an example, so the
 * refusal names that mechanism instead of just saying no.
 */
export function examplesRefusal(id: string, file: string): string {
  return (
    `"${id}" is one of the examples this repository ships (${file}), and those files belong to ` +
    'the platform rather than to you — an edit there would be overwritten the next time buddi is ' +
    'updated. I can copy it into your own private directory instead and change the copy: your ' +
    'copy overrides the example everywhere, and it is never committed. Ask me to do that and I ' +
    'will propose it (platform.create_agent with the same id and replacesExample).'
  );
}

/* ------------------------------------------------------------------ *
 * Validation — all of it, before any action exists
 * ------------------------------------------------------------------ */

function refuse(code: string, message: string): never {
  throw new PlatformRefusal(code, message);
}

/** `@Ledger` however it was spelled. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

export function checkId(id: string): string {
  const value = id.trim();
  if (!KEBAB.test(value)) {
    refuse(
      'bad-id',
      `"${id}" is not a usable agent id. An id is lower-case words joined by hyphens — ` +
        'bookkeeper, night-desk, mail-triage - and it is also the directory the file lives in.',
    );
  }
  if (value.length > MAX_AGENT_ID) {
    refuse('bad-id', `an agent id can be at most ${MAX_AGENT_ID} characters; "${id}" is longer`);
  }
  return value;
}

export function checkHandle(handle: string): string {
  const value = normalizeHandle(handle);
  if (value.length < HANDLE_MIN) refuse('bad-handle', `a handle needs at least ${HANDLE_MIN} characters`);
  if (value.length > HANDLE_MAX) refuse('bad-handle', `a handle can be at most ${HANDLE_MAX} characters`);
  if (!HANDLE.test(value)) {
    refuse(
      'bad-handle',
      `"${handle}" is not a usable handle. A handle is what the owner types to address the agent — ` +
        'lower-case letters, digits and hyphens, starting with a letter, like @ledger or @night-desk.',
    );
  }
  return value;
}

/**
 * Every tool name the grant resolves to, or a refusal naming what exists.
 *
 * The second half is the rule that keeps this whole family from being a way
 * around itself: **the write tools are not grantable through the write tools.**
 * An approved `create_agent` that handed `platform.create_agent` to the agent
 * it was creating would be one approval buying an unbounded number of future
 * writers, and the owner's deliberate switch to a single agent would mean
 * nothing. Granting them is the owner's, in a text editor, and nowhere else.
 * The read half stays freely grantable: looking at the roster is not a
 * privilege worth guarding.
 */
export function checkTools(declared: readonly string[], registry: ToolRegistry, id: string): string[] {
  if (declared.length === 0) return [];
  let resolvedNames: string[];
  try {
    resolvedNames = resolveToolNames(declared, registry, id);
  } catch (err) {
    refuse(
      'unknown-tool',
      `${err instanceof Error ? err.message : String(err)}. Call platform.installed_tools to see ` +
        'what this installation actually has, and name a family (finance.*) or a tool from that list.',
    );
  }
  const writes = writeToolsIn(resolvedNames);
  if (writes.length > 0) {
    refuse(
      'ungrantable-tool',
      `I cannot grant ${writes.join(', ')} to "${id}". The tools that create, change and remove agents ` +
        'are not grantable through this tool at all — one approval must never buy a second agent that ' +
        'can write the installation forever after. They are granted only by the owner editing an agent ' +
        `file by hand. A glob like "platform.*" resolves to them, so name the read tools instead: ` +
        `${PLATFORM_READ_TOOLS.join(', ')}.`,
    );
  }
  return resolvedNames;
}

/** The write tools an installed agent holds. Empty for every agent but one. */
export function writeToolsHeldBy(catalog: ReloadableAgentCatalog, agentId: string): string[] {
  return writeToolsIn(catalog.get(agentId)?.tools ?? []);
}

/** What an agent will run on, once named accounts are the way. */
export interface AccountChoice { id: string; label: string; kind: string; model: string }

/**
 * Resolve `account` (a label or an id) against the named accounts, or say why
 * not. With accounts configured, `provider` is the old road and is refused by
 * name, the same way the CLI refuses `--provider`.
 */
export function checkAccount(
  accounts: PlatformAccounts | undefined,
  input: { account?: string | undefined; provider?: string | undefined; model?: string | undefined },
  options: { required: boolean; current?: { accountId: string; model: string } | undefined },
): AccountChoice | null {
  if (!accounts) return null;
  const all = accounts.list();
  if (all.length === 0) return null;
  const names = all.filter((a) => a.enabled).map((a) => `"${a.label}"`).join(', ');
  if (input.provider !== undefined) {
    refuse('use-account', `this installation runs agents on named accounts, not providers: pass \`account\` with one of ${names} (see platform.list_accounts).`);
  }
  const wanted = input.account?.trim();
  if (!wanted) {
    if (options.current) {
      if (input.model === undefined) return null;
      const row = all.find((a) => a.id === options.current!.accountId);
      if (!row) refuse('unknown-account', 'the account this agent runs on no longer exists; pass `account` to choose another');
      const problem = accountModelProblem(row.kind as never, input.model);
      if (problem) refuse('model-mismatch', `${problem} ("${row.label}" is ${row.kind})`);
      return { id: row.id, label: row.label, kind: row.kind, model: input.model.trim() };
    }
    if (!options.required) return null;
    refuse('choose-account', `which account should it run on? Ask the owner to pick one of ${names} and pass it as \`account\`.`);
  }
  const row = all.find((a) => a.label.toLowerCase() === wanted.toLowerCase()) ?? all.find((a) => a.id === wanted);
  if (!row) refuse('unknown-account', `no account is called "${wanted}". The owner has ${names}. Add one under Settings before assigning it.`);
  if (!row.enabled) refuse('account-disabled', `"${row.label}" is disabled. Ask the owner to enable it, or choose one of ${names}.`);
  const model = input.model?.trim() || row.defaultModel;
  const problem = accountModelProblem(row.kind as never, model);
  if (problem) refuse('model-mismatch', `${problem} ("${row.label}" is ${row.kind})`);
  return { id: row.id, label: row.label, kind: row.kind, model };
}

/** A face from a tool is an emoji, never a file name: files are the owner's to drop in. */
export function checkAvatar(value: string): string {
  const trimmed = value.trim();
  if (/[A-Za-z0-9./\\]/.test(trimmed)) {
    refuse('bad-avatar', 'avatar must be an emoji; an image file is something the owner adds beside the agent file themselves');
  }
  return trimmed;
}

export function checkProviderModel(provider: string | undefined, model: string | undefined): void {
  if (provider !== undefined && !PROVIDER_KINDS.includes(provider as ProviderKind)) {
    refuse('bad-provider', `"${provider}" is not a provider this build knows (${PROVIDER_KINDS.join(', ')})`);
  }
  if (model === undefined) return;
  const problem = modelProblem((provider as ProviderKind | undefined) ?? 'anthropic', model);
  if (problem !== undefined) refuse('model-mismatch', problem);
}

export function checkRoles(roles: readonly string[] | undefined): string[] | undefined {
  if (roles === undefined) return undefined;
  for (const role of roles) {
    if (!KEBAB.test(role.trim())) {
      refuse('bad-role', `"${role}" is not a usable role name; a role is kebab-case, like overview or recap`);
    }
  }
  return roles.map((r) => r.trim());
}

/** Every delegate must be an agent that is installed here, and not itself. */
export function checkDelegates(
  delegates: readonly string[] | undefined,
  catalog: ReloadableAgentCatalog,
  selfId: string,
): string[] | undefined {
  if (delegates === undefined) return undefined;
  const known = catalog.list();
  return delegates.map((raw) => {
    const wanted = raw.trim().replace(/^@/, '');
    if (wanted === selfId) refuse('self-delegate', `an agent cannot delegate to itself ("${selfId}")`);
    const match =
      known.find((a) => a.id === wanted) ?? known.find((a) => a.handle.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      refuse(
        'unknown-delegate',
        `"${raw}" is not an agent installed here (installed: ${known.map((a) => a.id).join(', ')}). ` +
          'An allowlist may only name agents that exist.',
      );
    }
    if (match.id === selfId) refuse('self-delegate', `an agent cannot delegate to itself ("${selfId}")`);
    // Delegation is a corridor: whoever can reach the caller can reach its
    // colleagues' tools through it. A colleague that can write the installation
    // would put `platform.create_agent` one hop from the agent that reads
    // untrusted email, which is exactly the path confining the writes closed.
    const held = writeToolsHeldBy(catalog, match.id);
    if (held.length > 0) refuse('delegate-is-writer', delegateToWriterRefusal(selfId, match.id, held));
    return match.id;
  });
}

/** The tool specs for a set of names, in registry order. */
function specsFor(registry: ToolRegistry): ToolSpec[] {
  return registry.list();
}

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export interface CreateAgentEnvelope {
  tool: 'platform.create_agent';
  /** The agent asking for this. Never the one named in the arguments. */
  proposedBy: string;
  id: string;
  handle: string;
  name: string;
  description: string;
  /** The absolute path this file will be written to. */
  file: string;
  /** Resolved against the registry, in registry order — the whole grant. */
  tools: string[];
  /** Exactly as the owner wrote it in the frontmatter (`finance.*`). */
  declaredTools: string[];
  delegates: string[] | null;
  delegatesFile: string | null;
  provider: string | null;
  model: string | null;
  /** The named account it will be assigned to once written. Null on legacy installs. */
  account: AccountChoice | null;
  maxTurns: number | null;
  language: string | null;
  avatar: string | null;
  accent: string | null;
  roles: string[];
  /** The complete resulting file, byte for byte. */
  content: string;
  /** True when this private file will override a shipped example of the same id. */
  replacesExample: boolean;
}

export interface UpdateAgentEnvelope {
  tool: 'platform.update_agent';
  proposedBy: string;
  id: string;
  handle: string;
  file: string;
  /** True when the caller is editing its own file. */
  isSelfEdit: boolean;
  toolsBefore: string[];
  toolsAfter: string[];
  added: string[];
  removed: string[];
  widened: boolean;
  /** Field-by-field, what the frontmatter change actually is. */
  changes: Array<{ key: string; from: string; to: string }>;
  personaChanged: boolean;
  delegatesBefore: string[];
  delegatesAfter: string[];
  /** A new account assignment, applied after the file is written. Null when unchanged. */
  account: AccountChoice | null;
  /** The handle after the change: the same one, unless the owner asked for another. */
  handleAfter: string;
  /** True when this agent becomes the one a chat with no agent named lands on. */
  becomesDefault: boolean;
  /**
   * The agent that holds the default right now, if any. Named in the preview
   * so the owner sees what they are moving away from — nothing is written to
   * its file: the default is an installation record, not a flag in a persona.
   */
  defaultFrom: { id: string; name: string } | null;
  /** The complete resulting file, byte for byte. */
  content: string;
}

export interface WriteSkillEnvelope {
  tool: 'platform.write_skill';
  proposedBy: string;
  name: string;
  scope: 'agent' | 'shared';
  agentId: string | null;
  file: string;
  replaces: boolean;
  provenance: string;
  description: string;
  /** Which agents will read it once it is on disk. */
  readBy: string[];
  content: string;
}

export interface DeleteAgentEnvelope {
  tool: 'platform.delete_agent';
  proposedBy: string;
  id: string;
  handle: string;
  name: string;
  directory: string;
  /** Where it is moved to. The timestamped leaf is decided when it runs. */
  trashDirectory: string;
  tools: string[];
  /** Agents whose allowlist names this one, and which would lose a colleague. */
  delegatedToBy: string[];
}

/* ------------------------------------------------------------------ *
 * Previews
 * ------------------------------------------------------------------ */

function personaBlock(content: string): string[] {
  const body = content.split('\n---\n').slice(1).join('\n---\n').trim();
  return ['Its persona, in full:', ...body.split('\n').map((line) => `  ${line}`)];
}

export function renderCreatePreview(envelope: CreateAgentEnvelope, specs: readonly ToolSpec[]): string {
  return [
    `Create a new agent: ${envelope.name} (@${envelope.handle})`,
    envelope.description,
    '',
    ...grantBlock(envelope.handle, envelope.tools, specs),
    '',
    ...(envelope.delegates && envelope.delegates.length > 0
      ? [`It may also hand work to: ${envelope.delegates.map((d) => `@${d}`).join(', ')}.`]
      : []),
    ...(envelope.replacesExample
      ? [
          `This file OVERRIDES the shipped example agent "${envelope.id}": from now on your copy is ` +
            'what loads, and the example stops being used.',
        ]
      : []),
    `File:  ${envelope.file}`,
    (envelope.account
      ? `Runs on: the "${envelope.account.label}" account (${envelope.account.kind}), model ${envelope.account.model}`
      : `Runs on: ${envelope.model ?? 'the installation default model'}` +
        `${envelope.provider === null ? '' : ` (${envelope.provider})`}`) +
      `, ${envelope.maxTurns ?? 'the default'} turns per run.`,
    ...(envelope.roles.length === 0 ? [] : [`Roles it answers for: ${envelope.roles.join(', ')}.`]),
    ...(envelope.avatar || envelope.accent
      ? [`Face: ${[envelope.avatar, envelope.accent].filter(Boolean).join(', ')}.`]
      : []),
    `Proposed by ${envelope.proposedBy}.`,
    '',
    ...personaBlock(envelope.content),
  ].join('\n');
}

export function renderUpdatePreview(envelope: UpdateAgentEnvelope, specs: readonly ToolSpec[]): string {
  const change: GrantChange = {
    added: envelope.added,
    removed: envelope.removed,
    kept: envelope.toolsAfter.filter((t) => !envelope.added.includes(t)),
    widened: envelope.widened,
  };
  return [
    `Change the agent ${envelope.handle === '' ? envelope.id : `@${envelope.handle}`} (${envelope.id})`,
    ...(envelope.isSelfEdit
      ? [
          '',
          `THIS IS THE CALLER'S OWN FILE. ${envelope.proposedBy} is proposing a change to itself — ` +
            'read the grant below as an agent asking for what it does not currently have.',
        ]
      : []),
    '',
    ...grantChangeBlock(envelope.handle, change, specs),
    '',
    ...(envelope.changes.length === 0
      ? []
      : [
          'What else changes:',
          ...envelope.changes.map((c) => `  ${c.key}: ${c.from} → ${c.to}`),
        ]),
    ...(envelope.becomesDefault
      ? [
          'It BECOMES THE DEFAULT AGENT: every chat that names no agent lands on it from now on' +
            `${envelope.defaultFrom ? `, and ${envelope.defaultFrom.name} (${envelope.defaultFrom.id}) stops being the default` : ''}. ` +
            'This is recorded for the installation; no other agent file is touched.',
        ]
      : []),
    ...(envelope.personaChanged ? ['Its persona is rewritten (the new text is below).'] : []),
    ...(envelope.delegatesBefore.join(',') === envelope.delegatesAfter.join(',')
      ? []
      : [
          `Who it may hand work to: ${envelope.delegatesBefore.join(', ') || 'nobody'} → ` +
            `${envelope.delegatesAfter.join(', ') || 'nobody'}`,
        ]),
    `File:  ${envelope.file}`,
    `Proposed by ${envelope.proposedBy}.`,
    ...(envelope.personaChanged ? ['', ...personaBlock(envelope.content)] : []),
  ].join('\n');
}

export function renderSkillPreview(envelope: WriteSkillEnvelope): string {
  return [
    `${envelope.replaces ? 'Rewrite' : 'Write'} a skill: ${envelope.name}`,
    envelope.description,
    '',
    envelope.scope === 'agent'
      ? `It is private to ${envelope.agentId}, and is composed into that agent's prompt on every run.`
      : `It is shared: it is composed into the prompt of ${
          envelope.readBy.length === 0 ? 'every agent' : envelope.readBy.join(', ')
        } on every run.`,
    'A skill grants no tool and lowers no tier — it is a procedure, not a privilege.',
    `Written by: ${envelope.provenance}. File: ${envelope.file}`,
    '',
    'The procedure, in full:',
    ...envelope.content.split('\n---\n').slice(1).join('\n---\n').trim().split('\n').map((l) => `  ${l}`),
  ].join('\n');
}

export function renderDeletePreview(envelope: DeleteAgentEnvelope): string {
  return [
    `Remove the agent ${envelope.name} (@${envelope.handle})`,
    '',
    'Nothing is destroyed: the whole directory is MOVED, and moving it back restores the agent.',
    `From: ${envelope.directory}`,
    `To:   ${envelope.trashDirectory}/${envelope.id}-<timestamp>`,
    '',
    `It loses ${envelope.tools.length} tools and stops answering @${envelope.handle} immediately.`,
    ...(envelope.delegatedToBy.length === 0
      ? []
      : [
          `${envelope.delegatedToBy.join(', ')} name it in their delegate allowlist and will no ` +
            'longer be able to hand it work.',
        ]),
    `Proposed by ${envelope.proposedBy}.`,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Building the envelopes
 * ------------------------------------------------------------------ */

const createInput = z
  .object({
    id: z.string().min(1).describe('The agent id and its directory name: kebab-case, like "bookkeeper".'),
    handle: z.string().min(1).describe('What the owner types to address it, without the @: "bookkeeper".'),
    name: z.string().min(1).max(80).describe('Its display name, e.g. "Bookkeeper".'),
    description: z
      .string()
      .min(1)
      .max(300)
      .describe('One line on what it is for. Other agents read this to decide whether to hand it work.'),
    persona: z
      .string()
      .min(1)
      .describe(
        'The whole persona, in markdown: who it is, what it does, what it must never do, and how it ' +
          'writes. This is the body of the file and the agent it creates is only as good as this text. ' +
          'Never list its tools here — the wiring section is generated.',
      ),
    tools: z
      .array(z.string().min(1))
      .describe(
        'The tool grant, as names or family globs ("memory.*", "reminder.set"). THIS IS THE PRIVILEGE ' +
          'BOUNDARY: the agent can call exactly what is named here and nothing else, ever. Name the ' +
          'smallest set that does the job and check it against platform.installed_tools first.',
      ),
    account: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The named model account it runs on, by the name the owner gave it (platform.list_accounts). ' +
          'Leave it out and the new agent runs where the default agent runs — the brain the owner ' +
          'already chose. Name one only when the owner asked for a different one; never guess.',
      ),
    model: z.string().min(1).optional().describe("Pin a model the account serves. Leave it out for the account's default."),
    provider: z.enum(['anthropic', 'openai']).optional().describe('Legacy: only for installations without named accounts.'),
    maxTurns: z.number().int().positive().max(64).optional().describe('Turn budget per run. Default 12.'),
    language: z.enum(['mirror', 'en', 'fr']).optional().describe('Default "mirror": answer in the owner\'s language.'),
    avatar: z
      .string()
      .min(1)
      .max(8)
      .optional()
      .describe('An emoji for its face, e.g. "🧪". Pick one that says what it does; the owner can change it.'),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe('Its own colour, as #rrggbb. Leave it out for a tint chosen from its id.'),
    roles: z.array(z.string().min(1)).optional().describe('Capabilities it answers for, e.g. ["recap"].'),
    delegates: z
      .array(z.string().min(1))
      .optional()
      .describe('Agent ids it may hand work to. Authorization: name only what it genuinely needs.'),
    replacesExample: z
      .boolean()
      .optional()
      .describe(
        'Only when the owner asked to change a shipped example agent: writes a private copy under the ' +
          'same id, which overrides the example everywhere. Never set it to take an id that is already ' +
          "one of the owner's own agents.",
      ),
  })
  .strict();

type CreateInput = z.infer<typeof createInput>;

function buildCreateEnvelope(
  input: CreateInput,
  deps: { binding: ResolvedBinding; registry: ToolRegistry; proposedBy: string },
): CreateAgentEnvelope {
  const { binding, registry } = deps;
  const id = checkId(input.id);
  const handle = checkHandle(input.handle);

  const installed = binding.catalog.list();
  const idClash = installed.find((a) => a.id.toLowerCase() === id.toLowerCase());
  if (idClash) {
    if (idClash.source !== 'example') {
      refuse(
        'duplicate-id',
        `you already have an agent called "${idClash.id}" (@${idClash.handle}). Pick another id, or ` +
          'ask me to change that one instead (platform.update_agent).',
      );
    }
    if (input.replacesExample !== true) {
      refuse('duplicate-id', examplesRefusal(idClash.id, binding.catalog.get(idClash.id)?.file ?? idClash.id));
    }
  }
  const handleClash = installed.find((a) => a.handle.toLowerCase() === handle.toLowerCase());
  if (handleClash && handleClash.id.toLowerCase() !== id.toLowerCase()) {
    refuse(
      'duplicate-handle',
      `@${handle} is already ${handleClash.name} (${handleClash.id}). One handle names exactly one ` +
        'agent, so pick another one.',
    );
  }

  // Where a new agent runs, when nobody said: where the default agent runs.
  // Asking "which account?" for the second agent on an installation with one
  // is a question with one answer, and guessing a provider instead of reading
  // the one the owner already chose is how a new agent arrives on a company
  // they never signed up with.
  const inherited =
    input.account === undefined && input.provider === undefined && input.model === undefined
      ? inheritedAccount(binding)
      : null;
  const account = inherited ?? checkAccount(binding.accounts, input, { required: true });
  if (account === null) checkProviderModel(input.provider, input.model);
  const tools = checkTools(input.tools, registry, id);
  const roles = checkRoles(input.roles);
  const delegates = checkDelegates(input.delegates, binding.catalog, id);
  if (input.persona.trim() === '') refuse('empty-persona', 'an agent with no persona is not an agent');

  const file = path.join(binding.agentsDir, id, 'agent.md');
  if (insideExamples(file, binding.examplesDir)) {
    refuse('examples-tree', `I will not write into ${binding.examplesDir}: that tree belongs to the platform.`);
  }
  if (existsSync(path.join(binding.agentsDir, id))) {
    refuse(
      'directory-exists',
      `${path.join(binding.agentsDir, id)} already exists on disk, even though no agent loaded from it. ` +
        'Move or remove it first; I will not write over a directory I did not create.',
    );
  }

  const spec: AgentFileSpec = {
    id,
    handle,
    name: input.name.trim(),
    description: input.description.trim(),
    tools: input.tools.map((t) => t.trim()),
    // With named accounts the model lives on the assignment, not in the file:
    // the file's provider vocabulary cannot name an endpoint or a subscription.
    ...(account === null && input.provider !== undefined ? { provider: input.provider } : {}),
    ...(account === null && input.model !== undefined ? { model: input.model.trim() } : {}),
    ...(roles === undefined ? {} : { roles }),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.avatar === undefined ? {} : { avatar: checkAvatar(input.avatar) }),
    ...(input.accent === undefined ? {} : { accent: input.accent.toLowerCase() }),
    // Replacing the example that declares `default: true` must not leave the
    // installation without a default agent: the claim travels with the file.
    ...(idClash?.isDefault === true ? { default: true } : {}),
    persona: input.persona,
  };
  const content = composeAgentFile(spec);
  // The loader's own verdict, before the owner is asked anything.
  try {
    parseAgentFile(content, { dirName: id });
  } catch (err) {
    refuse('would-not-load', `this would write a file the loader refuses: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    tool: 'platform.create_agent',
    proposedBy: deps.proposedBy,
    id,
    handle,
    name: spec.name,
    description: spec.description,
    file,
    tools,
    declaredTools: spec.tools,
    delegates: delegates ?? null,
    delegatesFile: delegates === undefined ? null : path.join(binding.agentsDir, id, DELEGATES_FILE),
    provider: account === null ? (input.provider ?? null) : null,
    model: account === null ? (input.model?.trim() ?? null) : account.model,
    account,
    maxTurns: input.maxTurns ?? null,
    language: input.language ?? null,
    avatar: spec.avatar ?? null,
    accent: spec.accent ?? null,
    roles: roles ?? [],
    content,
    replacesExample: idClash !== undefined,
  };
}

const updateInput = z
  .object({
    id: z.string().min(1).describe('Which agent to change, by id.'),
    name: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe(
        'A new display name. THIS IS HOW AN AGENT IS RENAMED: the id, the file and everything the ' +
          'agent has ever done stay exactly as they are. Never create a second agent and delete the first.',
      ),
    handle: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A new handle — what the owner types to reach it, without the @. Only when the owner wants it ' +
          'to change: a rename does not move the handle by itself. Ask once, in plain words.',
      ),
    default: z
      .literal(true)
      .optional()
      .describe(
        'Make this the default agent: the one every chat with no agent named lands on. The claim is ' +
          'taken off whoever holds it in the same approval, so a swap is one decision, not two.',
      ),
    persona: z.string().min(1).optional().describe('A new persona, replacing the body of the file entirely.'),
    description: z.string().min(1).max(300).optional(),
    tools: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'A NEW tool grant, replacing the current one entirely — not an addition. Adding a family here ' +
          'widens what this agent can reach, and the owner is shown exactly what was added.',
      ),
    account: z.string().min(1).optional().describe('Move it to another named model account, by name (platform.list_accounts).'),
    model: z.string().min(1).optional().describe('A model the account serves.'),
    provider: z.enum(['anthropic', 'openai']).optional().describe('Legacy: only for installations without named accounts.'),
    maxTurns: z.number().int().positive().max(64).optional(),
    language: z.enum(['mirror', 'en', 'fr']).optional(),
    avatar: z
      .string()
      .min(1)
      .max(8)
      .optional()
      .describe('A new emoji face, e.g. "🧪". This is how an agent\'s face is changed — in place, on the file it already has.'),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe('Its own colour, as #rrggbb. Leave it out for a tint chosen from its id.'),
    roles: z.array(z.string().min(1)).optional(),
    delegates: z.array(z.string().min(1)).optional().describe('A new delegate allowlist, replacing the current one.'),
  })
  .strict();

type UpdateInput = z.infer<typeof updateInput>;

function buildUpdateEnvelope(
  input: UpdateInput,
  deps: { binding: ResolvedBinding; registry: ToolRegistry; proposedBy: string },
): UpdateAgentEnvelope {
  const { binding, registry } = deps;
  const id = input.id.trim();
  const agent = binding.catalog.get(id) ?? binding.catalog.byHandle(id);
  if (!agent) {
    refuse(
      'unknown-agent',
      `there is no agent "${input.id}" here (installed: ${binding.catalog
        .list()
        .map((a) => a.id)
        .join(', ')})`,
    );
  }
  // Whose file this is, asked of the catalog rather than of the id: the owner's
  // first agent is written under the shipped example's id on purpose (it is how
  // it replaces it), and a guard that keyed on the name would refuse to rename
  // the one agent every installation has.
  if (isExample(agent, binding)) {
    refuse('examples-tree', examplesRefusal(agent.id, agent.file));
  }

  const name = input.name === undefined ? undefined : input.name.trim();
  if (name !== undefined && name === '') refuse('bad-name', 'a name is one to 60 characters');
  const handle = input.handle === undefined ? undefined : checkHandle(input.handle);
  if (handle !== undefined && handle !== agent.handle.toLowerCase()) {
    // Every agent, examples included: the roster holds back the examples this
    // installation has not grown into yet, and a handle one of them answers to
    // is still taken the moment it comes back.
    const taken = [
      ...binding.catalog.list().filter((other) => other.handle.toLowerCase() === handle),
      ...(binding.catalog.byHandle(handle) ? [binding.catalog.byHandle(handle)!] : []),
    ].find((other) => other.id !== agent.id);
    if (taken) {
      refuse(
        'duplicate-handle',
        `@${handle} is already ${taken.name} (${taken.id}). One handle names exactly one agent, so ask ` +
          'the owner for another one.',
      );
    }
  }

  const current = binding.accounts?.bindingOf(agent.id);
  const account = checkAccount(binding.accounts, input, { required: false, current });
  if (account === null && binding.accounts === undefined) checkProviderModel(input.provider ?? agent.provider.kind, input.model);
  const onAccounts = binding.accounts !== undefined && binding.accounts.list().length > 0;
  const toolsAfter =
    input.tools === undefined ? [...agent.tools] : checkTools(input.tools, registry, agent.id);
  const roles = checkRoles(input.roles);
  const delegates = checkDelegates(input.delegates, binding.catalog, agent.id);

  /*
   * The default moves as a *record*, in one write, and no agent file changes.
   * Whoever holds it simply stops being named by the installation — there is
   * no second file to patch, which is what used to make this the one action
   * that could half-succeed.
   */
  const holder = input.default === true ? defaultHolder(binding) : undefined;
  const becomesDefault = input.default === true && holder?.id !== agent.id;
  if (becomesDefault && binding.setDefaultAgent === undefined) {
    refuse(
      'no-record',
      'this process cannot record which agent is the default (no installation database is bound), ' +
        'so the default cannot be moved from here',
    );
  }

  const source = readFileSync(agent.file, 'utf8');
  const patch: FrontmatterPatch = {
    ...(name === undefined ? {} : { name }),
    ...(handle === undefined ? {} : { handle }),
    ...(input.description === undefined ? {} : { description: input.description.trim() }),
    ...(input.tools === undefined ? {} : { tools: input.tools.map((t) => t.trim()) }),
    ...(!onAccounts && input.model !== undefined ? { model: input.model.trim() } : {}),
    ...(!onAccounts && input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.avatar === undefined ? {} : { avatar: checkAvatar(input.avatar) }),
    ...(input.accent === undefined ? {} : { accent: input.accent.toLowerCase() }),
    ...(roles === undefined ? {} : { roles }),
  };

  let edited;
  try {
    edited = patchAgentSource(source, patch, agent.file);
  } catch (err) {
    refuse('would-not-load', err instanceof Error ? err.message : String(err));
  }
  // Frontmatter first, then the body: a change to only the frontmatter leaves
  // the persona byte-for-byte identical, which is what `applyFrontmatterPatch`
  // guarantees and what an owner reviewing a one-word edit deserves to see.
  const content = input.persona === undefined ? edited.text : replaceBody(edited.text, input.persona, agent.file);
  try {
    parseAgentFile(content, { dirName: agent.id, file: agent.file });
  } catch (err) {
    refuse('would-not-load', `this change would leave an agent that cannot load: ${err instanceof Error ? err.message : String(err)}`);
  }

  const defaultFrom: UpdateAgentEnvelope['defaultFrom'] =
    becomesDefault && holder !== undefined ? { id: holder.id, name: holder.name } : null;

  const personaChanged = input.persona !== undefined && content !== edited.text;
  const delegatesBefore = readDelegates(agent.id, binding.agentsDir);
  const delegatesAfter = delegates ?? delegatesBefore;
  const accountChanged = account !== null && (account.id !== current?.accountId || account.model !== current?.model);
  if (content === source && delegatesAfter.join(',') === delegatesBefore.join(',') && !accountChanged && !becomesDefault) {
    refuse('no-change', `nothing in that would change ${agent.id}: the file already says exactly this`);
  }
  const currentLabel = current ? (binding.accounts?.list().find((a) => a.id === current.accountId)?.label ?? current.accountId) : undefined;

  const change = diffGrant(agent.tools, toolsAfter);
  const before = edited.before as Record<string, unknown>;
  const after = edited.after as Record<string, unknown>;
  return {
    tool: 'platform.update_agent',
    proposedBy: deps.proposedBy,
    id: agent.id,
    handle: agent.handle,
    file: agent.file,
    isSelfEdit: deps.proposedBy === agent.id,
    toolsBefore: [...agent.tools],
    toolsAfter,
    added: change.added,
    removed: change.removed,
    widened: change.widened,
    changes: [
      ...edited.changed.map((key) => ({
        key,
        from: renderValue(before[key]),
        to: renderValue(after[key]),
      })),
      ...(accountChanged
        ? [{
            key: 'runs on',
            from: current ? `${currentLabel}, ${current.model}` : '(unset)',
            to: `${account!.label}, ${account!.model}`,
          }]
        : []),
    ],
    personaChanged,
    delegatesBefore,
    delegatesAfter,
    account: accountChanged ? account : null,
    handleAfter: handle ?? agent.handle,
    becomesDefault,
    defaultFrom,
    content,
  };
}

/**
 * The account a new agent inherits: the default agent's, or the only usable
 * one, or nothing — never a provider this code picked.
 *
 * The default agent is the one the owner met and gave a brain to, so a
 * colleague made beside it thinks with the same one until they say otherwise.
 * A binding the accounts service no longer serves (a removed or disabled
 * account, a model that account cannot run) is not inherited: it would be a
 * new agent born unable to answer.
 */
function inheritedAccount(binding: ResolvedBinding): AccountChoice | null {
  const accounts = binding.accounts;
  if (!accounts) return null;
  const usable = accounts.list().filter((row) => row.enabled && row.configured);
  if (usable.length === 0) return null;
  const holder = defaultHolder(binding);
  const bound = holder ? accounts.bindingOf(holder.id) : undefined;
  const row = bound ? usable.find((candidate) => candidate.id === bound.accountId) : undefined;
  if (row && bound && !accountModelProblem(row.kind as never, bound.model)) {
    return { id: row.id, label: row.label, kind: row.kind, model: bound.model };
  }
  const only = usable.length === 1 ? usable[0]! : undefined;
  return only ? { id: only.id, label: only.label, kind: only.kind, model: only.defaultModel } : null;
}

/** Whose file this is, as the catalog knows it — never as the id reads. */
function isExample(agent: { source?: string; file: string }, binding: ResolvedBinding): boolean {
  return agent.source === undefined
    ? insideExamples(agent.file, binding.examplesDir)
    : agent.source === 'example';
}

/** The agent every chat with no agent named lands on, if one claims it. */
function defaultHolder(binding: ResolvedBinding): CatalogAgent | undefined {
  try {
    const id = binding.catalog.defaultAgent().id;
    return binding.catalog.get(id);
  } catch {
    // An installation with no default at all: there is nothing to take it from.
    return undefined;
  }
}

function renderValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

const skillInput = z
  .object({
    name: z.string().min(1).describe('Kebab-case, and it is also the file name: "staging-an-import".'),
    scope: z
      .enum(['agent', 'shared'])
      .describe('"agent" writes it into one agent\'s own skills; "shared" composes it into every agent\'s prompt.'),
    agentId: z.string().min(1).optional().describe('Required when scope is "agent": whose procedure it is.'),
    description: z.string().min(1).max(300).describe('One line on when this procedure applies.'),
    provenance: z
      .enum(['owner', 'agent', 'imported'])
      .describe('Who wrote it. "agent" when you wrote it yourself — never claim the owner did.'),
    body: z
      .string()
      .min(1)
      .describe(
        'The procedure itself, in markdown. It informs reasoning; it can never grant a tool or lower ' +
          'a tier, and a skill that tries to is refused.',
      ),
  })
  .strict();

type SkillInput = z.infer<typeof skillInput>;

function buildSkillEnvelope(
  input: SkillInput,
  deps: { binding: ResolvedBinding; proposedBy: string; source?: string },
): WriteSkillEnvelope {
  const { binding } = deps;
  const name = input.name.trim();
  if (!KEBAB.test(name)) {
    refuse('bad-name', `"${input.name}" is not a usable skill name; a skill name is kebab-case, like when-cash-is-short`);
  }
  let agentId: string | null = null;
  if (input.scope === 'agent') {
    if (input.agentId === undefined) refuse('missing-agent', 'scope "agent" needs an agentId: whose procedure is this?');
    const agent = binding.catalog.get(input.agentId.trim()) ?? binding.catalog.byHandle(input.agentId.trim());
    if (!agent) refuse('unknown-agent', `there is no agent "${input.agentId}" here`);
    if (isExample(agent, binding)) refuse('examples-tree', examplesRefusal(agent.id, agent.file));
    agentId = agent.id;
  }

  const file = skillFilePath({
    scope: input.scope,
    name,
    agentsDir: binding.agentsDir,
    sharedSkillsDir: binding.skillsDir,
    ...(agentId === null ? {} : { agentId }),
  });
  if (insideExamples(file, binding.examplesDir)) {
    refuse('examples-tree', `I will not write into ${binding.examplesDir}: that tree belongs to the platform.`);
  }

  // A shared skill that collides with an agent's private one fails the catalog
  // load for that agent — one name, one procedure. Caught here, not at boot.
  if (input.scope === 'shared') {
    for (const summary of binding.catalog.list()) {
      const agent = binding.catalog.get(summary.id);
      if (!agent) continue;
      // A skill living inside the agent's own directory is that agent's own.
      const ownDir = path.resolve(path.dirname(agent.file));
      const clash = agent.skills.find(
        (s) => s.name === name && path.resolve(s.file).startsWith(`${ownDir}${path.sep}`),
      );
      if (clash) {
        refuse(
          'duplicate-skill',
          `${summary.id} already has its own skill called "${name}" (${clash.file}); a shared skill of the ` +
            'same name would stop that agent loading. Pick another name.',
        );
      }
    }
  }

  const content = composeSkillFile({
    name,
    description: input.description.trim(),
    provenance: input.provenance,
    ...(deps.source === undefined ? {} : { source: deps.source }),
    body: input.body,
  });
  try {
    parseSkillFile(content, { fileName: name });
  } catch (err) {
    refuse('would-not-load', `this would write a skill the loader refuses: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    tool: 'platform.write_skill',
    proposedBy: deps.proposedBy,
    name,
    scope: input.scope,
    agentId,
    file,
    replaces: existsSync(file),
    provenance: input.provenance,
    description: input.description.trim(),
    readBy: input.scope === 'agent' ? [agentId as string] : binding.catalog.list().map((a) => a.id),
    content,
  };
}

const deleteInput = z.object({ id: z.string().min(1).describe('Which agent to remove, by id.') }).strict();

function buildDeleteEnvelope(
  input: z.infer<typeof deleteInput>,
  deps: { binding: ResolvedBinding; proposedBy: string },
): DeleteAgentEnvelope {
  const { binding } = deps;
  const agent = binding.catalog.get(input.id.trim()) ?? binding.catalog.byHandle(input.id.trim());
  if (!agent) refuse('unknown-agent', `there is no agent "${input.id}" here`);
  if (isExample(agent, binding)) {
    refuse(
      'examples-tree',
      `"${agent.id}" is a shipped example (${agent.file}); those files belong to the platform and I will ` +
        'not delete one. An example you do not want is overridden by a private agent of the same id, not removed.',
    );
  }
  if (agent.isDefault) {
    refuse(
      'is-default',
      `${agent.id} is the default agent — the one every chat with no agent named lands on. Move the claim ` +
        'first: platform.update_agent on the agent that should have it, with `default: true`, which takes ' +
        'it off this one in the same approval. Then remove this one. Renaming or refacing an agent is ' +
        'platform.update_agent too — never a new agent and a delete.',
    );
  }
  const directory = path.dirname(agent.file);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    refuse('missing-directory', `${directory} is not on disk any more; there is nothing to move`);
  }
  const delegatedToBy = binding.catalog
    .list()
    .filter((other) => other.id !== agent.id && readDelegates(other.id, binding.agentsDir).includes(agent.id))
    .map((other) => other.id);

  return {
    tool: 'platform.delete_agent',
    proposedBy: deps.proposedBy,
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    directory,
    trashDirectory: path.join(binding.trashRoot, 'agents'),
    tools: [...agent.tools],
    delegatedToBy,
  };
}


/* ------------------------------------------------------------------ *
 * Agents a plugin proposes
 * ------------------------------------------------------------------ */

/**
 * The agents every registered plugin proposes, with the plugin that proposed
 * each one.
 *
 * Read from the registry's own manifests rather than from a list of plugin
 * names, for the same reason `missions add-defaults` reads its suggestions
 * there: a plugin that arrived this morning through `buddi plugins install`
 * proposes its agents exactly as the compiled-in ones do, and nothing here has
 * heard of any plugin by name.
 */
export interface PluginAgentProposal {
  plugin: string;
  pluginVersion: string;
  agent: SuggestedAgent;
}

export function pluginAgentProposals(registry: ToolRegistry): PluginAgentProposal[] {
  return registry.manifests().flatMap((m) =>
    (m.agents ?? []).map((agent) => ({ plugin: m.name, pluginVersion: m.version, agent })),
  );
}

export function pluginSkillProposals(
  registry: ToolRegistry,
): Array<{ plugin: string; pluginVersion: string; skill: SuggestedSkill }> {
  return registry.manifests().flatMap((m) =>
    (m.skills ?? []).map((skill) => ({ plugin: m.name, pluginVersion: m.version, skill })),
  );
}

/** One proposal, or a refusal naming what is on offer. */
function findProposal(registry: ToolRegistry, plugin: string, agentId: string): PluginAgentProposal {
  const all = pluginAgentProposals(registry);
  const match = all.find(
    (p) => p.plugin === plugin.trim() && p.agent.id.toLowerCase() === agentId.trim().toLowerCase(),
  );
  if (!match) {
    refuse(
      'unknown-proposal',
      `no installed plugin proposes an agent "${agentId}" under "${plugin}". What is on offer: ` +
        `${all.map((p) => `${p.plugin}/${p.agent.id}`).join(', ') || 'nothing — no installed plugin proposes an agent'}. ` +
        'Call platform.plugin_agents to see them.',
    );
  }
  return match;
}

export interface AcceptPluginAgentEnvelope extends Omit<CreateAgentEnvelope, 'tool'> {
  tool: 'platform.accept_plugin_agent';
  /** The plugin whose proposal this is, and the version proposing it. */
  fromPlugin: { name: string; version: string };
  /** sha256 of the canonical proposal, recorded beside the file on accept. */
  proposalChecksum: string;
  /** Skills written into the new agent's own `skills/` by the same approval. */
  skills: Array<{ name: string; description: string; file: string; content: string }>;
}

const acceptAgentInput = z
  .object({
    plugin: z.string().min(1).describe('Which plugin proposed it, e.g. "weather".'),
    agent: z.string().min(1).describe('The proposed agent id, as platform.plugin_agents lists it.'),
  })
  .strict();

type AcceptAgentInput = z.infer<typeof acceptAgentInput>;

/**
 * Build the envelope for accepting a proposal.
 *
 * It is `buildCreateEnvelope` with the plugin's own arguments and nothing else:
 * the same id and handle uniqueness checks, the same `checkTools` — so a plugin
 * that proposes `platform.create_agent` for its advisor is refused with the
 * same sentence an agent asking for it would get — the same "would this file
 * even load" parse, all of it before any approval exists. A plugin gets no
 * shorter path to a principal than the owner's own agent does.
 */
function buildAcceptAgentEnvelope(
  input: AcceptAgentInput,
  deps: { binding: ResolvedBinding; registry: ToolRegistry; proposedBy: string },
): AcceptPluginAgentEnvelope {
  const proposal = findProposal(deps.registry, input.plugin, input.agent);
  const suggestion = proposal.agent;
  const base = buildCreateEnvelope(
    {
      id: suggestion.id,
      handle: suggestion.handle,
      name: suggestion.name,
      description: suggestion.description,
      persona: suggestion.persona,
      tools: suggestion.tools,
      ...(suggestion.model === undefined ? {} : { model: suggestion.model }),
      ...(suggestion.provider === undefined ? {} : { provider: suggestion.provider }),
      ...(suggestion.maxTurns === undefined ? {} : { maxTurns: suggestion.maxTurns }),
      ...(suggestion.language === undefined ? {} : { language: suggestion.language }),
      ...(suggestion.roles === undefined ? {} : { roles: suggestion.roles }),
    },
    deps,
  );
  const agentDir = path.dirname(base.file);
  const skills = (suggestion.skills ?? []).map((skill) => {
    const name = skill.name.trim();
    if (!KEBAB.test(name)) {
      refuse(
        'bad-name',
        `${proposal.plugin} proposes a skill called "${skill.name}", which is not a usable skill name ` +
          '(kebab-case, like when-cash-is-short)',
      );
    }
    const content = composeSkillFile({
      name,
      description: skill.description.trim(),
      provenance: 'imported',
      source: `${proposal.plugin}@${proposal.pluginVersion}`,
      body: skill.body,
    });
    try {
      parseSkillFile(content, { fileName: name });
    } catch (err) {
      refuse(
        'would-not-load',
        `${proposal.plugin} proposes a skill the loader refuses: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      name,
      description: skill.description.trim(),
      file: path.join(agentDir, SKILLS_DIR, `${name}.md`),
      content,
    };
  });
  return {
    ...base,
    tool: 'platform.accept_plugin_agent',
    fromPlugin: { name: proposal.plugin, version: proposal.pluginVersion },
    proposalChecksum: proposalChecksum(suggestion),
    skills,
  };
}

export function renderAcceptAgentPreview(
  envelope: AcceptPluginAgentEnvelope,
  specs: readonly ToolSpec[],
): string {
  return [
    `The ${envelope.fromPlugin.name} plugin (${envelope.fromPlugin.version}) proposes an agent, and this`,
    'would create it. A plugin cannot create an agent; only this approval can.',
    '',
    renderCreatePreview({ ...envelope, tool: 'platform.create_agent' }, specs),
    '',
    ...(envelope.skills.length === 0
      ? []
      : [
          `It also arrives with ${envelope.skills.length} skill${envelope.skills.length === 1 ? '' : 's'} of its own ` +
            '(a procedure in its prompt; it grants no tool and lowers no tier):',
          ...envelope.skills.map((s) => `  ${s.name} — ${s.description}`),
          '',
        ]),
    `Once you approve, this file is YOURS: it is written into ${path.dirname(envelope.file)} and`,
    `${envelope.fromPlugin.name} can never rewrite it. Upgrading the plugin will tell you if it starts`,
    'proposing something different, and change nothing.',
  ].join('\n');
}

/* ---- shared skills a plugin proposes ---- */

const acceptSkillInput = z
  .object({
    plugin: z.string().min(1).describe('Which plugin proposed it.'),
    skill: z.string().min(1).describe('The proposed skill name.'),
  })
  .strict();

type AcceptSkillInput = z.infer<typeof acceptSkillInput>;

function buildAcceptSkillEnvelope(
  input: AcceptSkillInput,
  deps: { binding: ResolvedBinding; registry: ToolRegistry; proposedBy: string },
): WriteSkillEnvelope & { fromPlugin: { name: string; version: string } } {
  const all = pluginSkillProposals(deps.registry);
  const match = all.find(
    (p) => p.plugin === input.plugin.trim() && p.skill.name.toLowerCase() === input.skill.trim().toLowerCase(),
  );
  if (!match) {
    refuse(
      'unknown-proposal',
      `no installed plugin proposes a shared skill "${input.skill}" under "${input.plugin}". On offer: ` +
        `${all.map((p) => `${p.plugin}/${p.skill.name}`).join(', ') || 'nothing'}.`,
    );
  }
  const envelope = buildSkillEnvelope(
    {
      name: match.skill.name,
      scope: 'shared',
      description: match.skill.description,
      provenance: 'imported',
      body: match.skill.body,
    },
    { binding: deps.binding, proposedBy: deps.proposedBy, source: `${match.plugin}@${match.pluginVersion}` },
  );
  return { ...envelope, fromPlugin: { name: match.plugin, version: match.pluginVersion } };
}

/* ------------------------------------------------------------------ *
 * The owner, editing directly
 * ------------------------------------------------------------------ */

/** The fields the owner may edit from the dashboard, validated by the tool's own schema. */
export const ownerEditableInput = updateInput;
export type OwnerAgentEdit = UpdateInput;

export interface OwnerEditResult {
  id: string;
  handle: string;
  file: string;
  tools: string[];
  changed: string[];
  personaChanged: boolean;
  live: boolean;
  message: string;
}

/**
 * Change an agent from the dashboard, with the tool's validation and none of
 * its approval.
 *
 * The same `buildUpdateEnvelope` `platform.update_agent` runs, so a handle
 * collision, a tool the registry does not have, and a change that would leave
 * a file the loader refuses are all refused here in exactly the same words. An
 * approval envelope is what a *model* proposing a change needs; the owner
 * clicking Save in their own dashboard already is the approval, so the
 * envelope is built, checked, and written.
 *
 * `default` is not editable here: it is not a field of the file. The Agents
 * page records the default through its own route.
 */
export async function updateAgentFromOwner(
  registry: ToolRegistry,
  input: OwnerAgentEdit,
): Promise<OwnerEditResult> {
  const binding = resolved(registry);
  if (input.default !== undefined) {
    refuse('not-a-field', 'which agent is the default is an installation record, not a field of the file');
  }
  const envelope = buildUpdateEnvelope(input, { binding, registry, proposedBy: 'owner' });
  const dir = path.dirname(envelope.file);
  writeFilesAtomic([
    { path: envelope.file, content: envelope.content },
    ...(envelope.delegatesAfter.join(',') === envelope.delegatesBefore.join(',')
      ? []
      : [
          {
            path: path.join(dir, DELEGATES_FILE),
            content: `${JSON.stringify(envelope.delegatesAfter, null, 2)}\n`,
          },
        ]),
  ]);
  const reload = reloadResult(binding);
  const assigned = await assignAccount(binding, envelope.id, envelope.account);
  return {
    id: envelope.id,
    handle: envelope.handleAfter,
    file: envelope.file,
    tools: envelope.toolsAfter,
    changed: envelope.changes.map((c) => c.key),
    personaChanged: envelope.personaChanged,
    live: reload.reloaded,
    message: `@${envelope.handleAfter} updated.${assigned}`,
  };
}

/* ------------------------------------------------------------------ *
 * Live reload
 * ------------------------------------------------------------------ */

/** The sentence every successful write ends with — and the honest one when it fails. */
/** Put the agent on its account once the file exists. The sentence, or nothing. */
async function assignAccount(binding: ResolvedBinding, agentId: string, account: AccountChoice | null): Promise<string> {
  if (!account || !binding.accounts) return '';
  try {
    await binding.accounts.assign(agentId, account.id, account.model);
    return ` Runs on "${account.label}" with ${account.model}.`;
  } catch (err) {
    return ` The file is written, but assigning "${account.label}" failed: ${err instanceof Error ? err.message : String(err)}. Assign it under Agents.`;
  }
}

export function reloadResult(binding: ResolvedBinding): { reloaded: boolean; message: string } {
  try {
    binding.reload();
    return {
      reloaded: true,
      message:
        'It is live in this process now — no restart. Every surface this process runs (the terminal ' +
        'session, Telegram, the dashboard chat and the scheduler) resolves it on its next message.',
    };
  } catch (err) {
    return {
      reloaded: false,
      message:
        'The file is written, but reloading the catalog failed, so the running surfaces still hold the ' +
        `previous one: ${err instanceof Error ? err.message : String(err)}. Tell the owner to fix that ` +
        'and run `buddi service restart`.',
    };
  }
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

/**
 * Turn a refusal into the sentence the model reads.
 *
 * `describe` is the only hook that runs before an action exists, so a refusal
 * there has to be a throw — and the message has to stand on its own, because
 * the registry wraps it in one line of its own and hands it straight to the
 * model.
 */
function describing<I, E>(build: (input: I) => E, render: (envelope: E) => string) {
  return (input: I): { envelope: E; preview: string } => {
    const envelope = build(input);
    return { envelope, preview: render(envelope) };
  };
}

function accountOf(accounts: PlatformAccounts, agentId: string): { account: string | null; model: string | null } {
  const binding = accounts.bindingOf(agentId);
  if (!binding) return { account: null, model: null };
  return { account: accounts.list().find((a) => a.id === binding.accountId)?.label ?? binding.accountId, model: binding.model };
}

/** What an approved change to a group is, hashed before it is made. */
export interface GroupUpdateEnvelope {
  tool: 'platform.update_group';
  id: string;
  before: { name: string; coordinator: string; members: string[] };
  after: { name: string; coordinator: string; members: string[] };
}

/**
 * The sentence the owner approves: the exact change, in their own words.
 *
 * "Add Garage to Test room; make Concierge the coordinator" — not a diff, not
 * the arguments as JSON. An owner reading this at seven in the morning has to
 * be able to tell what the room will look like afterwards without opening it.
 */
export function renderGroupUpdate(
  envelope: GroupUpdateEnvelope,
  nameOf: (agentId: string) => string = (id) => id,
): string {
  const { before, after } = envelope;
  const room = before.name;
  const list = (ids: string[]): string => {
    const names = ids.map(nameOf);
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  const added = after.members.filter((id) => !before.members.includes(id));
  const removed = before.members.filter((id) => !after.members.includes(id));
  const parts: string[] = [];
  if (after.name !== before.name) parts.push(`rename "${before.name}" to "${after.name}"`);
  if (added.length > 0) parts.push(`add ${list(added)} to ${room}`);
  if (removed.length > 0) parts.push(`remove ${list(removed)} from ${room}`);
  if (after.coordinator !== before.coordinator) parts.push(`make ${nameOf(after.coordinator)} the coordinator`);
  const sentence = parts.length === 0 ? `leave ${room} exactly as it is` : parts.join('; ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function createPlatformManifest(registry: ToolRegistry): PluginManifest {
  /* ---- groups: a team of agents in one conversation (docs/groups.md) ---- */

  const listGroups: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.list_groups',
    description:
      'The owner\'s groups: teams of agents that share one conversation on the dashboard, each with a ' +
      'coordinator that brings members in. Read this before proposing a group, so you do not propose one that exists.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx) {
      const binding = resolved(registry);
      const groups = await coreListGroups(ctx.db);
      return {
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          coordinator: binding.catalog.get(g.coordinator)?.handle ?? g.coordinator,
          members: g.members.map((id) => binding.catalog.get(id)?.handle ?? id),
        })),
        note: 'Groups live on the dashboard: the owner opens one under Chat and speaks to the team there.',
      };
    },
  };

  const createGroupInput = z.object({
    name: z.string().min(1).max(80).describe('What the team is for, as the owner would say it: "Household finances".'),
    coordinator: z.string().min(1).describe('The agent that reads the owner\'s request and brings members in, by handle or id. Usually the front desk.'),
    members: z.array(z.string().min(1)).min(1).max(12).describe('The other agents in the room, by handle or id. Membership grants no tool and no access; each keeps its own.'),
  }).strict();

  const createGroup: ToolDefinition<z.infer<typeof createGroupInput>, unknown> = {
    name: 'platform.create_group',
    description:
      'Create a group: a named team of installed agents that share one conversation, with one coordinator. ' +
      'Propose it in words first and create it only when the owner agrees. Membership grants nothing — each member ' +
      'keeps its own account, tools and approvals — and what is said in the room is seen by the room.',
    tier: 'gated',
    input: createGroupInput,
    async execute(input, ctx) {
      const binding = resolved(registry);
      const find = (ref: string): CatalogAgent | undefined => {
        const wanted = ref.trim().replace(/^@/, '');
        return binding.catalog.get(wanted) ?? binding.catalog.byHandle(wanted);
      };
      const coordinator = find(input.coordinator);
      if (!coordinator) throw new PlatformRefusal('unknown-agent', `No installed agent is "${input.coordinator}". Use platform.list_agents.`);
      const members: CatalogAgent[] = [];
      for (const ref of input.members) {
        const agent = find(ref);
        if (!agent) throw new PlatformRefusal('unknown-agent', `No installed agent is "${ref}". Use platform.list_agents.`);
        if (agent.id !== coordinator.id && !members.some((m) => m.id === agent.id)) members.push(agent);
      }
      if (members.length === 0) throw new PlatformRefusal('too-small', 'A group needs at least one member besides the coordinator.');
      const existing = (await coreListGroups(ctx.db)).find((g) => g.name.trim().toLowerCase() === input.name.trim().toLowerCase());
      if (existing) throw new PlatformRefusal('duplicate-group', `A group called "${existing.name}" already exists.`);
      const group = await coreCreateGroup(ctx.db, { name: input.name.trim(), coordinator: coordinator.id, members: members.map((m) => m.id) });
      return {
        id: group.id,
        name: group.name,
        coordinator: coordinator.handle,
        members: group.members.map((id) => binding.catalog.get(id)?.handle ?? id),
        note: `Created. The owner finds "${group.name}" under Chat, in Groups, on the dashboard.`,
      };
    },
  };

  const updateGroupInput = z.object({
    group: z.string().min(1).describe('The group to change, by name or id.'),
    name: z.string().min(1).max(80).optional().describe('A new name for the group. The group keeps its id and its whole conversation.'),
    coordinator: z.string().min(1).optional().describe('The agent that answers for the group, by handle or id. It has to be one of the members.'),
    members: z.array(z.string().min(1)).max(12).optional().describe('The WHOLE membership after the change, coordinator included, by handle or id. Anyone left out leaves the room; what they already said stays in the transcript.'),
  }).strict();

  type UpdateGroupInput = z.infer<typeof updateGroupInput>;

  /** Who this installation may put in a room, as core's rule wants them. */
  const groupRoster = (binding: ResolvedBinding): GroupCandidate[] =>
    binding.catalog.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      roles: agent.roles,
      available: agent.available && agent.heldBack === undefined,
    }));

  /** The group the owner named, by name or id, or a refusal saying so. */
  const findGroup = async (ref: string, db: ToolContext['db']): Promise<GroupRow> => {
    const groups = await coreListGroups(db);
    const wanted = ref.trim().toLowerCase();
    const group = groups.find((g) => g.id === ref.trim() || g.name.trim().toLowerCase() === wanted);
    if (!group) throw new PlatformRefusal('unknown-group', `No group is called "${ref}". Use platform.list_groups.`);
    return group;
  };

  /**
   * The change, resolved: which group, and exactly what it becomes.
   *
   * Read-only, so `describe` may run it before any approval exists, and run
   * again in `execute` — the envelope carries the state it was planned
   * against, so a group somebody changed in between no longer matches the
   * approved preview and the call is refused rather than replayed.
   */
  const planGroupUpdate = async (
    input: UpdateGroupInput,
    db: ToolContext['db'],
  ): Promise<{ group: GroupRow; envelope: GroupUpdateEnvelope; names: (id: string) => string }> => {
    const binding = resolved(registry);
    const group = await findGroup(input.group, db);
    const find = (ref: string): CatalogAgent => {
      const cleaned = ref.trim().replace(/^@/, '');
      const agent = binding.catalog.get(cleaned) ?? binding.catalog.byHandle(cleaned);
      if (!agent) throw new PlatformRefusal('unknown-agent', `No installed agent is "${ref}". Use platform.list_agents.`);
      return agent;
    };
    const change = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.coordinator === undefined ? {} : { coordinator: find(input.coordinator).id }),
      ...(input.members === undefined ? {} : { members: input.members.map((ref) => find(ref).id) }),
    };
    let after;
    try {
      after = planGroupChange(group, change, groupRoster(binding));
    } catch (error) {
      if (error instanceof GroupRefusal) throw new PlatformRefusal(error.code, error.message);
      throw error;
    }
    const names = (id: string): string => binding.catalog.get(id)?.name ?? id;
    return {
      group,
      names,
      envelope: {
        tool: 'platform.update_group',
        id: group.id,
        before: { name: group.name, coordinator: group.coordinator, members: [...group.members].sort() },
        after: { name: after.name, coordinator: after.coordinator, members: [...after.members].sort() },
      },
    };
  };

  const updateGroupTool: ToolDefinition<UpdateGroupInput, unknown> = {
    name: 'platform.update_group',
    description:
      'Change a group the owner already has: its name, which member coordinates it, or who is in it. ' +
      'Anything you do not name is left exactly as it is, and the group keeps its id and its whole ' +
      'conversation — a rename is THIS tool, never a new group and an archive. `members` REPLACES the ' +
      'membership, so pass everyone who should be in the room, the coordinator included; a member taken ' +
      'out keeps every turn it already spoke there. The coordinator has to be one of the members, a room ' +
      'needs somebody besides it, and membership still grants nothing. ' +
      CONDUCT,
    tier: 'gated',
    input: updateGroupInput,
    async describe(input, ctx) {
      const planned = await planGroupUpdate(input, ctx.db);
      return { envelope: planned.envelope, preview: renderGroupUpdate(planned.envelope, planned.names) };
    },
    async execute(input, ctx) {
      const planned = await planGroupUpdate(input, ctx.db);
      assertApprovedEffect(ctx, planned.envelope);
      const binding = resolved(registry);
      const after = planned.envelope.after;
      const group = await coreUpdateGroup(ctx.db, planned.group.id, after, groupRoster(binding));
      if (!group) throw new PlatformRefusal('unknown-group', `The group "${planned.group.name}" is no longer there.`);
      return {
        id: group.id,
        name: group.name,
        coordinator: binding.catalog.get(group.coordinator)?.handle ?? group.coordinator,
        members: group.members.map((id) => binding.catalog.get(id)?.handle ?? id),
        message: `${renderGroupUpdate(planned.envelope, planned.names)}. The owner sees it under Chat, in Groups.`,
      };
    },
  };

  const archiveInput = z.object({
    group: z.string().min(1).describe('The group to archive, by name or id.'),
  }).strict();

  const archiveGroupTool: ToolDefinition<z.infer<typeof archiveInput>, unknown> = {
    name: 'platform.archive_group',
    description:
      'Archive a group: it leaves the dashboard\'s roster and takes no new requests. Its conversations stay readable. ' +
      'Only when the owner asks for it, naming the group.',
    tier: 'gated',
    input: archiveInput,
    async describe(input, ctx) {
      const group = await findGroup(input.group, ctx.db);
      return {
        envelope: { tool: 'platform.archive_group', id: group.id, name: group.name },
        preview: `Archive ${group.name}: it leaves the dashboard's roster and takes no new requests. Everything said in it stays readable.`,
      };
    },
    async execute(input, ctx) {
      const group = await findGroup(input.group, ctx.db);
      assertApprovedEffect(ctx, { tool: 'platform.archive_group', id: group.id, name: group.name });
      const gone = await coreArchiveGroup(ctx.db, group.id, ctx.now());
      return { id: group.id, name: group.name, archived: gone };
    },
  };

  const listAccounts: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.list_accounts',
    description:
      'The named model accounts the owner has set up, by name: the provider each one is (an Anthropic ' +
      'or OpenAI API key, a Claude or ChatGPT subscription, or an OpenAI-compatible endpoint such as ' +
      'Ollama), its default model, whether it is usable, and which agents run on it. An agent runs on ' +
      'exactly one of these; name it as `account` when you create or change one. Never guess: if the ' +
      'owner has not said which, ask.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, _ctx) {
      const binding = resolved(registry);
      if (!binding.accounts) return { accounts: [], note: 'This installation has no named accounts; agents run on the credentials in the environment.' };
      return {
        accounts: binding.accounts.list().map((a) => ({
          name: a.label,
          provider: a.kind,
          defaultModel: a.defaultModel,
          usable: a.enabled && a.configured,
          usedBy: a.assignedAgents,
        })),
      };
    },
  };

  const listAgents: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.list_agents',
    description:
      'Every agent installed here: its id and handle, what it is for, whether it is one of the shipped ' +
      'examples or one of the owner\'s own, which tools it was granted, which model it runs on, and ' +
      'whether this machine can actually run it. Read this before you propose a new agent — an id or a ' +
      'handle that is already taken is refused.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, _ctx) {
      const binding = resolved(registry);
      return {
        agents: binding.catalog.list().map((summary) => {
          const agent = binding.catalog.get(summary.id);
          return {
            id: summary.id,
            handle: summary.handle,
            name: summary.name,
            description: summary.description,
            source: summary.source,
            isDefault: summary.isDefault,
            ...(binding.accounts
              ? accountOf(binding.accounts, summary.id)
              : { provider: summary.providerKind, model: agent?.model ?? null }),
            roles: summary.roles,
            tools: agent?.tools ?? [],
            delegates: readDelegates(summary.id, binding.agentsDir),
            canRun: summary.available,
            ...(summary.unavailableReason === undefined ? {} : { whyNot: summary.unavailableReason }),
          };
        }),
        privateAgentsDirectory: binding.agentsDir,
      };
    },
  };

  const installedTools: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.installed_tools',
    description:
      'Every tool this installation actually has, by family, with one line on what each one does and ' +
      'whether it runs on its own or needs the owner to approve it. Call this before you propose a tool ' +
      'grant: a grant naming a tool that is not installed is refused, and one you invented is worse.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, _ctx) {
      const specs = specsFor(registry);
      const families = new Map<string, Array<{ name: string; tier: string; description: string }>>();
      for (const spec of specs) {
        const family = spec.name.slice(0, spec.name.indexOf('.') === -1 ? undefined : spec.name.indexOf('.'));
        const entry = { name: spec.name, tier: spec.tier, description: spec.description };
        const bucket = families.get(family);
        if (bucket) bucket.push(entry);
        else families.set(family, [entry]);
      }
      return {
        families: [...families.entries()].map(([family, tools]) => ({
          family,
          glob: `${family}.*`,
          tools,
        })),
        total: specs.length,
      };
    },
  };

  const readAgent: ToolDefinition<{ id: string }, unknown> = {
    name: 'platform.read_agent',
    description:
      'One agent as it is written: the frontmatter that wires it, the persona in full, the skills ' +
      'composed into its prompt and where each of them came from. Read the agent before you propose a ' +
      'change to it — a rewrite proposed without reading the original is a rewrite of something you guessed.',
    tier: 'auto',
    input: z.object({ id: z.string().min(1).describe('The agent id, or its @handle.') }).strict(),
    async execute(input, _ctx) {
      const binding = resolved(registry);
      const agent = binding.catalog.get(input.id.trim()) ?? binding.catalog.byHandle(input.id.trim());
      if (!agent) {
        return {
          ok: false,
          reason: 'unknown-agent',
          message: `there is no agent "${input.id}" here`,
          installed: binding.catalog.list().map((a) => a.id),
        };
      }
      const parsed = parseAgentFile(readFileSync(agent.file, 'utf8'), { file: agent.file });
      return {
        ok: true,
        id: agent.id,
        file: agent.file,
        source: agent.source,
        editable: !insideExamples(agent.file, binding.examplesDir),
        frontmatter: parsed.frontmatter,
        persona: parsed.body,
        resolvedTools: agent.tools,
        delegates: readDelegates(agent.id, binding.agentsDir),
        skills: agent.skills,
      };
    },
  };

  const listSkills: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.list_skills',
    description:
      'Every skill installed here — the shared ones composed into prompts and the ones private to a ' +
      'single agent — with who wrote each and which file it lives in. A skill is a procedure, never a ' +
      'privilege: it cannot grant a tool.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, _ctx) {
      const binding = resolved(registry);
      const seen = new Map<string, { name: string; provenance: string; file: string; agents: string[] }>();
      for (const summary of binding.catalog.list()) {
        const agent = binding.catalog.get(summary.id);
        for (const skill of agent?.skills ?? []) {
          const entry = seen.get(skill.file);
          if (entry) entry.agents.push(summary.id);
          else
            seen.set(skill.file, {
              name: skill.name,
              provenance: skill.provenance,
              file: skill.file,
              agents: [summary.id],
            });
        }
      }
      return {
        skills: [...seen.values()].map((s) => ({
          ...s,
          scope: s.file.startsWith(binding.skillsDir) ? 'shared' : 'agent',
          shipped: insideExamples(s.file, path.dirname(binding.examplesDir)),
        })),
        sharedSkillsDirectory: binding.skillsDir,
      };
    },
  };

  const createAgent: ToolDefinition<CreateInput, unknown> = {
    name: 'platform.create_agent',
    description:
      'Create a new agent for the owner: a persona and the tools it may call, written as a file in their ' +
      'private agents directory. This needs the owner\'s approval, and what they are approving is ACCESS ' +
      '— the tool grant is the only thing that decides what the new agent can reach, and they see exactly ' +
      'what it reaches before they say yes. ' +
      CONDUCT,
    tier: 'gated',
    input: createInput,
    describe(input, ctx) {
      const binding = resolved(registry);
      return describing(
        (i: CreateInput) =>
          buildCreateEnvelope(i, { binding, registry, proposedBy: ctx.agentId ?? 'unknown' }),
        (envelope) => renderCreatePreview(envelope, specsFor(registry)),
      )(input);
    },
    async execute(input, ctx) {
      const binding = resolved(registry);
      // Rebuild and compare at the write boundary, after the executor's check.
      const envelope = buildCreateEnvelope(input, {
        binding,
        registry,
        proposedBy: ctx.agentId ?? 'unknown',
      });
      assertApprovedEffect(ctx, envelope);
      createAgentDirAtomic(path.dirname(envelope.file), {
        [AGENT_FILE]: envelope.content,
        ...(envelope.delegates === null
          ? {}
          : { [DELEGATES_FILE]: `${JSON.stringify(envelope.delegates, null, 2)}\n` }),
      });
      const reload = reloadResult(binding);
      const assigned = await assignAccount(binding, envelope.id, envelope.account);
      return {
        ok: true,
        id: envelope.id,
        handle: envelope.handle,
        file: envelope.file,
        tools: envelope.tools,
        live: reload.reloaded,
        message: `@${envelope.handle} exists. ${reload.message}${assigned}`,
      };
    },
  };

  const updateAgent: ToolDefinition<UpdateInput, unknown> = {
    name: 'platform.update_agent',
    description:
      'Change an agent the owner already has: its name, its handle, its face, its persona, its ' +
      'description, its model, its tool grant, or which agent is the default. Anything you do not name is ' +
      'left exactly as it is, and the agent keeps its id, its file and everything it has ever done — a ' +
      'rename or a new face is THIS tool, never a new agent and a delete. Passing `tools` REPLACES the ' +
      'grant, and if that widens it the owner is shown what was added and what those tools reach. ' +
      '`default: true` records this agent as the installation\'s default, which takes it off whoever ' +
      'held it — one record, and no agent file is rewritten for it. You may propose changes to your own file, and the owner is told plainly when you do. ' +
      CONDUCT,
    tier: 'gated',
    input: updateInput,
    describe(input, ctx) {
      const binding = resolved(registry);
      return describing(
        (i: UpdateInput) =>
          buildUpdateEnvelope(i, { binding, registry, proposedBy: ctx.agentId ?? 'unknown' }),
        (envelope) => renderUpdatePreview(envelope, specsFor(registry)),
      )(input);
    },
    async execute(input, ctx) {
      const binding = resolved(registry);
      const envelope = buildUpdateEnvelope(input, {
        binding,
        registry,
        proposedBy: ctx.agentId ?? 'unknown',
      });
      assertApprovedEffect(ctx, envelope);
      const dir = path.dirname(envelope.file);
      writeFilesAtomic([
        { path: envelope.file, content: envelope.content },
        ...(envelope.delegatesAfter.join(',') === envelope.delegatesBefore.join(',')
          ? []
          : [
              {
                path: path.join(dir, DELEGATES_FILE),
                content: `${JSON.stringify(envelope.delegatesAfter, null, 2)}\n`,
              },
            ]),
      ]);
      // The record before the reload: the catalog is rebuilt against the
      // choice that is now on the installation, not the one it replaced.
      if (envelope.becomesDefault) await binding.setDefaultAgent?.(envelope.id);
      const reload = reloadResult(binding);
      const assigned = await assignAccount(binding, envelope.id, envelope.account);
      return {
        ok: true,
        id: envelope.id,
        file: envelope.file,
        tools: envelope.toolsAfter,
        added: envelope.added,
        removed: envelope.removed,
        handle: envelope.handleAfter,
        ...(envelope.becomesDefault ? { isDefault: true } : {}),
        live: reload.reloaded,
        message:
          `@${envelope.handleAfter} updated. ` +
          `${envelope.becomesDefault ? `It is the default agent now${envelope.defaultFrom ? `, and ${envelope.defaultFrom.id} is not` : ''}. ` : ''}` +
          `${reload.message}${assigned}`,
      };
    },
  };

  const writeSkill: ToolDefinition<SkillInput, unknown> = {
    name: 'platform.write_skill',
    description:
      'Write a skill: a procedure composed into an agent\'s prompt — how to do something, step by step, ' +
      'in the words the agent will read at the moment it matters. A persona says who an agent is; a skill ' +
      'says how it works, and an agent created without one is half an agent. A skill grants no tool and ' +
      'lowers no tier. Set provenance to "agent" when you wrote it. ' +
      CONDUCT,
    tier: 'gated',
    input: skillInput,
    describe(input, ctx) {
      const binding = resolved(registry);
      return describing(
        (i: SkillInput) => buildSkillEnvelope(i, { binding, proposedBy: ctx.agentId ?? 'unknown' }),
        renderSkillPreview,
      )(input);
    },
    async execute(input, ctx) {
      const binding = resolved(registry);
      const envelope = buildSkillEnvelope(input, { binding, proposedBy: ctx.agentId ?? 'unknown' });
      assertApprovedEffect(ctx, envelope);
      writeFilesAtomic([{ path: envelope.file, content: envelope.content }]);
      const reload = reloadResult(binding);
      return {
        ok: true,
        name: envelope.name,
        file: envelope.file,
        scope: envelope.scope,
        live: reload.reloaded,
        message: `The ${envelope.name} skill is written. ${reload.message}`,
      };
    },
  };

  const pluginAgents: ToolDefinition<Record<string, never>, unknown> = {
    name: 'platform.plugin_agents',
    description:
      'Every agent the installed plugins PROPOSE, and every shared skill they propose — what each one ' +
      'is for, the exact tool grant it asks for, and whether the owner has accepted it yet. A plugin ' +
      'ships tools; the agent that knows how to use them is an offer, and nothing exists until the ' +
      'owner approves it. Read this before you offer one, and never describe a proposal you have not read.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, _ctx) {
      const binding = resolved(registry);
      const installedTools = new Set(registry.list().map((t) => t.name));
      return {
        agents: pluginAgentProposals(registry).map((proposal) => {
          const dir = path.join(binding.agentsDir, proposal.agent.id);
          const drift = driftFor({
            agentDir: dir,
            agentFile: path.join(dir, AGENT_FILE),
            suggestion: proposal.agent,
            pluginVersion: proposal.pluginVersion,
          });
          return {
            plugin: proposal.plugin,
            pluginVersion: proposal.pluginVersion,
            id: proposal.agent.id,
            handle: proposal.agent.handle,
            name: proposal.agent.name,
            description: proposal.agent.description,
            proposedTools: proposal.agent.tools,
            roles: proposal.agent.roles ?? [],
            skills: (proposal.agent.skills ?? []).map((s) => s.name),
            accepted: drift.state !== 'not-accepted',
            status: drift.state,
            note: drift.message,
            // A proposal naming a tool this installation does not have is
            // refused at accept time; say so here rather than there.
            missingTools: proposal.agent.tools.filter(
              (name) => !name.endsWith('.*') && !installedTools.has(name),
            ),
          };
        }),
        skills: pluginSkillProposals(registry).map((p) => ({
          plugin: p.plugin,
          pluginVersion: p.pluginVersion,
          name: p.skill.name,
          description: p.skill.description,
        })),
      };
    },
  };

  const acceptPluginAgent: ToolDefinition<AcceptAgentInput, unknown> = {
    name: 'platform.accept_plugin_agent',
    description:
      'Accept an agent one of the installed plugins proposes: it is created in the owner\'s own private ' +
      'directory, with the grant the plugin asked for. This needs the owner\'s approval, and what they ' +
      'are approving is ACCESS — the plugin wrote the proposal, but the owner grants the tools, and they ' +
      'see exactly what those tools reach before saying yes. The file becomes theirs: upgrading the ' +
      'plugin never rewrites it. ' +
      CONDUCT,
    tier: 'gated',
    input: acceptAgentInput,
    describe(input, ctx) {
      const binding = resolved(registry);
      return describing(
        (i: AcceptAgentInput) =>
          buildAcceptAgentEnvelope(i, { binding, registry, proposedBy: ctx.agentId ?? 'unknown' }),
        (envelope) => renderAcceptAgentPreview(envelope, specsFor(registry)),
      )(input);
    },
    async execute(input, ctx) {
      const binding = resolved(registry);
      const envelope = buildAcceptAgentEnvelope(input, {
        binding,
        registry,
        proposedBy: ctx.agentId ?? 'unknown',
      });
      const dir = path.dirname(envelope.file);
      assertApprovedEffect(ctx, envelope);
      createAgentDirAtomic(dir, {
        [AGENT_FILE]: envelope.content,
        // The sidecar that makes an upgrade honest: which plugin proposed this,
        // which version, and hashes of the proposal and of the file as written.
        // It records provenance and authorizes nothing.
        [PROVENANCE_FILE]: composeProvenance({
          plugin: envelope.fromPlugin.name,
          version: envelope.fromPlugin.version,
          agent: envelope.id,
          acceptedAt: ctx.now(),
          proposal: envelope.proposalChecksum,
          file: envelope.content,
        }),
        ...Object.fromEntries(
          envelope.skills.map((skill) => [path.join(SKILLS_DIR, `${skill.name}.md`), skill.content]),
        ),
      });
      const reload = reloadResult(binding);
      return {
        ok: true,
        id: envelope.id,
        handle: envelope.handle,
        file: envelope.file,
        tools: envelope.tools,
        fromPlugin: envelope.fromPlugin,
        skills: envelope.skills.map((s) => s.name),
        live: reload.reloaded,
        message:
          `@${envelope.handle} exists, and it is the owner's file now — ${envelope.fromPlugin.name} cannot ` +
          `change it. ${reload.message}`,
      };
    },
  };

  const acceptPluginSkill: ToolDefinition<AcceptSkillInput, unknown> = {
    name: 'platform.accept_plugin_skill',
    description:
      'Accept a shared skill one of the installed plugins proposes: a procedure composed into every ' +
      'agent\'s prompt. It grants no tool and lowers no tier. Needs the owner\'s approval, and the whole ' +
      'procedure is in the preview. ' +
      CONDUCT,
    tier: 'gated',
    input: acceptSkillInput,
    describe(input, ctx) {
      const binding = resolved(registry);
      return describing(
        (i: AcceptSkillInput) =>
          buildAcceptSkillEnvelope(i, { binding, registry, proposedBy: ctx.agentId ?? 'unknown' }),
        (envelope) =>
          [
            `The ${envelope.fromPlugin.name} plugin (${envelope.fromPlugin.version}) proposes a shared skill.`,
            '',
            renderSkillPreview(envelope),
          ].join('\n'),
      )(input);
    },
    async execute(input, ctx) {
      const binding = resolved(registry);
      const envelope = buildAcceptSkillEnvelope(input, {
        binding,
        registry,
        proposedBy: ctx.agentId ?? 'unknown',
      });
      assertApprovedEffect(ctx, envelope);
      writeFilesAtomic([{ path: envelope.file, content: envelope.content }]);
      const reload = reloadResult(binding);
      return {
        ok: true,
        name: envelope.name,
        file: envelope.file,
        fromPlugin: envelope.fromPlugin,
        live: reload.reloaded,
        message: `The ${envelope.name} skill is written, and it is the owner's file now. ${reload.message}`,
      };
    },
  };

  const deleteAgent: ToolDefinition<z.infer<typeof deleteInput>, unknown> = {
    name: 'platform.delete_agent',
    description:
      'Remove one of the owner\'s own agents. Nothing is destroyed: the whole directory is moved into a ' +
      'trash folder beside the others, and the answer says exactly where it went so it can be put back. ' +
      'The default agent cannot be removed, and a shipped example is never touched. ' +
      CONDUCT,
    tier: 'gated',
    input: deleteInput,
    describe(input, ctx) {
      const binding = resolved(registry);
      return describing(
        (i: z.infer<typeof deleteInput>) =>
          buildDeleteEnvelope(i, { binding, proposedBy: ctx.agentId ?? 'unknown' }),
        renderDeletePreview,
      )(input);
    },
    async execute(input, ctx) {
      const binding = resolved(registry);
      const envelope = buildDeleteEnvelope(input, { binding, proposedBy: ctx.agentId ?? 'unknown' });
      assertApprovedEffect(ctx, envelope);
      const movedTo = moveAgentAside(envelope.directory, binding.trashRoot, trashStamp(ctx.now()));
      const reload = reloadResult(binding);
      return {
        ok: true,
        id: envelope.id,
        movedTo,
        live: reload.reloaded,
        message:
          `@${envelope.handle} is gone from the catalog. Its files were not deleted — they are at ` +
          `${movedTo}, and moving that directory back restores the agent. ${reload.message}`,
      };
    },
  };

  return {
    name: PLATFORM_PLUGIN,
    version: '0.1.0',
    // It owns no tables: agents are files, and the only durable record of a
    // change is the action ledger core already writes.
    schema: 'core',
    migrationsDir: '',
    tools: [
      listGroups,
      createGroup,
      updateGroupTool,
      archiveGroupTool,
      listAccounts,
      listAgents,
      installedTools,
      readAgent,
      listSkills,
      pluginAgents,
      createAgent,
      updateAgent,
      writeSkill,
      deleteAgent,
      acceptPluginAgent,
      acceptPluginSkill,
    ],
  };
}
