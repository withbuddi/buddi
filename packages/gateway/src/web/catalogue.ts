/**
 * The agent catalogue's routes (agent-catalogue.md §5): the list with where
 * each package stands here, what adding one would do, the install job that
 * stages a missing by-buddi plugin on the way, updates, and removing an agent.
 *
 * The owner's click is the approval, as on the Plugins page's "Create @mail"
 * (`acceptAgentRoute`): the route invokes the same gated
 * `platform.install_agent` (or `platform.delete_agent`) Agent Father invokes —
 * which records the action with the whole grant in its preview — and decides
 * it `approved` through the card's own decide in the same request. Only the
 * dashboard and `buddi agents add|update|remove` (through the same routes,
 * with the owner's session) call these.
 *
 * A missing plugin is installed only when it is a By-buddi listing whose
 * staged integrity matches exactly (first run's rule, `installListedPlugin`),
 * then loaded live and waited for. A plugin that fails stops the job before
 * the agent exists; its staged card waits in Settings → Plugins.
 */
import { randomUUID } from 'node:crypto';
import { OWNER_AGENT_ID, type ToolRegistry } from '@buddi/core';
import {
  addedAgents,
  installedAsFor,
  matchesPackage,
  CATALOGUE_OFFLINE,
  entryView,
  packageState,
  resolvePicks,
  stateContext,
  type CatalogueBinding,
  type CatalogueEntryView,
  type CatalogueService,
  type Drift,
  type FillChoices,
  type InstallAgentEnvelope,
  type MissingNeed,
  type MissingPlugin,
} from '../agents/platform-catalogue.js';
import type { AgentPackage } from '../agents/catalogue-package.js';
import { pluginAgentProposals, planCatalogueInstall } from '../agents/platform.js';
import { loadMarketIndex, type MarketDeps, type MarketEntry } from './market.js';
import type { PagesDeps } from './pages.js';
import type { RouteReply } from './plugins.js';
import { installListedPlugin, type TakeOnDeps } from './take-on.js';
import type { DecideResult, WriteResult } from './write.js';

export interface CatalogueDeps extends PagesDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  pool: TakeOnDeps['pool'];
  service: CatalogueService;
  binding: CatalogueBinding;
  /** Decide an approval `approved` as the owner: the card's own decide. */
  approve: (actionId: string) => Promise<WriteResult<DecideResult>>;
  engine?: TakeOnDeps['engine'];
  /** The running registry, when it can load a plugin live. */
  liveRegistry?: TakeOnDeps['registry'];
  fetch?: MarketDeps['fetch'];
  /** How long the job waits for a plugin it installed to load. One minute. */
  loadWaitMs?: number;
}

/** A plugin the catalogue needs, as the card and the sheet draw it. */
export type MissingView =
  | (MissingPlugin & { title: string; listed: boolean; byBuddi: boolean; version?: string })
  | MissingNeed;

/** One of a package's skills as the detail page titles and opens it. */
export interface CatalogueSkillView {
  /** The file name without `.md`. */
  name: string;
  description: string;
  /** The skill's text as the package carries it (no front matter). */
  text: string;
}

export interface CatalogueCard extends Omit<CatalogueEntryView, 'missing' | 'skills'> {
  missing?: MissingView[];
  skills: CatalogueSkillView[];
  /** Add works now: nothing is missing, or only By-buddi plugins it installs on the way. */
  addable: boolean;
}

async function marketPlugins(deps: CatalogueDeps): Promise<MarketEntry[]> {
  const loaded = await loadMarketIndex({ env: deps.env, log: deps.log, now: deps.now, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  return 'unavailable' in loaded ? [] : loaded.index.plugins;
}

function listingIntegrity(listing: MarketEntry): string {
  const value = (listing as { integrity?: unknown }).integrity;
  return typeof value === 'string' ? value.trim() : '';
}

function missingViews(missing: ReadonlyArray<MissingPlugin | MissingNeed>, listings: readonly MarketEntry[]): MissingView[] {
  return missing.map((item) => {
    if (item.kind === 'need') return item;
    const listing = listings.find((l) => l.name === item.name);
    return {
      ...item,
      title: listing?.title ?? item.name.charAt(0).toUpperCase() + item.name.slice(1),
      listed: listing !== undefined,
      byBuddi: listing?.trust === 'by-buddi' && listingIntegrity(listing) !== '',
      ...(listing ? { version: listing.version } : {}),
    };
  });
}

function addable(view: CatalogueEntryView, missing: readonly MissingView[]): boolean {
  if (view.state === 'ready') return true;
  if (view.state !== 'needs') return false;
  return missing.every((m) => m.kind === 'plugin' && m.fix === 'install' && m.byBuddi);
}

/** The catalogue as the page draws it. */
export async function catalogueRoute(deps: CatalogueDeps, url: URL): Promise<RouteReply> {
  const loaded = await deps.service.load({ refresh: url.searchParams.get('refresh') === '1' });
  const fromPlugins = proposalCards(deps, 'unavailable' in loaded ? [] : loaded.packages);
  if ('unavailable' in loaded) {
    return { status: 200, body: { agents: [], fromPlugins, delisted: [], unavailable: CATALOGUE_OFFLINE, detail: loaded.unavailable } };
  }
  const state = await stateContext(deps.registry, deps.service, deps.binding);
  const listings = loaded.packages.some((p) => Object.keys(p.manifest.requires).length > 0) ? await marketPlugins(deps) : [];
  const agents: CatalogueCard[] = loaded.packages.map((pkg) => {
    const view = entryView(pkg, packageState(pkg, state), deps.ctx.timezone);
    const missing = missingViews(view.missing ?? [], listings);
    const { missing: _missing, skills: _skills, ...rest } = view;
    return {
      ...rest,
      skills: pkg.skills.map((skill) => ({ name: skill.name, description: skill.description, text: skill.body })),
      ...(view.missing ? { missing } : {}),
      addable: addable(view, missing),
    };
  });
  const listed = new Set(loaded.packages.map((p) => p.manifest.name));
  const delisted = state.added
    .filter((a) => a.provenance.source === 'market' && a.provenance.package !== undefined && !listed.has(a.provenance.package))
    .map((a) => ({
      agentId: a.agentId,
      handle: state.handleOf(a.agentId),
      name: deps.binding.catalog.get(a.agentId)?.name ?? a.agentId,
      package: a.provenance.package as string,
      version: a.provenance.version,
    }));
  return {
    status: 200,
    body: {
      fetchedAt: loaded.fetchedAt,
      ...(loaded.stale ? { stale: true } : {}),
      agents,
      fromPlugins,
      delisted,
      // "Uses your mailbox" on a card that reads mail, said only when one is connected.
      mailbox: state.needs.mailbox === true,
      ...(loaded.problems.length > 0 ? { problems: loaded.problems } : {}),
    },
  };
}

/** Agents an installed plugin proposes, shown "from <plugin>" (Mail Triage, third-party advisors). */
function proposalCards(deps: CatalogueDeps, packages: readonly AgentPackage[]): Array<Record<string, unknown>> {
  return pluginAgentProposals(deps.registry)
    .filter(({ plugin, agent }) => !packages.some((p) => p.manifest.replaces.includes(`${plugin}/${agent.id}`)))
    .map(({ plugin, pluginVersion, agent }) => ({
      plugin,
      pluginVersion,
      agent: agent.id,
      handle: agent.handle,
      name: agent.name,
      description: agent.description,
      text: agent.offer?.text ?? agent.description,
      state: deps.binding.catalog.get(agent.id) ? 'installed' : 'ready',
    }));
}

/** Where an agent from the catalogue stands, as its own page draws it (`GET /api/agents` → `catalogue`). */
export interface AgentCatalogueProvenance {
  source: 'market';
  /** The package it came from (or, with `via`, the one that does its job now). */
  package: string;
  title: string;
  /** The version written; with `via`, the older agent's own version. */
  version: string;
  /** The version the kept list has, or null when there is no copy or it is no longer listed. */
  latest: string | null;
  drift: Drift;
  /** The kept list no longer has it: it keeps working, and no update will come. */
  delisted: boolean;
  /** `buddi/planner`, when this is an older agent the package replaces. */
  via?: string;
}

/**
 * Every agent on disk that came from the catalogue (or that a package replaces),
 * with its drift against the kept copy of the list. Never fetches: an agent's
 * page asks on every load, and without a copy only what the sidecar knows is said.
 */
export async function agentsCatalogue(
  deps: Pick<CatalogueDeps, 'service' | 'binding'>,
): Promise<Record<string, AgentCatalogueProvenance>> {
  const added = addedAgents(deps.binding.agentsDir);
  if (added.length === 0) return {};
  const loaded = await deps.service.load({ cachedOnly: true }).catch(() => ({ unavailable: 'unreadable' }) as const);
  const packages = 'unavailable' in loaded ? null : loaded.packages;
  const handleOf = (id: string): string => deps.binding.catalog.get(id)?.handle ?? id;
  const out: Record<string, AgentCatalogueProvenance> = {};
  for (const a of added) {
    if (a.provenance.source === 'market' && a.provenance.package !== undefined) {
      const pkg = packages?.find((p) => p.manifest.name === a.provenance.package);
      const name = a.provenance.package;
      out[a.agentId] = {
        source: 'market',
        package: name,
        title: pkg?.manifest.title ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' '),
        version: a.provenance.version,
        latest: pkg?.manifest.version ?? null,
        drift: pkg ? (installedAsFor(pkg, [a], handleOf)?.drift ?? 'current') : a.edited ? 'edited' : 'current',
        delisted: packages !== null && pkg === undefined,
      };
      continue;
    }
    const pkg = packages?.find((p) => matchesPackage(p, a) === 'replaces');
    const as = pkg ? installedAsFor(pkg, [a], handleOf) : undefined;
    if (!pkg || !as) continue;
    out[a.agentId] = {
      source: 'market',
      package: pkg.manifest.name,
      title: pkg.manifest.title,
      version: a.provenance.version,
      latest: pkg.manifest.version,
      drift: as.drift,
      delisted: false,
      ...(as.via ? { via: as.via } : {}),
    };
  }
  return out;
}

async function findListed(deps: CatalogueDeps, name: string): Promise<{ pkg: AgentPackage } | { reply: RouteReply }> {
  const loaded = await deps.service.load();
  if ('unavailable' in loaded) return { reply: { status: 503, body: { error: CATALOGUE_OFFLINE, detail: loaded.unavailable } } };
  const pkg = loaded.packages.find((p) => p.manifest.name === name);
  if (!pkg) {
    const refused = loaded.problems.find((p) => p.startsWith(`${name}:`));
    return { reply: { status: refused ? 422 : 404, body: { error: refused ?? `The catalogue lists no agent "${name}".` } } };
  }
  return { pkg };
}

function refusalReply(err: unknown): RouteReply {
  const code = (err as { code?: unknown })?.code;
  if (err instanceof Error && (err.name === 'PlatformRefusal' || typeof code === 'string')) {
    const status = code === 'already-added' || code === 'owner-edited' || code === 'up-to-date' || code === 'version-moved' ? 409 : code === 'offline' ? 503 : 400;
    return { status, body: { error: err.message, ...(typeof code === 'string' ? { code } : {}) } };
  }
  throw err;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('`fills` is an object of pick id to answer');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new TypeError(`the answer to "${k}" must be text`);
    out[k] = v;
  }
  return out;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new TypeError(`\`${field}\` is a list of ids`);
  return value as string[];
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`\`${field}\` must be text`);
  return value;
}

/** The package's handle, or the first free one beside it (chef-2), as the install will pick. */
function freeHandle(deps: CatalogueDeps, base: string): string {
  const taken = new Set(deps.binding.catalog.list().map((a) => a.handle.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}

/** The tools of a grant, each with its tier and first line, as the sheet lists them. */
function toolRows(registry: ToolRegistry, names: readonly string[]): Array<{ name: string; tier: string; description: string }> {
  const specs = new Map(registry.list().map((t) => [t.name, t]));
  return names.map((name) => {
    const spec = specs.get(name);
    return { name, tier: spec?.tier ?? 'unknown', description: (spec?.description ?? '').split(/(?<=\.)\s/)[0] ?? '' };
  });
}

function choicesFor(kind: string, choices: FillChoices): string[] | undefined {
  if (kind === 'mailbox') return choices.mailboxes;
  if (kind === 'calendar') return choices.calendars;
  if (kind === 'place') return choices.places.map((p) => p.label);
  return undefined;
}

function missionView(envelope: InstallAgentEnvelope): Array<Record<string, unknown>> {
  return envelope.missions.map((m) => ({ id: m.slug, name: m.name, cron: m.cron, enabled: m.enabled, prompt: m.prompt }));
}

/**
 * `POST /api/catalogue/:name/plan` — what adding it would do, writing nothing:
 * the plugins it installs on the way, the picks with their defaults and
 * choices, the handle (a free one beside the package's when that is taken),
 * the tools with their tiers, the missions, and the approval's preview.
 */
export async function planRoute(deps: CatalogueDeps, name: string, body: Record<string, unknown>): Promise<RouteReply> {
  const found = await findListed(deps, name);
  if ('reply' in found) return found.reply;
  const { pkg } = found;
  let fills: Record<string, string> | undefined;
  let missionsOn: string[] | undefined;
  let handle: string | undefined;
  try {
    fills = stringRecord(body.fills);
    missionsOn = stringList(body.missionsOn, 'missionsOn');
    handle = optionalString(body.handle, 'handle');
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
  const state = packageState(pkg, await stateContext(deps.registry, deps.service, deps.binding));
  if (state.state === 'installed') {
    return { status: 409, body: { error: `${pkg.manifest.title} is already on the team as @${state.installed.handle}.`, installed: state.installed } };
  }
  if (state.state === 'unavailable') return { status: 409, body: { error: state.reason } };
  const listings = await marketPlugins(deps);
  const missing = missingViews(state.state === 'needs' ? state.missing : [], listings);
  const blocking = missing.filter((m) => !(m.kind === 'plugin' && m.fix === 'install' && m.byBuddi));
  const choices = await deps.service.choices();
  const plugins = missing.filter((m): m is Extract<MissingView, { kind: 'plugin' }> => m.kind === 'plugin');
  const base = {
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    title: pkg.manifest.title,
    plugins: plugins.map((p) => ({ name: p.name, title: p.title, version: p.version ?? null, byBuddi: p.byBuddi, fix: p.fix })),
    blocked: blocking,
  };
  if (plugins.length > 0 || blocking.length > 0) {
    // The grant cannot be resolved until its plugins load: the sheet shows the
    // package's own list, and the approval is built when the job gets there.
    let picks;
    try {
      picks = resolvePicks(pkg, fills, choices);
    } catch (err) {
      return refusalReply(err);
    }
    const claimed = (pkg.manifest.claims as { tools?: unknown } | undefined)?.tools;
    return {
      status: 200,
      body: {
        ...base,
        handle: handle ?? freeHandle(deps, pkg.manifest.handle),
        fills: pkg.manifest.fills.map((f) => ({ ...f, value: picks.find((p) => p.id === f.id)?.value ?? '', choices: choicesFor(f.kind, choices) })),
        tools: Array.isArray(claimed) ? claimed : pkg.manifest.tools.map((t) => ({ name: t, tier: 'unknown', description: '' })),
        missions: pkg.manifest.missions.map((m) => ({ id: m.id, name: m.name, cron: m.cron, enabled: (missionsOn ?? []).includes(m.id), prompt: m.prompt })),
        preview: null,
        note: blocking.length > 0
          ? 'Something it needs is not here yet; see `blocked`.'
          : `The approval is shown once ${plugins.map((p) => p.title).join(' and ')} ${plugins.length === 1 ? 'is' : 'are'} installed, before ${pkg.manifest.title} is added.`,
      },
    };
  }
  try {
    const { envelope, preview } = await planCatalogueInstall(
      deps.registry,
      { name: pkg.manifest.name, version: pkg.manifest.version, ...(fills ? { fills } : {}), ...(missionsOn ? { missionsOn } : {}), ...(handle ? { handle } : {}) },
      { timezone: deps.ctx.timezone, db: deps.ctx.db, agentId: OWNER_AGENT_ID },
    );
    return {
      status: 200,
      body: {
        ...base,
        id: envelope.id,
        handle: envelope.handle,
        fills: pkg.manifest.fills.map((f) => ({ ...f, value: envelope.picks.find((p) => p.id === f.id)?.value ?? '', choices: choicesFor(f.kind, choices) })),
        tools: toolRows(deps.registry, envelope.tools),
        missions: missionView(envelope),
        account: envelope.account,
        preview,
      },
    };
  } catch (err) {
    return refusalReply(err);
  }
}

/* ------------------------------------------------------------------ *
 * The install job
 * ------------------------------------------------------------------ */

export type JobStepState = 'waiting' | 'fetching' | 'reading' | 'installing' | 'loading' | 'adding' | 'done' | 'failed';

export interface CatalogueJob {
  id: string;
  name: string;
  version: string;
  title: string;
  state: 'running' | 'done' | 'failed';
  steps: Array<{ kind: 'plugin' | 'agent'; name: string; title: string; state: JobStepState; reason?: string }>;
  agent?: { id: string; handle: string; name: string };
  approvalId?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

const JOBS = new Map<string, CatalogueJob>();

/** For tests: forget the jobs. */
export function resetCatalogueJobs(): void {
  JOBS.clear();
}

/** For tests: wait until a job has finished. */
export async function catalogueJobSettled(id: string, timeoutMs = 30_000): Promise<CatalogueJob | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const job = JOBS.get(id);
    if (!job || job.state !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return JOBS.get(id);
}

function remember(job: CatalogueJob): void {
  JOBS.set(job.id, job);
  while (JOBS.size > 20) {
    const oldest = JOBS.keys().next();
    if (oldest.done) break;
    JOBS.delete(oldest.value);
  }
}

/** `GET /api/catalogue/jobs/:id`. */
export function jobRoute(id: string): RouteReply {
  const job = JOBS.get(id);
  return job ? { status: 200, body: job } : { status: 404, body: { error: 'No such job; buddi may have restarted.' } };
}

/**
 * `POST /api/catalogue/:name/install` `{ version, fills, handle, missionsOn }`
 * — answers 202 with the job at once; `GET /api/catalogue/jobs/:id` gives its
 * progress.
 */
export async function installRoute(deps: CatalogueDeps, name: string, body: Record<string, unknown>): Promise<RouteReply> {
  const found = await findListed(deps, name);
  if ('reply' in found) return found.reply;
  const { pkg } = found;
  let input: { fills?: Record<string, string>; missionsOn?: string[]; handle?: string; account?: string; version?: string };
  try {
    const fills = stringRecord(body.fills);
    const missionsOn = stringList(body.missionsOn, 'missionsOn');
    const handle = optionalString(body.handle, 'handle');
    const account = optionalString(body.account, 'account');
    const version = optionalString(body.version, 'version');
    input = { ...(fills ? { fills } : {}), ...(missionsOn ? { missionsOn } : {}), ...(handle ? { handle } : {}), ...(account ? { account } : {}), ...(version ? { version } : {}) };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
  if (input.version !== undefined && input.version !== pkg.manifest.version) {
    return { status: 409, body: { error: `The catalogue now lists ${pkg.manifest.title} ${pkg.manifest.version}; look at it again before adding it.`, version: pkg.manifest.version } };
  }
  const running = [...JOBS.values()].find((j) => j.name === name && j.state === 'running');
  if (running) return { status: 202, body: { jobId: running.id } };
  const state = packageState(pkg, await stateContext(deps.registry, deps.service, deps.binding));
  if (state.state === 'installed') {
    return { status: 409, body: { error: `${pkg.manifest.title} is already on the team as @${state.installed.handle}.`, installed: state.installed } };
  }
  if (state.state === 'unavailable') return { status: 409, body: { error: state.reason } };
  const listings = await marketPlugins(deps);
  const missing = missingViews(state.state === 'needs' ? state.missing : [], listings);
  const blocking = missing.filter((m) => !(m.kind === 'plugin' && m.fix === 'install' && m.byBuddi));
  if (blocking.length > 0) {
    const words = blocking.map((m) =>
      m.kind === 'need'
        ? m.name === 'mailbox' ? 'a mailbox (Settings → Email)' : 'an account that draws (Settings → Model accounts)'
        : m.fix === 'enable' ? `${m.title} turned on (Settings → Plugins)`
        : m.fix === 'update' ? `${m.title} ${m.range} (Settings → Plugins → Update)`
        : `${m.title}, which is not made by buddi, so it waits for you to install it in Settings → Plugins`,
    );
    return { status: 409, body: { error: `${pkg.manifest.title} needs ${words.join(' and ')} first.`, blocked: blocking } };
  }
  const plugins = missing.filter((m): m is Extract<MissingView, { kind: 'plugin' }> => m.kind === 'plugin');
  const job: CatalogueJob = {
    id: randomUUID(),
    name,
    version: pkg.manifest.version,
    title: pkg.manifest.title,
    state: 'running',
    steps: [
      ...plugins.map((p) => ({ kind: 'plugin' as const, name: p.name, title: p.title, state: 'waiting' as JobStepState })),
      { kind: 'agent', name, title: pkg.manifest.title, state: 'waiting' },
    ],
    startedAt: new Date().toISOString(),
  };
  remember(job);
  void runJob(deps, job, pkg, input, listings).catch((err: unknown) => {
    finish(job, 'failed', err instanceof Error ? err.message : String(err));
    deps.log(`catalogue: adding ${name} failed: ${job.error}`);
  });
  return { status: 202, body: { jobId: job.id } };
}

function finish(job: CatalogueJob, state: 'done' | 'failed', error?: string): void {
  job.state = state;
  if (error !== undefined) job.error = error.replace(/[.\s]+$/, '');
  job.finishedAt = new Date().toISOString();
}

async function waitForPlugin(deps: CatalogueDeps, name: string): Promise<boolean> {
  const until = Date.now() + (deps.loadWaitMs ?? 60_000);
  for (;;) {
    if (deps.registry.manifests().some((m) => m.name === name)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function runJob(
  deps: CatalogueDeps,
  job: CatalogueJob,
  pkg: AgentPackage,
  input: { fills?: Record<string, string>; missionsOn?: string[]; handle?: string; account?: string },
  listings: readonly MarketEntry[],
): Promise<void> {
  for (const step of job.steps) {
    if (step.kind !== 'plugin') continue;
    const listing = listings.find((l) => l.name === step.name);
    const outcome = await installListedPlugin(
      { pool: deps.pool, env: deps.env, log: deps.log, engine: deps.engine, registry: deps.liveRegistry },
      listing,
      { keepMismatch: true, onState: (state) => { step.state = state; } },
    );
    if (!outcome.ok) {
      step.state = 'failed';
      step.reason = outcome.reason;
      finish(job, 'failed', `${step.title} was not installed: ${outcome.reason}. ${pkg.manifest.title} was not added`);
      return;
    }
    step.state = 'loading';
    if (!(await waitForPlugin(deps, step.name))) {
      step.state = 'failed';
      step.reason = 'installed, but it did not load; it wakes up on the next restart';
      finish(job, 'failed', `${step.title} is installed but did not load, so ${pkg.manifest.title} was not added. Restart buddi, then add it again`);
      return;
    }
    step.state = 'done';
  }
  const agentStep = job.steps[job.steps.length - 1] as CatalogueJob['steps'][number];
  agentStep.state = 'adding';
  const result = await deps.registry.invoke(
    'platform.install_agent',
    { name: pkg.manifest.name, version: pkg.manifest.version, ...input },
    { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now },
  );
  if (!result.ok && result.reason !== 'approval-required') {
    agentStep.state = 'failed';
    agentStep.reason = result.message;
    finish(job, 'failed', result.message);
    return;
  }
  if (!result.ok) {
    job.approvalId = result.actionId;
    const decided = await deps.approve(result.actionId);
    if (!decided.ok) {
      agentStep.state = 'failed';
      agentStep.reason = decided.body.error;
      finish(job, 'failed', decided.body.error);
      return;
    }
    const execution = decided.body.execution;
    if (execution && execution.state !== 'succeeded') {
      agentStep.state = 'failed';
      agentStep.reason = execution.message ?? execution.state;
      finish(job, 'failed', execution.message ?? `Adding ${pkg.manifest.title} did not finish (${execution.state})`);
      return;
    }
  }
  const added = addedAgents(deps.binding.agentsDir).find(
    (a) => a.provenance.source === 'market' && a.provenance.package === pkg.manifest.name,
  );
  const agent = added ? deps.binding.catalog.get(added.agentId) : undefined;
  job.agent = agent
    ? { id: agent.id, handle: agent.handle, name: agent.name }
    : { id: added?.agentId ?? pkg.manifest.name, handle: input.handle ?? pkg.manifest.handle, name: pkg.manifest.title };
  agentStep.state = 'done';
  finish(job, 'done');
}

/* ------------------------------------------------------------------ *
 * Updates and removal
 * ------------------------------------------------------------------ */

/**
 * `POST /api/catalogue/:name/update/plan` `{ agentId }` — the update sheet:
 * the version and `changes`, the persona diff, tools added and removed,
 * missions added, and whether the owner edited the file (then only "See what
 * changed" and "Replace my changes" are offered).
 */
export async function updatePlanRoute(deps: CatalogueDeps, name: string, body: Record<string, unknown>): Promise<RouteReply> {
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  if (agentId === '') return { status: 400, body: { error: '`agentId` names the agent to update.' } };
  try {
    const { envelope, preview } = await planCatalogueInstall(
      deps.registry,
      // A read: built as if replacing, so an edited file's diff shows too.
      { name, agent: agentId, replaceEdits: true },
      { timezone: deps.ctx.timezone, db: deps.ctx.db, agentId: OWNER_AGENT_ID },
    );
    const u = envelope.update!;
    return {
      status: 200,
      body: {
        agentId: envelope.id,
        handle: envelope.handle,
        name,
        title: envelope.package.title,
        fromVersion: u.fromVersion,
        version: envelope.package.version,
        changes: envelope.package.changes,
        via: u.via,
        edited: u.edited,
        widened: u.widened,
        added: toolRows(deps.registry, u.added),
        removed: u.removed,
        personaDiff: u.personaDiff,
        missionsAdded: missionView(envelope),
        preview,
      },
    };
  } catch (err) {
    return refusalReply(err);
  }
}

/** Invoke a gated platform tool as the owner and approve it with the same click. */
async function invokeApproved(
  deps: CatalogueDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; approvalId: string | null; result: unknown } | { ok: false; reply: RouteReply }> {
  const result = await deps.registry.invoke(tool, args, { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now });
  if (result.ok) return { ok: true, approvalId: null, result: result.output };
  if (result.reason !== 'approval-required') {
    const status = result.reason === 'unknown-tool' ? 404 : 400;
    return { ok: false, reply: { status, body: { error: result.message } } };
  }
  const decided = await deps.approve(result.actionId);
  if (!decided.ok) return { ok: false, reply: { status: decided.status, body: { error: decided.body.error, approvalId: result.actionId } } };
  const execution = decided.body.execution;
  if (execution && execution.state !== 'succeeded') {
    return { ok: false, reply: { status: 409, body: { error: execution.message ?? `It did not finish (${execution.state}).`, approvalId: result.actionId } } };
  }
  return { ok: true, approvalId: result.actionId, result: execution?.result ?? null };
}

/**
 * `POST /api/catalogue/:name/update` `{ agentId, replace? }` — the owner's
 * click on Update (or "Replace my changes", with `replace: true`) is the
 * approval. An edited file without `replace` is refused, untouched.
 */
export async function updateRoute(deps: CatalogueDeps, name: string, body: Record<string, unknown>): Promise<RouteReply> {
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  if (agentId === '') return { status: 400, body: { error: '`agentId` names the agent to update.' } };
  const input = { name, agent: agentId, ...(body.replace === true ? { replaceEdits: true as const } : {}) };
  // Checked first for its typed refusal (an edited file, nothing to update): the card's would be a sentence only.
  try {
    await planCatalogueInstall(deps.registry, input, { timezone: deps.ctx.timezone, db: deps.ctx.db, agentId: OWNER_AGENT_ID });
  } catch (err) {
    return refusalReply(err);
  }
  const done = await invokeApproved(deps, 'platform.install_agent', input);
  if (!done.ok) return done.reply;
  return { status: 200, body: { approvalId: done.approvalId, result: done.result } };
}

/**
 * `GET /api/agents/:id/remove` — what removing it does: the preview
 * `platform.delete_agent` carries (its missions paused, the plugins no other
 * agent uses named). Nothing changes.
 */
export async function removePreviewRoute(deps: CatalogueDeps, agentId: string): Promise<RouteReply> {
  const tool = deps.registry.lookup('platform.delete_agent');
  if (!tool?.describe) return { status: 404, body: { error: 'Removing agents is not available here.' } };
  try {
    const described = await tool.describe({ id: agentId }, { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now });
    const envelope = described.envelope as { id: string; handle: string; name: string; pausesMissions?: unknown[]; unusedPlugins?: string[] };
    return {
      status: 200,
      body: {
        id: envelope.id,
        handle: envelope.handle,
        name: envelope.name,
        pausesMissions: envelope.pausesMissions ?? [],
        unusedPlugins: envelope.unusedPlugins ?? [],
        preview: described.preview,
      },
    };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/** `POST /api/agents/:id/remove` — Remove from team: the click is the approval. The directory goes to the trash. */
export async function removeRoute(deps: CatalogueDeps, agentId: string): Promise<RouteReply> {
  const done = await invokeApproved(deps, 'platform.delete_agent', { id: agentId });
  if (!done.ok) return done.reply;
  return { status: 200, body: { approvalId: done.approvalId, result: done.result } };
}

