/**
 * The dashboard's engine controls.
 *
 * `POST /api/agents/:id/engine` calls the very function `buddi agents set`
 * calls — `updateAgentFrontmatter` in core — so there is one implementation of
 * "change which engine an agent runs on", one set of validation rules, and one
 * place for the refusal to live. The dashboard is a surface: it establishes who
 * is asking (session, CSRF, Origin, upstream in `server.ts`), and then asks
 * core, exactly like every other write here.
 *
 * Two things this endpoint is careful about:
 *
 *  - It re-reads the agent file it just wrote rather than reporting what it
 *    intended to write, and it recomputes availability from the *current*
 *    environment. The answer is the state of the world, not an echo.
 *  - A reloadable service swaps its catalog before reporting success, so new
 *    runs on every surface see the edit. Active runs retain their old objects.
 *    Non-reloadable callers still explicitly report a required restart.
 */
import { readFileSync } from 'node:fs';
import {
  AgentEditError,
  DEFAULT_MAX_TURNS,
  RESTART_NOTE,
  enginePatch,
  modelCatalogue,
  parseAgentFile,
  providerFromEnv,
  resolveProvider,
  updateAgentFrontmatter,
  PROVIDER_KINDS,
  type AgentCatalog,
  type CatalogAgent,
  type EnginePatch,
  type ProviderKind,
  type ProviderModels,
} from '@buddi/core';

export type EngineWriteResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: { error: string; detail?: unknown } };

const LANGUAGES = ['mirror', 'en', 'fr'] as const;

/** One agent's engine, as the page renders it. Never a credential *value*. */
export interface AgentEngineView {
  id: string;
  handle: string;
  name: string;
  isDefault: boolean;
  provider: ProviderKind;
  model: string;
  maxTurns: number;
  language: string;
  /** Reasoning before the answer: on, off, or null for the model's default. */
  thinking: 'on' | 'off' | null;
  credentialKind: string;
  credentialEnv: string;
  available: boolean;
  unavailableReason?: string;
  /** True while the running surfaces still hold an older catalog. */
  restartRequired: boolean;
}

/**
 * The engine of every installed agent, read from the *files* rather than from
 * the catalog the server booted with — so a change made a second ago is what
 * the page shows, and `restartRequired` is the honest difference between the
 * two.
 */
export function readAgentEngines(
  catalog: AgentCatalog,
  env: NodeJS.ProcessEnv,
): AgentEngineView[] {
  return catalog.list().flatMap((summary) => {
    const agent = catalog.get(summary.id);
    return agent ? [engineView(agent, env)] : [];
  });
}

/** What the page needs to offer a choice: the catalogue, per provider. */
export function readEngineOptions(env: NodeJS.ProcessEnv): ProviderModels[] {
  return modelCatalogue(env);
}

/**
 * One agent's engine as it stands on disk right now.
 *
 * The catalog entry is the fallback: if the file has since been edited (by
 * this endpoint, or by hand) the file wins, and `restartRequired` records that
 * the loaded catalog and the file no longer agree.
 */
/** The file wins over the loaded catalog, as for every other engine key. */
function thinkingOnDisk(agent: CatalogAgent): 'on' | 'off' | null {
  try {
    return parseAgentFile(readFileSync(agent.file, 'utf8'), { file: agent.file }).frontmatter.thinking ?? null;
  } catch {
    return agent.thinking ?? null;
  }
}

function engineView(agent: CatalogAgent, env: NodeJS.ProcessEnv): AgentEngineView {
  if (agent.provider.accountId !== undefined) return {
    id: agent.id, handle: agent.handle, name: agent.name, isDefault: agent.isDefault,
    provider: agent.provider.kind, model: agent.model, maxTurns: agent.maxTurns, language: agent.language,
    thinking: thinkingOnDisk(agent),
    credentialKind: agent.provider.credential.kind, credentialEnv: agent.provider.accountId || 'No account selected',
    available: agent.available, unavailableReason: agent.unavailableReason, restartRequired: false,
  };
  let provider = agent.provider.kind;
  let model = agent.model;
  let maxTurns = agent.maxTurns;
  let language: string = agent.language;
  let credentialEnv = agent.provider.credential.env;
  let credentialKind: string = agent.provider.credential.kind;
  let restartRequired = false;

  try {
    const onDisk = parseAgentFile(readFileSync(agent.file, 'utf8'), { file: agent.file }).frontmatter;
    const ref = providerFromEnv(env, onDisk.model, onDisk.provider);
    restartRequired =
      ref.kind !== agent.provider.kind ||
      ref.model !== agent.provider.model ||
      (onDisk.maxTurns ?? DEFAULT_MAX_TURNS) !== agent.maxTurns ||
      (onDisk.language ?? 'mirror') !== agent.language;
    provider = ref.kind;
    model = ref.model;
    maxTurns = onDisk.maxTurns ?? DEFAULT_MAX_TURNS;
    language = onDisk.language ?? 'mirror';
    credentialEnv = ref.credential.env;
    credentialKind = ref.credential.kind;
  } catch {
    // An unreadable file is the loaded catalog's problem to report, not this
    // view's to crash on: fall back to what the catalog already knows.
  }

  const ref = providerFromEnv(env, model, provider);
  const resolution = resolveProvider(ref, env);

  return {
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    isDefault: agent.isDefault,
    provider,
    model,
    maxTurns,
    language,
    thinking: thinkingOnDisk(agent),
    credentialKind,
    credentialEnv,
    available: resolution.ok,
    ...(resolution.ok ? {} : { unavailableReason: resolution.problem.message }),
    restartRequired,
  };
}

/** Read an `EnginePatch` out of a JSON body. Anything else is a 400. */
export function engineChangeFromBody(body: Record<string, unknown>): EnginePatch | string {
  const change: EnginePatch = {};

  if (body.provider !== undefined && body.provider !== null) {
    if (
      typeof body.provider !== 'string' ||
      !(PROVIDER_KINDS as readonly string[]).includes(body.provider)
    ) {
      return `\`provider\` must be one of: ${PROVIDER_KINDS.join(', ')}`;
    }
    change.provider = body.provider as ProviderKind;
  }
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      return '`model` must be a non-empty model id';
    }
    change.model = body.model.trim();
  }
  if (body.maxTurns !== undefined && body.maxTurns !== null) {
    if (typeof body.maxTurns !== 'number' || !Number.isInteger(body.maxTurns) || body.maxTurns < 1) {
      return '`maxTurns` must be a positive integer';
    }
    change.maxTurns = body.maxTurns;
  }
  if (body.language !== undefined && body.language !== null) {
    if (typeof body.language !== 'string' || !(LANGUAGES as readonly string[]).includes(body.language)) {
      return `\`language\` must be one of: ${LANGUAGES.join(', ')}`;
    }
    change.language = body.language as EnginePatch['language'];
  }
  // `null` is a value here: it removes the key, back to the model's default.
  if (body.thinking !== undefined) {
    if (body.thinking !== null && body.thinking !== 'on' && body.thinking !== 'off') {
      return '`thinking` must be "on", "off" or null';
    }
    change.thinking = body.thinking;
  }

  if (Object.keys(change).length === 0) {
    return 'nothing to change (send provider, model, maxTurns, language or thinking)';
  }
  return change;
}

export interface SetEngineResult {
  agent: AgentEngineView;
  /** Which keys actually moved. Empty when the file already said this. */
  changed: string[];
  /** The one sentence about the running surfaces. Always present. */
  note: string;
}

/**
 * Change one agent's engine from the dashboard.
 *
 * Identical in effect to `buddi agents set`, because it is the same call. A
 * refusal — a model the pinned provider does not serve, most often — comes back
 * as a 400 carrying the catalogue's own sentence, which is the sentence the CLI
 * prints and the sentence the loader would have used.
 */
export function setAgentEngineFromWeb(
  deps: { catalog: AgentCatalog; env: NodeJS.ProcessEnv },
  agentId: string,
  change: EnginePatch,
): EngineWriteResult<SetEngineResult> {
  const agent = deps.catalog.get(agentId) ?? deps.catalog.byHandle(agentId);
  if (!agent) return { ok: false, status: 404, body: { error: `no such agent: ${agentId}` } };

  try {
    const edit = updateAgentFrontmatter(agent.file, enginePatch(change));
    const reload = (deps.catalog as AgentCatalog & { reload?: () => void }).reload;
    if (reload) reload.call(deps.catalog);
    return {
      ok: true,
      status: 200,
      body: {
        agent: engineView(deps.catalog.get(agent.id) ?? agent, deps.env),
        changed: edit.changed,
        note: reload ? 'Applies to new runs; active runs keep their current settings' : RESTART_NOTE,
      },
    };
  } catch (err) {
    if (err instanceof AgentEditError) {
      // 400 for "you asked for something that is not allowed"; 409 when the
      // file on disk is the problem rather than the request.
      const status = err.code === 'unreadable' ? 409 : 400;
      return { ok: false, status, body: { error: err.message, detail: { code: err.code } } };
    }
    return {
      ok: false,
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
