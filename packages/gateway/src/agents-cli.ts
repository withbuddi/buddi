/**
 * `buddi agents` — seeing and changing which engine each agent runs on.
 *
 * Provider choice is per agent because an endpoint is a data destination: this
 * file is what makes that choice *visible* and *changeable* without opening a
 * text editor, and it changes it by writing the agent file — the same file the
 * loader reads, no second source of truth, no database column shadowing a
 * document.
 *
 * Five commands, each answering one question an operator actually has:
 *
 *   (bare)  what is installed, and can it run here?
 *   show    everything about one agent, wiring included
 *   set     change the engine, refusing anything the catalogue would refuse
 *   models  what could I pin, and which providers can this machine reach?
 *   test    does the swap actually work — one cheap live turn
 *
 * Only `test` spends money, and only `set` writes. Everything else reads files.
 * Nothing here runs inside `buddi serve`: a change made here reaches the
 * running surfaces at the next `buddi service restart`, and every path that
 * writes says so.
 */
import {
  AgentEditError,
  DEFAULT_MAX_TURNS,
  RESTART_NOTE,
  createPool,
  enginePatch,
  modelCatalogue,
  resolveProvider,
  updateAgentFrontmatter,
  UnknownAgentError,
  PROVIDER_KINDS,
  type CatalogAgent,
  type EnginePatch,
  type ProviderKind,
  type ProviderModels,
} from '@buddi/core';
import { createProvider, providerCapabilities } from '@buddi/runtime';
import { gatewayCatalog, AGENTS_DIR, agentSearchPath, REPO_ROOT } from './agents/catalog.js';
import { migrateAgents, renderMigration } from './agents/migrate.js';
import { createWiringAsync, hydrateSecrets, loadEnvironment, type Wiring } from './bootstrap.js';
import { estimateCost, formatCost, formatTokens, formatWebSearches } from './chat/usage.js';
import { bold, dim, styleFor, type TerminalStyle } from './chat/terminal.js';

export const USAGE = `buddi agents — which engine each agent runs on

  buddi agents                       every agent: provider, model, credential, availability
  buddi agents show <handle>         one agent in full, wiring and last run included
  buddi agents set <handle> [options]
      --account <id>                named account (from dashboard Providers)
      --provider anthropic|openai    where this agent's conversations go
      --model <id>                   validated against that provider's catalogue
      --max-turns <n>                turn budget for one run
      --language mirror|en|fr        which language it answers in
  buddi agents models [--provider p] what this build knows, and what you can reach
  buddi agents test <handle> [--prompt "..."]   one cheap live turn
  buddi agents migrate [--dry-run]   move agents/ and skills/ out of the repository
                                     and into your private directory (never committed)

A change to an agent file is picked up by the next CLI run immediately; the
running service keeps the catalog it loaded, so run \`buddi service restart\`.`;

/** The default prompt for `test`: the cheapest turn that still proves the wire. */
export const TEST_PROMPT = 'Reply with the single word: ok';

export const LANGUAGES = ['mirror', 'en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];

export type AgentsCommand =
  | { action: 'help' }
  | { action: 'list' }
  | { action: 'show'; handle: string }
  | { action: 'set'; handle: string; change: EnginePatch & { accountId?: string } }
  | { action: 'models'; provider?: ProviderKind }
  | { action: 'test'; handle: string; prompt: string }
  | { action: 'migrate'; dryRun: boolean };

/* ------------------------------------------------------------------ *
 * Parsing — pure, and the part worth a unit test
 * ------------------------------------------------------------------ */

function providerValue(raw: string | undefined, flag: string): ProviderKind {
  if (raw === undefined) throw new Error(`${flag} needs a provider name`);
  if (!(PROVIDER_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`unknown provider: ${raw} (expected ${PROVIDER_KINDS.join(' or ')})`);
  }
  return raw as ProviderKind;
}

export function parseAgentsArgs(argv: string[]): AgentsCommand {
  const [head, ...rest] = argv;

  if (head === 'help' || head === '--help' || head === '-h') return { action: 'help' };
  if (head === undefined) return { action: 'list' };

  if (head === 'migrate') {
    let dryRun = false;
    for (const arg of rest) {
      if (arg === '--dry-run' || arg === '-n') {
        dryRun = true;
        continue;
      }
      throw new Error(`unknown option for buddi agents migrate: ${arg}`);
    }
    return { action: 'migrate', dryRun };
  }

  if (head === 'models') {
    const command: { action: 'models'; provider?: ProviderKind } = { action: 'models' };
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] as string;
      if (arg === '--provider' || arg === '-p') {
        command.provider = providerValue(rest[i + 1], arg);
        i += 1;
        continue;
      }
      throw new Error(`unknown option for buddi agents models: ${arg}`);
    }
    return command;
  }

  if (head === 'show' || head === 'set' || head === 'test') {
    const handle = rest[0];
    if (handle === undefined || handle.startsWith('-')) {
      throw new Error(`buddi agents ${head} needs an agent handle or id`);
    }
    const args = rest.slice(1);

    if (head === 'show') {
      if (args.length > 0) throw new Error(`unexpected argument: ${args[0]}`);
      return { action: 'show', handle };
    }

    if (head === 'test') {
      let prompt = TEST_PROMPT;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] as string;
        if (arg === '--prompt') {
          const value = args[i + 1];
          if (value === undefined) throw new Error('--prompt needs a question');
          prompt = value;
          i += 1;
          continue;
        }
        throw new Error(`unknown option for buddi agents test: ${arg}`);
      }
      return { action: 'test', handle, prompt };
    }

    const change: EnginePatch & { accountId?: string } = {};
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      const value = args[i + 1];
      if (arg === '--account') {
        if (!value?.trim()) throw new Error('--account needs an account id');
        change.accountId = value.trim(); i += 1; continue;
      }
      if (arg === '--provider') {
        change.provider = providerValue(value, arg);
        i += 1;
        continue;
      }
      if (arg === '--model') {
        if (value === undefined || value.trim() === '') throw new Error('--model needs a model id');
        change.model = value.trim();
        i += 1;
        continue;
      }
      if (arg === '--max-turns') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error('--max-turns needs a positive integer');
        }
        change.maxTurns = n;
        i += 1;
        continue;
      }
      if (arg === '--language') {
        if (value === undefined || !(LANGUAGES as readonly string[]).includes(value)) {
          throw new Error(`--language needs one of: ${LANGUAGES.join(', ')}`);
        }
        change.language = value as Language;
        i += 1;
        continue;
      }
      throw new Error(`unknown option for buddi agents set: ${arg}`);
    }
    if (Object.keys(change).length === 0) {
      throw new Error(
        'buddi agents set needs something to change (--provider, --model, --max-turns, --language)',
      );
    }
    return { action: 'set', handle, change };
  }

  if (head.startsWith('-')) throw new Error(`unknown option for buddi agents: ${head}`);
  throw new Error(`unknown agents command: ${head} (run "buddi agents help")`);
}

/* ------------------------------------------------------------------ *
 * Rendering — also pure, so the listing is testable without a catalog
 * ------------------------------------------------------------------ */

/** Roles are another change's key; read defensively so neither half blocks the other. */
export function rolesOf(agent: { roles?: readonly string[] }): readonly string[] {
  return Array.isArray(agent.roles) ? agent.roles : [];
}

export interface AgentLine {
  handle: string;
  id: string;
  isDefault: boolean;
  provider: string;
  model: string;
  credential: string;
  available: boolean;
  unavailableReason?: string | undefined;
  roles: readonly string[];
  /** `example` (shipped with the repo) or `private` (the owner's own). */
  source: string;
}

/** One agent as the listing's row, without any styling. */
export function agentLine(agent: CatalogAgent): AgentLine {
  return {
    handle: agent.handle,
    id: agent.id,
    isDefault: agent.isDefault,
    provider: agent.provider.kind,
    model: agent.model,
    credential: agent.provider.accountId !== undefined
      ? `account ${agent.provider.accountId || '(not selected)'}`
      : `${agent.provider.credential.kind} from ${agent.provider.credential.env}`,
    available: agent.availability.ok,
    ...(agent.availability.ok ? {} : { unavailableReason: agent.availability.problem.message }),
    roles: rolesOf(agent as { roles?: readonly string[] }),
    // Defensive like `roles`: a catalog built before the search path landed
    // simply reports `private`, which is what a single directory always was.
    source: (agent as { source?: string }).source ?? 'private',
  };
}

/**
 * The listing, as text. Columns are padded to the widest cell rather than to a
 * fixed width: four agents with short handles should not be printed in a table
 * sized for twenty.
 */
export function renderAgentLines(lines: readonly AgentLine[], style?: TerminalStyle): string {
  if (lines.length === 0) return 'No agents are installed.';
  const color = style?.color ?? false;
  const w = (pick: (l: AgentLine) => string): number =>
    Math.max(...lines.map((l) => pick(l).length));
  const handleWidth = w((l) => `@${l.handle}`);
  const idWidth = w((l) => l.id);
  const providerWidth = w((l) => l.provider);
  const modelWidth = w((l) => l.model);

  const out: string[] = [];
  for (const line of lines) {
    const head = [
      bold(`@${line.handle}`.padEnd(handleWidth), color),
      dim(line.id.padEnd(idWidth), color),
      line.provider.padEnd(providerWidth),
      line.model.padEnd(modelWidth),
      dim(line.credential, color),
    ].join('  ');
    out.push(`${head}${line.isDefault ? dim('  (default)', color) : ''}`);
    const notes: string[] = [line.source];
    if (line.roles.length > 0) notes.push(`roles: ${line.roles.join(', ')}`);
    if (!line.available) notes.push(`unavailable: ${line.unavailableReason}`);
    else notes.push('available');
    out.push(dim(`  ${notes.join(' · ')}`, color));
  }
  return out.join('\n');
}

/** `buddi agents models`, as text. */
export function renderModelCatalogue(groups: readonly ProviderModels[]): string {
  const out: string[] = [];
  for (const group of groups) {
    out.push(
      `${group.kind} — ${
        group.usable
          ? `usable (${group.credentialKind} from ${group.credentialEnv})`
          : `unusable: ${group.problem?.message ?? 'no credential'}`
      }`,
    );
    out.push(
      `  default: ${group.defaultModel} (${group.defaultFrom}; override with ${group.defaultEnv})`,
    );
    for (const model of group.models) {
      out.push(`    ${model.id.padEnd(20)} ${model.note}`);
    }
    out.push(
      `  any model named ${group.prefixes.map((p) => `${p}…`).join(', ')} is accepted for ${group.kind};`,
    );
    out.push('  a name belonging to the other provider never is.');
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** The before/after line `set` prints. One line per key that moved. */
export function renderChange(
  handle: string,
  changed: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  if (changed.length === 0) return `@${handle} already reads exactly that; nothing was written.`;
  return changed
    .map((key) => `@${handle} ${key}: ${String(before[key] ?? '(unset)')} → ${String(after[key] ?? '(unset)')}`)
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * The commands
 * ------------------------------------------------------------------ */

function catalogFor(env: NodeJS.ProcessEnv) {
  return gatewayCatalog(env);
}

function resolveOrExit(env: NodeJS.ProcessEnv, handle: string): CatalogAgent {
  try {
    return catalogFor(env).resolve(handle);
  } catch (err) {
    if (err instanceof UnknownAgentError) {
      console.error(err.message);
      console.error(`agents live in ${AGENTS_DIR}; run "buddi agents" to list them`);
      process.exit(1);
    }
    throw err;
  }
}

function listCommand(env: NodeJS.ProcessEnv, style: TerminalStyle): void {
  const catalog = catalogFor(env);
  const lines = catalog
    .list()
    .flatMap((summary) => {
      const agent = catalog.get(summary.id);
      return agent ? [agentLine(agent)] : [];
    });
  console.log(renderAgentLines(lines, style));
}

/**
 * The last run this agent finished, from the event log.
 *
 * Best effort by design: the listing and `show` must work with the database
 * down (an agent file is a file), so a missing or unreachable database costs
 * one line of the report rather than the command.
 */
async function lastRunSnapshot(
  env: NodeJS.ProcessEnv,
  agentId: string,
): Promise<string | undefined> {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === '') return undefined;
  const pool = createPool(url);
  try {
    const { rows } = await pool.query(
      `select e.payload, e.created_at
         from core.events e
         join core.conversations c on c.id = e.conversation_id
        where e.kind = 'run.finished' and c.agent_id = $1
        order by e.created_at desc
        limit 1`,
      [agentId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const usage = (p.usage ?? {}) as { input?: number; output?: number; webSearches?: number };
    const served = p.servedModel ? ` (served ${String(p.servedModel)})` : '';
    return (
      `${new Date(row.created_at).toISOString()} — ${String(p.provider ?? '?')} · ` +
      `${String(p.model ?? '?')}${served} · ${String(p.credentialKind ?? '?')} · ` +
      `${String(p.turns ?? '?')} turns, ${String(p.stopped ?? '?')}, ` +
      `in ${usage.input ?? 0} / out ${usage.output ?? 0}` +
      `${usage.webSearches ? `, ${usage.webSearches} provider web search${usage.webSearches === 1 ? '' : 'es'}` : ''}`
    );
  } catch {
    return undefined;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function showCommand(
  env: NodeJS.ProcessEnv,
  style: TerminalStyle,
  handle: string,
): Promise<void> {
  const agent = resolveOrExit(env, handle);
  const caps = providerCapabilities(agent.provider.kind);
  const roles = rolesOf(agent as { roles?: readonly string[] });
  const out = (label: string, value: string): void => {
    console.log(`  ${dim(label.padEnd(14), style.color)}${value}`);
  };

  console.log(
    `${bold(`@${agent.handle}`, style.color)} ${dim(agent.id, style.color)}${
      agent.isDefault ? dim(' (default)', style.color) : ''
    } — ${agent.name}`,
  );
  console.log(`  ${agent.description}\n`);
  out('source', (agent as { source?: string }).source ?? 'private');
  out('persona', agent.file);
  out('provider', agent.provider.kind);
  out('model', agent.model);
  if (agent.provider.accountId !== undefined) out('account', agent.provider.accountId || '(not selected)');
  out('credential', `${agent.provider.credential.kind} from ${agent.provider.credential.env}`);
  out(
    'availability',
    agent.availability.ok
      ? 'available'
      : `unavailable [${agent.availability.problem.code}]: ${agent.availability.problem.message}`,
  );
  out('max turns', String(agent.maxTurns));
  out('language', agent.language);
  out('roles', roles.length > 0 ? roles.join(', ') : '(none)');
  out('tools', agent.tools.length > 0 ? agent.tools.join(', ') : '(none)');
  out(
    'skills',
    agent.skills.length > 0
      ? agent.skills.map((s) => `${s.name} (${s.provenance})`).join(', ')
      : '(none)',
  );

  console.log(`\n  ${dim('capabilities', style.color)}`);
  const rows: Array<[string, string]> = [
    ['images', caps.multimodalImage ? 'yes' : 'no'],
    ['documents', caps.document ? 'yes' : 'no'],
    ['parallel tool calls', caps.parallelToolCalls ? 'yes' : 'no'],
    ['streaming tool args', caps.streamingToolArgs ? 'yes' : 'no'],
    ['cancellation', caps.cancellation ? 'yes' : 'no'],
    ['usage reporting', caps.usageReporting ? 'yes' : 'no'],
    // What "granted web.*" actually resolves to for this agent: its own
    // server-side search, or the plugin's web.search through a search company.
    ['server-side web search', caps.nativeWebSearch ? 'yes' : 'no'],
    ['tool results', caps.toolResultOrdering],
  ];
  for (const [name, value] of rows) console.log(`    ${name.padEnd(22)} ${value}`);

  const snapshot = await lastRunSnapshot(env, agent.id);
  console.log(`\n  ${dim('last run', style.color)}`);
  console.log(`    ${snapshot ?? 'no run recorded for this agent yet'}`);
}

/**
 * The edit itself, separated from resolving the agent so it can be tested
 * against a temporary file. `out` and `err` are injected for the same reason.
 */
export function setEngine(
  agent: { handle: string; file: string },
  change: EnginePatch,
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    color?: boolean;
  },
): number {
  const color = io.color ?? false;
  let edit;
  try {
    edit = updateAgentFrontmatter(agent.file, enginePatch(change));
  } catch (error) {
    // The catalogue's own sentence, quoted rather than paraphrased: the CLI, the
    // dashboard and the loader all refuse a cross-provider model in one voice.
    io.err(error instanceof AgentEditError ? error.message : String(error));
    if (error instanceof AgentEditError && error.code === 'model-mismatch') {
      io.err('Pin the matching provider too: buddi agents set … --provider <p> --model <m>');
    }
    return 1;
  }

  // `maxTurns` unset means the built-in budget; say the number, not "(unset)".
  const shown = (frontmatter: Record<string, unknown>): Record<string, unknown> => ({
    ...frontmatter,
    provider: frontmatter.provider ?? 'anthropic',
    maxTurns: frontmatter.maxTurns ?? DEFAULT_MAX_TURNS,
    language: frontmatter.language ?? 'mirror',
  });
  io.out(
    renderChange(
      agent.handle,
      edit.changed,
      shown(edit.before as unknown as Record<string, unknown>),
      shown(edit.after as unknown as Record<string, unknown>),
    ),
  );
  if (!edit.written) return 0;
  io.out(dim(`  ${agent.file}`, color));
  io.out(dim(`  ${RESTART_NOTE}`, color));
  io.out(dim(`  check it with: buddi agents test ${agent.handle}`, color));
  return 0;
}

function setCommand(
  env: NodeJS.ProcessEnv,
  style: TerminalStyle,
  handle: string,
  change: EnginePatch,
): number {
  const agent = resolveOrExit(env, handle);
  return setEngine(agent, change, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    color: style.color,
  });
}

function modelsCommand(env: NodeJS.ProcessEnv, provider?: ProviderKind): void {
  console.log(renderModelCatalogue(modelCatalogue(env, provider)));
}

/**
 * One live turn against the agent's own provider.
 *
 * No tools, no database, no conversation row: this is the "does the swap work"
 * check, and it should cost a fraction of a cent and touch nothing durable. The
 * *served* model is the interesting line — it is the one that can differ from
 * the pin.
 */
async function testCommand(
  env: NodeJS.ProcessEnv,
  style: TerminalStyle,
  handle: string,
  prompt: string,
  wiring?: Wiring,
): Promise<number> {
  const agent = resolveOrExit(env, handle);
  const resolution = agent.provider.accountId !== undefined && wiring
    ? { ok: true as const, provider: { kind: agent.provider.kind, model: agent.model, credentialKind: agent.provider.credential.kind, baseUrl: `account:${agent.provider.accountId}` } }
    : resolveProvider(agent.provider, env);
  if (!resolution.ok) {
    console.error(
      `@${agent.handle} cannot run [${resolution.problem.code}]: ${resolution.problem.message}`,
    );
    console.error(
      agent.provider.kind === 'openai'
        ? 'Set OPENAI_API_KEY in .env (or the vault), or pin this agent to another provider.'
        : 'Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY.',
    );
    return 1;
  }

  const provider = wiring ? wiring.providerFor(agent) : createProvider(resolution.provider as import('@buddi/core').ResolvedProvider);
  console.log(
    dim(
      `@${agent.handle} → ${resolution.provider.kind} · ${resolution.provider.model} · ` +
        `${resolution.provider.credentialKind} · ${resolution.provider.baseUrl}`,
      style.color,
    ),
  );
  const started = Date.now();
  let answer;
  try {
    answer = await provider.complete({
      system: 'You are being checked for connectivity. Answer in as few words as possible.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      maxTokens: 64,
    });
  } catch (err) {
    console.error(`the call failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const ms = Date.now() - started;
  const text = answer.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  const cost = estimateCost(answer.model || resolution.provider.model, answer.usage);

  console.log(text === '' ? '(no text in the answer)' : text);
  console.log(
    dim(
      `  served ${answer.model || '(not reported)'} · ${ms} ms · ` +
        `in ${formatTokens(answer.usage.input)} / out ${formatTokens(answer.usage.output)} · ` +
        `${answer.usage.webSearches ? `${formatWebSearches(answer.usage.webSearches)} · ` : ''}` +
        `${cost === undefined ? 'cost unknown (no local price)' : `about ${formatCost(cost)}`}`,
      style.color,
    ),
  );
  return 0;
}

/**
 * `migrate` — the one command that moves files rather than reading them.
 *
 * It targets whatever the search path says the owner's directory *should* be,
 * which is `<repo>/private` unless `BUDDI_AGENTS_DIR` pins somewhere else. It
 * never touches `examples/`.
 */
function migrateCommand(env: NodeJS.ProcessEnv, dryRun: boolean): number {
  const search = agentSearchPath(env);
  const result = migrateAgents({
    repoRoot: REPO_ROOT,
    targetRoot: search.ownerRoot,
    ...(dryRun ? { dryRun: true } : {}),
  });
  console.log(renderMigration(result, dryRun));
  return 0;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * `buddi agents …`. `argv` is the slice *after* the command word.
 *
 * Account-aware commands use the same wiring as the serving process. The
 * database is authoritative for bindings; never silently fall back to files.
 */
export async function main(argv: string[] = process.argv.slice(3)): Promise<number> {
  let command: AgentsCommand;
  try {
    command = parseAgentsArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  await loadEnvironment();
  // Every command below reads a credential *name* and asks whether this
  // machine can supply it, so the vault has to answer first: after `buddi vault
  // import-env`, `.env` holds `<vault>` markers, and a listing that called
  // those a credential would report availability that is simply false.
  await hydrateSecrets(process.env);
  const style = styleFor(process.env, process.stdout);
  let wiring: Wiring | undefined;
  try {
    if (['list', 'show', 'set', 'test'].includes(command.action)) wiring = await createWiringAsync(process.env);
  switch (command.action) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'list':
      listCommand(process.env, style);
      return 0;
    case 'show':
      await showCommand(process.env, style, command.handle);
      return 0;
    case 'set':
      if (wiring?.providerAccounts) {
        const agent = wiring.catalog.resolve(command.handle);
        const { accountId, model, provider, ...fileChange } = command.change;
        if (provider) { console.error('Choose a named account with --account instead of --provider.'); return 1; }
        if (accountId || model) {
          const view = wiring.providerAccounts.view();
          const binding = view.bindings.find(b => b.agentId === agent.id);
          const id = accountId ?? binding?.accountId;
          const account = view.accounts.find(a => a.id === id);
          if (!account) { console.error('Choose a provider account in the dashboard or with --account.'); return 1; }
          await wiring.providerAccounts.assign(agent.id, { accountId: account.id, model: model ?? (accountId ? account.defaultModel : binding?.model) ?? account.defaultModel });
          console.log(`@${agent.handle} → ${account.label}. Restart other running processes to load this CLI change.`);
        }
        return Object.keys(fileChange).length ? setCommand(process.env, style, command.handle, fileChange) : 0;
      }
      return setCommand(process.env, style, command.handle, command.change);
    case 'models':
      modelsCommand(process.env, command.provider);
      return 0;
    case 'test':
      return await testCommand(process.env, style, command.handle, command.prompt, wiring);
    case 'migrate':
      return migrateCommand(process.env, command.dryRun);
  }
  } finally { await wiring?.pool.end(); }
  return 0;
}
