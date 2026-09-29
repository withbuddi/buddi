/**
 * First run, chapter 3: "What should I take on for you?"
 *
 * The owner ticks outcomes (My days, My mail, My money, Voice, My code,
 * Pictures), and each outcome's plugins are fetched from withbuddi.com and
 * installed **in the background**, while chapters 4 and 5 are answered. The
 * route answers at once with a job per plugin; the page polls the progress
 * (`GET /api/onboarding/take-on`) and draws "Fetching Weather and Calendar… 1
 * of 2" under the tiles and in the chapter map, and a reload reads the same
 * progress back.
 *
 * Every install is the ordinary one: the market's listing is staged as a
 * plugin job (`startJob`, the list `GET /api/plugins/jobs/<id>` answers), the
 * staged card is written to disk, and its approval is recorded with the staged
 * integrity, so Settings → Plugins shows the plugin installed with its hash
 * exactly as a click would have left it. The one difference is who approves;
 * see `installOne`.
 *
 * Teammates are not created here. A tile's teammate (Planner for My days,
 * Ledger for My money, Illustrator for Pictures) stays the *offer* it already
 * is — the starter team on "Add a teammate", a plugin's proposal on Home — and
 * the handover card says it is ready to be introduced.
 */
import type { Pool } from 'pg';
import { beginOnboarding, getOnboarding, markStepDone, setOnboardingDetails, type Queryable } from '@buddi/core';
import type { LiveRegistry } from '../plugins/live.js';
import type { StagePhase } from '../plugins/index.js';
import { loadMarketIndex, type MarketDeps, type MarketEntry } from './market.js';
import { installedRecord, startJob, type PluginsEngine, type StageJob } from './plugins.js';
import * as engine from '../plugins/index.js';

/** The six outcomes, in the order the chapter draws them. */
export const TAKE_ON_TILES = ['days', 'mail', 'money', 'voice', 'code', 'pictures'] as const;
export type TakeOnTile = (typeof TAKE_ON_TILES)[number];

/**
 * The plugins each outcome brings, by their buddi names. Mail and code bring
 * none: Mail Triage and the developer tools are built in.
 */
export const TILE_PLUGINS: Readonly<Record<TakeOnTile, readonly string[]>> = {
  days: ['weather', 'calendar'],
  mail: [],
  money: ['finance'],
  voice: ['speech'],
  code: [],
  pictures: ['image'],
};

/** The teammate an outcome suggests, as an offer; `plugin` is who proposes it. */
export const TILE_TEAMMATES: Readonly<Partial<Record<TakeOnTile, { agent: string; name: string; plugin: string }>>> = {
  days: { agent: 'planner', name: 'Planner', plugin: 'buddi' },
  mail: { agent: 'mail-triage', name: 'Mail Triage', plugin: 'email' },
  money: { agent: 'ledger', name: 'Ledger', plugin: 'finance' },
  pictures: { agent: 'illustrator', name: 'Illustrator', plugin: 'image' },
};

/** What a plugin is called on the page when the listing names nothing better. */
const TITLES: Readonly<Record<string, string>> = {
  weather: 'Weather',
  calendar: 'Calendar',
  finance: 'Finance',
  speech: 'Speech',
  image: 'Image',
};

export type TakeOnState = 'fetching' | 'reading' | 'installing' | 'ready' | 'failed';

/** One plugin of chapter 3, as the page draws it. */
export interface TakeOnProgress {
  plugin: string;
  title: string;
  /** The plugin job, when one was started in this process. */
  jobId?: string;
  state: TakeOnState;
  /** Why it failed, in a sentence the owner can read. */
  reason?: string;
  /** Installed, but this process could not load it live: it wakes up on the next restart. */
  wakesOnRestart?: boolean;
}

export interface TakeOnView {
  tiles: string[];
  plugins: TakeOnProgress[];
  /** Something is still being fetched, read or installed: the page keeps asking. */
  running: boolean;
  /** "Things still waiting", one sentence each, for the handover card. */
  waiting: string[];
}

/** The engine as this module uses it; tests hand in one with a fake npm. */
export type TakeOnEngine = Pick<PluginsEngine, 'stagePlugin' | 'approveStaged' | 'rejectStaged'> &
  Partial<Pick<PluginsEngine, 'setPluginEnabled'>>;

export interface TakeOnDeps {
  pool: Queryable;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  engine?: TakeOnEngine | undefined;
  /** The running registry, so an installed plugin loads without a restart. */
  registry?: LiveRegistry | undefined;
  /** Injected by tests that want no socket; the market module's own otherwise. */
  fetch?: MarketDeps['fetch'];
  /** Is a mailbox connected? The email plugin's own `triage_offer` read. */
  mailboxSet?: () => Promise<boolean>;
  /** The agents the roster holds, for "ready to be introduced". */
  agentIds?: () => string[];
}

export class TakeOnRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'TakeOnRefusal';
  }
}

/** Per plugin, this process. A restart forgets it; the record of installs does not. */
const PROGRESS = new Map<string, TakeOnProgress>();
/** One run at a time: installs are fetched and approved one after the other. */
let queue: Promise<void> = Promise.resolve();

/** For tests: forget what this process was doing. */
export function resetTakeOn(): void {
  PROGRESS.clear();
  queue = Promise.resolve();
}

/** For tests: wait for the installs under way to settle. */
export function takeOnSettled(): Promise<void> {
  return queue;
}

/** The tiles as sent, checked: known names, each once, in the chapter's order. */
export function parseTiles(value: unknown): TakeOnTile[] {
  if (!Array.isArray(value) || value.some((tile) => typeof tile !== 'string')) {
    throw new TakeOnRefusal(400, '`tiles` must be a list of the outcomes to take on (an empty list is fine).');
  }
  const unknown = (value as string[]).filter((tile) => !(TAKE_ON_TILES as readonly string[]).includes(tile));
  if (unknown.length > 0) {
    throw new TakeOnRefusal(400, `Not an outcome buddi knows: ${unknown.join(', ')}. The six are ${TAKE_ON_TILES.join(', ')}.`);
  }
  return TAKE_ON_TILES.filter((tile) => (value as string[]).includes(tile));
}

/** The plugins the tiles bring, each once. */
export function pluginsOf(tiles: readonly string[]): string[] {
  return [...new Set(tiles.flatMap((tile) => TILE_PLUGINS[tile as TakeOnTile] ?? []))];
}

function isInstalled(env: NodeJS.ProcessEnv, plugin: string): boolean {
  return installedRecord(env).plugins.some((entry) => entry.name === plugin);
}

function running(progress: TakeOnProgress | undefined): boolean {
  return progress !== undefined && progress.state !== 'ready' && progress.state !== 'failed';
}

/**
 * `POST /api/onboarding/take-on`: record the choice and start the installs.
 *
 * Answers at once. A plugin already installed is ready with no job; one
 * already being installed keeps its job; everything else gets a new one, and
 * the whole list runs behind this answer, one plugin after the other.
 */
export async function startTakeOn(deps: TakeOnDeps, value: unknown): Promise<{ jobs: Array<{ plugin: string; jobId: string }> }> {
  const tiles = parseTiles(value);
  await beginOnboarding(deps.pool, 'web');
  await markStepDone(deps.pool, 'take-on');
  await setOnboardingDetails(deps.pool, { takeOn: tiles });

  const jobs: Array<{ plugin: string; jobId: string }> = [];
  const toRun: Array<{ plugin: string; job: StageJob }> = [];
  for (const plugin of pluginsOf(tiles)) {
    const now = PROGRESS.get(plugin);
    if (running(now) && now?.jobId) {
      jobs.push({ plugin, jobId: now.jobId });
      continue;
    }
    if (isInstalled(deps.env, plugin)) {
      PROGRESS.set(plugin, { plugin, title: now?.title ?? TITLES[plugin] ?? plugin, state: 'ready', ...(now?.wakesOnRestart ? { wakesOnRestart: true } : {}) });
      continue;
    }
    const job = startJob('stage');
    PROGRESS.set(plugin, { plugin, title: TITLES[plugin] ?? plugin, jobId: job.id, state: 'fetching' });
    jobs.push({ plugin, jobId: job.id });
    toRun.push({ plugin, job });
  }
  if (toRun.length > 0) {
    queue = queue.then(() => runAll(deps, toRun)).catch((err: unknown) => {
      deps.log(`first run: taking plugins on failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return { jobs };
}

async function runAll(deps: TakeOnDeps, list: Array<{ plugin: string; job: StageJob }>): Promise<void> {
  const loaded = await loadMarketIndex({ env: deps.env, log: deps.log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  for (const { plugin, job } of list) {
    if ('unavailable' in loaded) {
      fail(deps, plugin, job, 'withbuddi.com did not answer. Settings → Plugins can fetch it later');
      continue;
    }
    const listing = loaded.index.plugins.find((entry) => entry.name === plugin);
    try {
      await installOne(deps, plugin, listing, job);
    } catch (err) {
      fail(deps, plugin, job, err instanceof Error ? err.message : String(err));
    }
  }
}

function set(plugin: string, patch: Partial<TakeOnProgress>): void {
  const now = PROGRESS.get(plugin);
  if (now) PROGRESS.set(plugin, { ...now, ...patch });
}

function fail(deps: TakeOnDeps, plugin: string, job: StageJob, reason: string): void {
  const sentence = reason.replace(/[.\s]+$/, '');
  set(plugin, { state: 'failed', reason: sentence });
  job.phase = 'failed';
  job.error = sentence;
  job.finishedAt = new Date().toISOString();
  deps.log(`first run: ${plugin} was not installed: ${sentence}`);
}

/**
 * Why buddi may not approve this listing on the owner's behalf, or null when it may.
 *
 * Only a By-buddi listing, and only one that names the integrity the market
 * checked. Anything else — a reviewed listing, a listing with no hash — is
 * left for the owner to read on its card in Settings → Plugins.
 */
export function autoApprovalRefusal(listing: MarketEntry | undefined): string | null {
  if (!listing) return 'withbuddi.com does not list it. Settings → Plugins can add it later';
  if (listing.trust !== 'by-buddi') return `${listing.title} is not made by buddi, so it waits for you to read its card in Settings → Plugins`;
  const integrity = (listing as { integrity?: unknown }).integrity;
  if (typeof integrity !== 'string' || integrity.trim() === '') {
    return `withbuddi.com lists ${listing.title} without its hash, so it waits for you in Settings → Plugins`;
  }
  return null;
}

async function installOne(deps: TakeOnDeps, plugin: string, listing: MarketEntry | undefined, job: StageJob): Promise<void> {
  const api: TakeOnEngine = deps.engine ?? engine;
  const refused = autoApprovalRefusal(listing);
  if (refused !== null || !listing) {
    fail(deps, plugin, job, refused ?? 'withbuddi.com does not list it');
    return;
  }
  set(plugin, { title: listing.title });
  const listed = String((listing as { integrity?: unknown }).integrity).trim();

  const onPhase = (phase: StagePhase): void => {
    if (job.finishedAt === undefined) job.phase = phase;
    set(plugin, { state: phase === 'reading' ? 'reading' : 'fetching' });
  };
  const staged = await api.stagePlugin(`${listing.npm}@${listing.version}`, { env: deps.env, onPhase });
  job.stagedId = staged.id;

  /*
   * The one place an approval is not the owner's click.
   *
   * Everywhere else, approving a staged plugin is the owner reading its card
   * and sending back the integrity they were shown. Here the owner ticked "My
   * days" on first run, before there is a dashboard to read a card on, and
   * asked buddi to take it on. buddi approves on their behalf only what it
   * made itself: a listing marked By-buddi, whose integrity and npm provenance
   * withbuddi.com checked when it published the index, and only when the
   * tarball that arrived hashes to exactly the integrity that listing names.
   * Anything else — another author, a listing without a hash, bytes that do
   * not match — is refused here and waits on its card like any install. The
   * staged card and its approval are still written, so Settings → Plugins
   * shows the plugin installed with its hash, and the second approval (the
   * package's prose disagreeing with its manifest) is never given for them.
   */
  if (staged.integrity.trim() === '' || staged.integrity.trim() !== listed) {
    try {
      api.rejectStaged(staged.id, deps.env);
    } catch {
      /* The stage is swept later either way. */
    }
    fail(deps, plugin, job, `what arrived for ${listing.title} is not what withbuddi.com lists, so it was not installed`);
    return;
  }
  set(plugin, { state: 'installing' });
  const outcome = await api.approveStaged(staged.id, {
    integrity: staged.integrity,
    env: deps.env,
    ...(deps.pool && typeof (deps.pool as Pool).connect === 'function' ? { pool: deps.pool as Pool } : {}),
  });
  if (outcome.kind === 'drift') {
    fail(deps, plugin, job, `${listing.title} says something its code does not match, so it waits for you in Settings → Plugins`);
    return;
  }
  job.phase = 'done';
  job.finishedAt = new Date().toISOString();

  // Live, through the same path the Plugins page's enable switch takes, so the
  // hello can already use it. Anything short of that is said, not hidden.
  let wakesOnRestart = true;
  if (api.setPluginEnabled && deps.registry) {
    try {
      const toggled = await api.setPluginEnabled(outcome.record.name, true, {
        env: deps.env,
        log: deps.log,
        registry: deps.registry,
        ...(deps.pool && typeof (deps.pool as Pool).connect === 'function' ? { pool: deps.pool as Pool } : {}),
      });
      wakesOnRestart = toggled.restartNeeded || toggled.loadProblem !== undefined;
    } catch (err) {
      deps.log(`first run: ${plugin} is installed but did not load live: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  set(plugin, { state: 'ready', ...(wakesOnRestart ? { wakesOnRestart: true } : {}) });
}

/** `GET /api/onboarding/take-on`: the choice, the progress, and what is still waiting. */
export async function readTakeOn(deps: TakeOnDeps): Promise<TakeOnView> {
  const record = await getOnboarding(deps.pool);
  const tiles = record.details.takeOn ?? [];
  const plugins = pluginsOf(tiles).map((plugin): TakeOnProgress => {
    const known = PROGRESS.get(plugin);
    if (known && known.state !== 'failed') return known;
    if (isInstalled(deps.env, plugin)) return { plugin, title: known?.title ?? TITLES[plugin] ?? plugin, state: 'ready' };
    return known ?? { plugin, title: TITLES[plugin] ?? plugin, state: 'failed', reason: 'buddi restarted before it finished. Settings → Plugins can fetch it' };
  });
  return {
    tiles,
    plugins,
    running: plugins.some((p) => running(p)),
    waiting: await waitingFor(deps, tiles, plugins),
  };
}

/**
 * "Things still waiting": exactly what chapters 3 and 4 left open, one
 * sentence each, in the order the owner would deal with them.
 */
async function waitingFor(deps: TakeOnDeps, tiles: readonly string[], plugins: readonly TakeOnProgress[]): Promise<string[]> {
  const waiting: string[] = [];
  const present = new Set((deps.agentIds?.() ?? []).map((id) => id.toLowerCase()));
  const state = (plugin: string): TakeOnProgress | undefined => plugins.find((p) => p.plugin === plugin);
  let mailbox: boolean | undefined;
  if (tiles.includes('mail')) {
    mailbox = deps.mailboxSet ? await deps.mailboxSet().catch(() => false) : false;
    if (!mailbox) waiting.push('Mail Triage is waiting for a mailbox');
  }
  if (tiles.includes('days') && state('calendar')?.state !== 'failed') {
    waiting.push('Calendar wants your calendar’s private link');
  }
  for (const p of plugins) {
    if (p.state === 'failed') waiting.push(`${p.title} did not install: ${p.reason ?? 'no reason was given'}`);
    else if (p.state === 'ready' && p.wakesOnRestart) waiting.push(`${p.title} is installed; it wakes up on the next restart`);
  }
  for (const tile of TAKE_ON_TILES) {
    const mate = TILE_TEAMMATES[tile];
    if (!mate || !tiles.includes(tile) || present.has(mate.agent)) continue;
    // Mail Triage waits for a mailbox first; a plugin's teammate waits for its plugin.
    if (tile === 'mail' && !mailbox) continue;
    if (mate.plugin !== 'buddi' && mate.plugin !== 'email' && state(mate.plugin)?.state !== 'ready') continue;
    waiting.push(`${mate.name} is ready to be introduced`);
  }
  return waiting;
}
