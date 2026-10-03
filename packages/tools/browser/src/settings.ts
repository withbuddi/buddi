import { z } from 'zod';
import { browserApps } from './computer.js';

/**
 * Where agents may look (docs/browser.md, "Routes").
 *
 * The owner no longer picks a mode. Three routes exist and the runtime picks
 * one per task: buddi's own browser (always allowed), the owner's Chrome
 * through the extension (allowed or not), and the owner's apps, a route a
 * plugin may provide (core's computer control provides it today through the
 * same interface). Settings are permissions, not a choice.
 */
export const ROUTE_KINDS = ['own', 'chrome', 'apps'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
/** A pin: a route to prefer, or `auto` for the runtime's own choice. */
export const PIN_VALUES = ['auto', 'own', 'chrome', 'apps'] as const;
export type RoutePin = (typeof PIN_VALUES)[number];

const host = z.string().trim().toLowerCase().min(3).max(253).regex(/^[a-z0-9.-]+$/, 'a site is a host name, like amazon.com');
const appId = z.string().min(3).max(200).regex(/^[A-Za-z0-9.-]+$/);

export const settingsSchema = z.object({
  version: z.literal(2).default(2),
  /** The owner's Chrome may be used, for sites that need their sign-in. A dead switch until paired. */
  yourChrome: z.boolean().default(false),
  /** The owner's apps: off, ask each app every time, or on for the listed apps (others still ask). */
  yourApps: z.enum(['off', 'ask', 'on']).default('off'),
  browserApp: z.enum(browserApps).default('com.google.Chrome'),
  allowedApps: z.array(appId).min(1).max(32).default(['com.google.Chrome', 'com.apple.Safari']),
  browserProfile: z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/).optional(),
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
}).strict().refine((value) => value.allowedApps.includes(value.browserApp), 'The selected browser must also be in allowedApps');
export type ControlSettings = z.infer<typeof settingsSchema>;

/** The settings before routes: one mode the owner picked. */
const legacySchema = z.object({
  mode: z.enum(['computer', 'playwright', 'extension']).default('playwright'),
  browserApp: z.enum(browserApps).default('com.google.Chrome'),
  allowedApps: z.array(appId).min(1).max(32).default(['com.google.Chrome', 'com.apple.Safari']),
  browserProfile: z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/).optional(),
}).passthrough();

/** What the migration needs to know about this machine. */
export interface MigrationFacts {
  /** A Chrome pairing record exists. */
  paired: boolean;
  /** The native computer helper is on disk (macOS). */
  helperPresent: boolean;
}

/**
 * Read a `settings.json` of either shape into routes.
 *
 * The old `{mode}`: `extension` → your Chrome on, apps off; `computer` → your
 * Chrome on when a pairing exists, apps on when the helper is there;
 * `playwright` → your Chrome on when a pairing exists, apps off. Nobody loses
 * a route he had set up, nobody gains apps he had not. The own browser is
 * always allowed and has no switch.
 */
export function migrateSettings(raw: unknown, facts: MigrationFacts): { settings: ControlSettings; migrated: boolean } {
  if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 2) {
    return { settings: settingsSchema.parse(raw), migrated: false };
  }
  const legacy = legacySchema.parse(raw ?? {});
  const yourChrome = legacy.mode === 'extension' ? true : facts.paired;
  const yourApps = legacy.mode === 'computer' && facts.helperPresent ? 'on' as const : 'off' as const;
  const settings = settingsSchema.parse({
    version: 2, yourChrome, yourApps,
    browserApp: legacy.browserApp, allowedApps: legacy.allowedApps,
    ...(legacy.browserProfile ? { browserProfile: legacy.browserProfile } : {}),
  });
  return { settings, migrated: true };
}

/** A partial change from the dashboard, merged over what is stored. */
export function applySettingsChange(current: ControlSettings, change: unknown): ControlSettings {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Expected an object of settings to change.');
  const { version: _version, ...rest } = change as Record<string, unknown>;
  return settingsSchema.parse({ ...current, ...rest, version: 2 });
}
