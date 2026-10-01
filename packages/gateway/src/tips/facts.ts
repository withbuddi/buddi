/**
 * What the tips are decided on (docs/dashboard.md, Home): a handful of facts
 * about this installation, read from what already exists. Nothing here is
 * recorded for the tips' sake except the pages the dashboard reports it
 * opened (`tips.pages`), which nothing else knew.
 *
 * Every read is forgiving: a table a plugin owns may not be there, and a
 * failed read is the quiet answer ("not used", "none"), so a broken query can
 * only ever hold a tip back, never raise one.
 */
import { readWebSetting, writeWebSetting } from '@buddi/core';
import { ROLE_MAKER } from '../agents/roles.js';

/** The `core.web_settings` key the dashboard's page views are kept under. */
export const TIPS_PAGES_KEY = 'tips.pages';
/** Set once a second device has signed in, so an expired session does not forget it. */
export const TIPS_SECOND_DEVICE_KEY = 'tips.secondDevice';
/** How many distinct pages are remembered; the oldest seen goes first. */
export const TIPS_PAGES_CAP = 64;

export interface Facts {
  /** Whole days since the installation was first set up. */
  daysSinceInstall: number;
  /** First run is still going: no tip then. */
  firstRun: boolean;
  /** The owner's agents, the maker left out. */
  agents: number;
  agentIds: Set<string>;
  /** Groups not archived. */
  groups: number;
  /** Installed plugin names. */
  plugins: Set<string>;
  /** The email plugin has at least one mailbox. */
  mailboxSet: boolean;
  /** Somebody reads the mail: Mail Triage is on the team. */
  mailAgent: boolean;
  speechInstalled: boolean;
  /** The owner ever spoke to buddi (a recording) or an agent ever used speech. */
  voiceUsed: boolean;
  missions: number;
  telegramPaired: boolean;
  browserUsed: boolean;
  toolsUsed: Set<string>;
  pagesVisited: Set<string>;
  /**
   * Installed plugins that say they cannot do anything yet (their `setup`,
   * docs/plugins.md §2.9), each with what to do first and the dashboard
   * route where it is done.
   */
  needsSetup: Array<{ plugin: string; note?: string; route?: string }>;
  /** A dashboard PIN is set (Settings → Lock screen). */
  pinSet: boolean;
  /**
   * The dashboard has been signed in to from a second device: a session from
   * another address than the first. Remembered once seen, as sessions expire.
   */
  secondDevice: boolean;
  /** The finance plugin holds at least one account. */
  financeConnected: boolean;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface FactsDeps {
  pool: Queryable;
  now: () => Date;
  /** The roster as the catalog holds it now. */
  agents: () => ReadonlyArray<{ id: string; roles?: readonly string[] }>;
  /** Installed plugin names. */
  plugins: () => readonly string[];
  /** Whether the email plugin has a mailbox; its own page query answers it. */
  mailboxSet: () => Promise<boolean>;
  /** The plugins not set up yet; none when absent. */
  needsSetup?: () => Promise<Facts['needsSetup']>;
}

/** Mail Triage's agent id, as the email plugin proposes it. */
export const MAIL_AGENT_ID = 'mail-triage';
const DAY_MS = 86_400_000;

async function rows(pool: Queryable, sql: string, params: unknown[] = []): Promise<any[]> {
  try {
    return (await pool.query(sql, params)).rows;
  } catch {
    return [];
  }
}

async function count(pool: Queryable, sql: string): Promise<number> {
  const [row] = await rows(pool, sql);
  return Number(row?.n ?? 0) || 0;
}

/** The slice of `core.web_settings` the tips read and write; a map in tests. */
export interface SettingsStore {
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown): Promise<void>;
}

/** `core.web_settings`, as a `SettingsStore`. */
export function webSettingsStore(pool: Queryable): SettingsStore {
  return {
    read: <T>(key: string) => readWebSetting<T>(pool as never, key),
    write: (key, value) => writeWebSetting(pool as never, key, value),
  };
}

/** The pages the dashboard said it opened, page → the day it last said so. */
export async function readPagesSeen(store: SettingsStore): Promise<Record<string, string>> {
  try {
    const value = await store.read<Record<string, unknown>>(TIPS_PAGES_KEY);
    const out: Record<string, string> = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [page, day] of Object.entries(value)) if (typeof day === 'string') out[page] = day;
    }
    return out;
  } catch {
    return {};
  }
}

/** A page name the dashboard may report: its route, without the `#/`, short. */
export const PAGE_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

/**
 * Remember one page seen on one day. Once a day per page: a second report the
 * same day writes nothing. Capped: past `TIPS_PAGES_CAP` the page seen longest
 * ago is forgotten.
 */
export async function recordPageSeen(store: SettingsStore, page: string, day: string): Promise<boolean> {
  const seen = await readPagesSeen(store);
  if (seen[page] === day) return false;
  seen[page] = day;
  const entries = Object.entries(seen).sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]));
  await store.write(TIPS_PAGES_KEY, Object.fromEntries(entries.slice(0, TIPS_PAGES_CAP)));
  return true;
}

export async function readFacts(deps: FactsDeps): Promise<Facts> {
  const { pool } = deps;
  const roster = deps.agents().filter((a) => !(a.roles ?? []).includes(ROLE_MAKER));
  const agentIds = new Set(roster.map((a) => a.id));
  const plugins = new Set(deps.plugins());

  const [install] = await rows(
    pool,
    `select least((select min(created_at) from core.owner),
                  (select min(started_at) from core.onboarding)) as at`,
  );
  const installedAt = install?.at ? new Date(install.at) : deps.now();
  const daysSinceInstall = Math.max(0, Math.floor((deps.now().getTime() - installedAt.getTime()) / DAY_MS));

  const [onboarding] = await rows(pool, `select state from core.onboarding limit 1`);
  const firstRun = !onboarding || (onboarding.state !== 'done' && onboarding.state !== 'skipped');

  const toolsUsed = new Set<string>(
    (await rows(pool, `select distinct payload->>'name' as name from core.events where kind = 'tool.called'`))
      .map((r) => r.name)
      .filter((n): n is string => typeof n === 'string'),
  );
  const recorded = await count(
    pool,
    `select count(*)::int as n from core.artifacts where kind = 'audio' and created_by = 'owner' and deleted_at is null`,
  );

  // Devices signed in, by where they came from: this Mac, a tailnet address,
  // or a sign-in ticket (a phone that scanned the code). Two is a second device.
  const settings = webSettingsStore(pool);
  let secondDevice = (await settings.read<boolean>(TIPS_SECOND_DEVICE_KEY).catch(() => null)) === true;
  if (!secondDevice) {
    const devices = await count(
      pool,
      `select count(distinct case when tailscale_address is not null then 'tailnet:' || tailscale_address
                                  when scope = 'local' then 'local' else 'via:' || via end)::int as n
         from core.dashboard_sessions where client = 'browser'`,
    );
    if (devices >= 2) {
      secondDevice = true;
      await settings.write(TIPS_SECOND_DEVICE_KEY, true).catch(() => {});
    }
  }

  return {
    daysSinceInstall,
    firstRun,
    agents: roster.length,
    agentIds,
    groups: await count(pool, `select count(*)::int as n from core.groups where archived_at is null`),
    plugins,
    mailboxSet: plugins.has('email') ? await deps.mailboxSet().catch(() => false) : false,
    mailAgent: agentIds.has(MAIL_AGENT_ID),
    speechInstalled: plugins.has('speech'),
    voiceUsed: recorded > 0 || [...toolsUsed].some((t) => t.startsWith('speech.')),
    missions: await count(pool, `select count(*)::int as n from core.missions`),
    telegramPaired:
      (await count(pool, `select count(*)::int as n from core.surface_identities where surface = 'telegram'`)) > 0,
    browserUsed: [...toolsUsed].some((t) => t.startsWith('browser.')),
    toolsUsed,
    pagesVisited: new Set(Object.keys(await readPagesSeen(webSettingsStore(pool)))),
    needsSetup: (await deps.needsSetup?.().catch(() => [])) ?? [],
    pinSet: (await count(pool, `select count(*)::int as n from core.web_settings where key = 'lock.pin'`)) > 0,
    secondDevice,
    financeConnected: plugins.has('finance') && (await count(pool, `select count(*)::int as n from finance.accounts`)) > 0,
  };
}
