import path from 'node:path';
import { z } from 'zod';

/**
 * Where agents may look (docs/browser.md, "Routes").
 *
 * The owner no longer picks a mode. Three routes exist and the runtime picks
 * one per task: buddi's own browser (always allowed), the owner's Chrome
 * through the extension (allowed or not), and the owner's apps, a route only
 * a plugin provides (`@withbuddi/plugin-computer`, which keeps the list of
 * apps in its own settings). Settings are permissions, not a choice.
 */
export const ROUTE_KINDS = ['own', 'chrome', 'apps'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
/** A pin: a route to prefer, or `auto` for the runtime's own choice. */
export const PIN_VALUES = ['auto', 'own', 'chrome', 'apps'] as const;
export type RoutePin = (typeof PIN_VALUES)[number];

const host = z.string().trim().toLowerCase().min(3).max(253).regex(/^[a-z0-9.-]+$/, 'a site is a host name, like amazon.com');
/** What computer control kept here before it was a plugin; read past, never written again. */
const LEGACY_APP_KEYS = ['browserApp', 'allowedApps', 'browserProfile'] as const;
const withoutLegacy = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  for (const key of LEGACY_APP_KEYS) delete copy[key];
  return copy;
};

export const settingsSchema = z.object({
  version: z.literal(2).default(2),
  /** The owner's Chrome may be used, for sites that need their sign-in. A dead switch until paired. */
  yourChrome: z.boolean().default(false),
  /**
   * The owner's apps, when a plugin provides the route: off, ask for each app
   * every time, or on (the plugin's list opens without asking; others as the
   * plugin says). Kept while no plugin provides it, so installing one later
   * brings back what the owner had chosen.
   */
  yourApps: z.enum(['off', 'ask', 'on']).default('off'),
  /** "Sites that need my sign-in": always the owner's Chrome when it is allowed and connected. */
  signInSites: z.array(host).max(200).default([]),
  /** The global pin. `auto` is the runtime's choice; a pin narrows, it never allows a route the switches forbid. */
  defaultRoute: z.enum(PIN_VALUES).default('auto'),
  /** How long a global Stop holds, in minutes. 0 is "until I say". */
  stopExpiryMinutes: z.number().int().min(0).max(7 * 24 * 60).default(60),
  /** Own-browser pages open at once; one more waits its turn. */
  maxOwnPages: z.number().int().min(1).max(8).default(3),
  /** Show the own browser's window on this machine instead of running headless. */
  showWindow: z.boolean().default(false),
  /**
   * How long a mission run waits for the owner's answer on a browser card
   * (Look? / Keep going? / Sign in / Human check) before it ends as "needed
   * you", in minutes (docs/browser.md, "Missions").
   */
  missionWaitMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /**
   * The folder the owner's Chrome saves downloads to, when it is not
   * `~/Downloads`: an agent's download in the owner's Chrome is read only from
   * inside it (docs/browser.md, "Downloads"). Absolute, or starting with `~/`.
   */
  downloadsFolder: z.preprocess((value) => (value === null || value === '' ? undefined : value), z.string().trim().min(1).max(1024)
    .refine((folder) => path.isAbsolute(folder) || folder === '~' || folder.startsWith('~/'), 'a folder is an absolute path, like ~/Downloads')
    .optional()),
}).strict();
export type ControlSettings = z.infer<typeof settingsSchema>;

/** The settings before routes: one mode the owner picked. */
const legacySchema = z.object({
  mode: z.enum(['computer', 'playwright', 'extension']).default('playwright'),
}).passthrough();

/** What the migration needs to know about this machine. */
export interface MigrationFacts {
  /** A Chrome pairing record exists. */
  paired: boolean;
}

/**
 * Read a `settings.json` of either shape into routes.
 *
 * The old `{mode}`: `extension` → your Chrome on, apps off; `computer` → your
 * Chrome on when a pairing exists, apps on (served once the Computer plugin
 * is installed; until then Home says so once); `playwright` → your Chrome on
 * when a pairing exists, apps off. Nobody loses a route he had set up, nobody
 * gains apps he had not. The own browser is always allowed and has no switch.
 * The apps list computer control kept here (`allowedApps`, `browserApp`,
 * `browserProfile`) is dropped: it lives in the plugin's settings now. A v2
 * file that still carries it is rewritten without it.
 */
export function migrateSettings(raw: unknown, facts: MigrationFacts): { settings: ControlSettings; migrated: boolean } {
  if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 2) {
    const legacyKeys = LEGACY_APP_KEYS.some((key) => key in (raw as Record<string, unknown>));
    return { settings: settingsSchema.parse(withoutLegacy(raw)), migrated: legacyKeys };
  }
  const legacy = legacySchema.parse(raw ?? {});
  const yourChrome = legacy.mode === 'extension' ? true : facts.paired;
  const yourApps = legacy.mode === 'computer' ? 'on' as const : 'off' as const;
  return { settings: settingsSchema.parse({ version: 2, yourChrome, yourApps }), migrated: true };
}

/** A partial change from the dashboard, merged over what is stored. */
export function applySettingsChange(current: ControlSettings, change: unknown): ControlSettings {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Expected an object of settings to change.');
  const { version: _version, ...rest } = withoutLegacy(change) as Record<string, unknown>;
  return settingsSchema.parse({ ...current, ...rest, version: 2 });
}
