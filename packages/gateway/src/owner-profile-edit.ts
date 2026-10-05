/**
 * One way to change the owner's profile, whoever asks (docs/agents.md, "What
 * every agent is told about you").
 *
 * Settings → Profile (`POST /api/owner`), the agents' `owner.set_profile` and
 * MCP's `buddi.profile_update` all check a change here, with the same limits
 * and the same sentences, so a field the page refuses is refused everywhere.
 * Places go through the same geocoder road the page's Find button uses
 * (`web/places.ts`): the address is the owner's, the town, its coordinates and
 * its zone are what the geocoder matched.
 *
 * `profileGaps` is the other half: which useful fields are still empty, each
 * with the one reason it is worth asking for. It reads; it never asks.
 */
import {
  OWNER_DATE_FORMATS,
  OWNER_TIME_FORMATS,
  PLACE_ADDRESS_MAX,
  PLACE_LABEL_MAX,
  PlaceRefusal,
  findPlaces,
  foundPlaceName,
  getOwnerProfile,
  isKnownTimezone,
  listOwnerPlaces,
  removeOwnerPlace,
  saveOwnerPlace,
  saveOwnerProfile,
  validDayMonth,
  type HttpArea,
  type OwnerPlace,
  type OwnerProfile,
  type OwnerProfilePatch,
} from '@buddi/core';
import type { Pool } from 'pg';
import { datesChanged } from './missions/dates.js';
import { placesGeocoder } from './web/places.js';

/* ------------------------------------------------------------------ *
 * The profile fields
 * ------------------------------------------------------------------ */

/** The text fields Settings → Profile writes, with its limits. */
export const PROFILE_TEXT_LIMITS = {
  preferredName: 80,
  fullName: 120,
  pronouns: 40,
  timezone: 80,
  language: 80,
  about: 1000,
} as const;
export type ProfileTextField = keyof typeof PROFILE_TEXT_LIMITS;
export const PROFILE_TEXT_FIELDS = Object.keys(PROFILE_TEXT_LIMITS) as ProfileTextField[];

/** Every field a change may name, places aside. */
export const PROFILE_FIELDS = [
  'preferredName', 'fullName', 'pronouns', 'timezone', 'language', 'about', 'birthday', 'timeFormat', 'dateFormat',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const TOO_LONG: Record<ProfileTextField, string> = {
  preferredName: 'The name is too long (80 characters at most).',
  fullName: 'The full name is too long (120 characters at most).',
  pronouns: 'Keep the pronouns under 40 characters.',
  timezone: 'That timezone name is too long.',
  language: 'Keep the language under 80 characters.',
  about: 'Keep the line about you under 1,000 characters.',
};

export type CheckedProfile = { ok: true; patch: OwnerProfilePatch } | { ok: false; error: string };

/**
 * A profile change as Settings → Profile sends it, checked: each text field a
 * string or null (null clears it), the zone one this host knows, the formats
 * one of the words or null (Auto), the birthday a real day or null. What is
 * left out stays. The sentence on a refusal is the page's own.
 */
export function checkProfilePatch(body: Record<string, unknown>): CheckedProfile {
  const patch: OwnerProfilePatch = {};
  for (const key of PROFILE_TEXT_FIELDS) {
    const given = body[key];
    if (given === undefined) continue;
    if (given !== null && typeof given !== 'string') return { ok: false, error: `\`${key}\` must be a string or null` };
    patch[key] = given as string | null;
  }
  // How times and dates read: a known word, or null for Auto.
  if (body.timeFormat !== undefined) {
    if (body.timeFormat !== null && !(OWNER_TIME_FORMATS as readonly unknown[]).includes(body.timeFormat)) return { ok: false, error: '`timeFormat` is 12h, 24h or null (Auto).' };
    patch.timeFormat = body.timeFormat as OwnerProfilePatch['timeFormat'];
  }
  if (body.dateFormat !== undefined) {
    if (body.dateFormat !== null && !(OWNER_DATE_FORMATS as readonly unknown[]).includes(body.dateFormat)) return { ok: false, error: '`dateFormat` is short, long, iso or null (Auto).' };
    patch.dateFormat = body.dateFormat as OwnerProfilePatch['dateFormat'];
  }
  if (patch.timezone && !isKnownTimezone(patch.timezone)) return { ok: false, error: `"${patch.timezone}" is not a timezone this host knows.` };
  for (const key of PROFILE_TEXT_FIELDS) {
    const value = patch[key];
    if (typeof value === 'string' && value.trim().length > PROFILE_TEXT_LIMITS[key]) return { ok: false, error: TOO_LONG[key] };
  }
  // The birthday: day and month (the year optional), or null to clear it.
  if (body.birthday !== undefined) {
    if (body.birthday === null) patch.birthday = null;
    else {
      const birthday = typeof body.birthday === 'object' ? validDayMonth(body.birthday as Record<string, unknown>) : null;
      if (!birthday) return { ok: false, error: 'The birthday needs a real day and month; the year is optional.' };
      patch.birthday = birthday;
    }
  }
  return { ok: true, patch };
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

/** A place as the owner says it: what they call it and where it is. */
export interface PlaceEdit {
  label: string;
  address: string;
}

export type CheckedPlaces =
  | { ok: true; places: PlaceEdit[]; remove: string[] }
  | { ok: false; error: string };

/** The page's limits on a place, before anything is looked up. */
export function checkPlaceEdits(places: readonly PlaceEdit[] = [], remove: readonly string[] = []): CheckedPlaces {
  const clean = (text: string): string => text.trim().replace(/\s+/g, ' ');
  const out: PlaceEdit[] = [];
  for (const place of places) {
    const label = clean(String(place?.label ?? ''));
    const address = clean(String(place?.address ?? ''));
    if (label === '') return { ok: false, error: 'Give the place a name, like Home or Work.' };
    if (label.length > PLACE_LABEL_MAX) return { ok: false, error: `Keep the place's name under ${PLACE_LABEL_MAX} characters.` };
    if (address.length < 2) return { ok: false, error: `Say where ${label} is: an address or a town.` };
    if (address.length > PLACE_ADDRESS_MAX) return { ok: false, error: 'Keep the address under 200 characters.' };
    if (out.some((p) => p.label.toLowerCase() === label.toLowerCase())) return { ok: false, error: `${label} is named twice.` };
    out.push({ label, address });
  }
  const gone = remove.map((label) => clean(String(label))).filter((label) => label !== '');
  if (gone.some((label) => out.some((p) => p.label.toLowerCase() === label.toLowerCase()))) {
    return { ok: false, error: 'A place cannot be saved and removed at once.' };
  }
  return { ok: true, places: out, remove: gone };
}

/** One place saved: the owner's words and what the geocoder matched them to. */
export interface SavedPlace {
  label: string;
  address: string;
  /** "Lyon, Auvergne-Rhône-Alpes, France". */
  matched: string;
  timezone: string | null;
  /** The other towns the address could have meant, so the owner can correct it. */
  otherMatches: string[];
}

export interface PlacesOutcome {
  saved: SavedPlace[];
  notSaved: Array<{ label: string; reason: string }>;
  removed: string[];
  notFound: string[];
}

export interface PlacesDepsLite {
  pool: Pool;
  log: (line: string) => void;
  /** The geocoder's road; a test hands in a stub. */
  http?: HttpArea;
}

/**
 * Save and remove places as the page would: find each address (the best match
 * is taken, the others reported), keep the place's zone when the host knows
 * it, change a place already called that rather than adding a second one.
 * One place the finder cannot match does not stop the others.
 */
export async function applyPlaceEdits(deps: PlacesDepsLite, places: readonly PlaceEdit[], remove: readonly string[]): Promise<PlacesOutcome> {
  const outcome: PlacesOutcome = { saved: [], notSaved: [], removed: [], notFound: [] };
  const geocoder = placesGeocoder(deps.log, deps.http);
  for (const place of places) {
    let found;
    try {
      found = await findPlaces(geocoder, place.address);
    } catch (err) {
      deps.log(`places: finding "${place.address.slice(0, 40)}" failed: ${err instanceof Error ? err.message : String(err)}`);
      outcome.notSaved.push({ label: place.label, reason: 'The place finder did not answer. Try again in a while.' });
      continue;
    }
    const best = found[0];
    if (!best) {
      outcome.notSaved.push({ label: place.label, reason: `Nothing matched "${place.address}". Ask for the town, or the town and the country.` });
      continue;
    }
    const timezone = best.timezone && isKnownTimezone(best.timezone) ? best.timezone : null;
    const existing = (await listOwnerPlaces(deps.pool)).find((p) => p.label.toLowerCase() === place.label.toLowerCase());
    try {
      await saveOwnerPlace(deps.pool, {
        ...(existing ? { id: existing.id } : {}),
        label: existing?.label ?? place.label,
        address: place.address,
        name: foundPlaceName(best),
        latitude: best.latitude,
        longitude: best.longitude,
        timezone,
      });
    } catch (err) {
      if (err instanceof PlaceRefusal) {
        outcome.notSaved.push({ label: place.label, reason: err.message });
        continue;
      }
      throw err;
    }
    outcome.saved.push({
      label: existing?.label ?? place.label,
      address: place.address,
      matched: foundPlaceName(best),
      timezone,
      otherMatches: found.slice(1, 4).map(foundPlaceName),
    });
  }
  for (const label of remove) {
    const existing = (await listOwnerPlaces(deps.pool)).find((p) => p.label.toLowerCase() === label.toLowerCase());
    const removed = existing ? await removeOwnerPlace(deps.pool, existing.id) : null;
    if (removed) outcome.removed.push(removed.label);
    else outcome.notFound.push(label);
  }
  return outcome;
}

/* ------------------------------------------------------------------ *
 * The whole change
 * ------------------------------------------------------------------ */

export interface ProfileEdit {
  patch: OwnerProfilePatch;
  places: PlaceEdit[];
  remove: string[];
}

export interface ProfileEditDeps extends PlacesDepsLite {
  env?: NodeJS.ProcessEnv;
}

export interface ProfileEditOutcome {
  profile: OwnerProfile;
  places: OwnerPlace[];
  placeChanges?: PlacesOutcome;
  zoneChange?: { from: string; to: string; missions: string[] };
}

/**
 * Write a checked change: the profile (the zone applies at once and the
 * schedules that follow it move), the birthday greeting's day, then the
 * places. Every agent reads the result at its next turn.
 */
export async function applyProfileEdit(deps: ProfileEditDeps, edit: ProfileEdit): Promise<ProfileEditOutcome> {
  const touched = Object.keys(edit.patch).length > 0;
  const saved = touched
    ? await saveOwnerProfile(deps.pool, edit.patch, deps.env ?? process.env)
    : { profile: await getOwnerProfile(deps.pool) };
  if (edit.patch.birthday !== undefined) await datesChanged();
  const placeChanges = edit.places.length > 0 || edit.remove.length > 0
    ? await applyPlaceEdits(deps, edit.places, edit.remove)
    : undefined;
  return {
    profile: saved.profile,
    places: await listOwnerPlaces(deps.pool).catch(() => []),
    ...(placeChanges ? { placeChanges } : {}),
    ...('zoneChange' in saved && saved.zoneChange ? { zoneChange: saved.zoneChange } : {}),
  };
}

/** The change in a few plain lines, for an approval card. */
export function describeProfileEdit(edit: ProfileEdit): string[] {
  const lines: string[] = [];
  const name: Record<ProfileField, string> = {
    preferredName: 'Name to use', fullName: 'Full name', pronouns: 'Pronouns', timezone: 'Timezone',
    language: 'Language', about: 'About you', birthday: 'Birthday', timeFormat: 'Time format', dateFormat: 'Date format',
  };
  for (const field of PROFILE_FIELDS) {
    const value = edit.patch[field as keyof OwnerProfilePatch];
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${name[field]}: ${field === 'timeFormat' || field === 'dateFormat' ? 'Auto' : 'cleared'}`);
    } else if (field === 'birthday') {
      const b = value as { day: number; month: number; year: number | null };
      lines.push(`${name[field]}: ${b.day}/${b.month}${b.year ? `/${b.year}` : ''} (day/month)`);
    } else {
      lines.push(`${name[field]}: ${String(value)}`);
    }
  }
  for (const place of edit.places) lines.push(`Place ${place.label}: ${place.address} (looked up on approval)`);
  for (const label of edit.remove) lines.push(`Remove the place ${label}`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * What is missing
 * ------------------------------------------------------------------ */

/**
 * The fields worth asking for, in the order they matter, each with its one
 * line. Pronouns and the language are not here on purpose: they are recorded
 * when the owner offers them, never asked for.
 */
export const PROFILE_GAP_REASONS: ReadonlyArray<{ field: string; why: string }> = [
  { field: 'preferredName', why: 'what every agent calls you' },
  { field: 'timezone', why: 'what "today", reminders and schedules mean' },
  { field: 'fullName', why: 'letters, forms and bookings' },
  { field: 'places.home', why: '"how long to get home?", the weather at home, nearby suggestions' },
  { field: 'places.work', why: '"how long to work?" and the weather at work' },
  { field: 'birthday', why: 'your team greets you on the day' },
  { field: 'timeFormat', why: 'times written the way you read them (2:05 PM or 14:05)' },
  { field: 'dateFormat', why: 'dates written the way you read them (Thu, Oct 1; Thursday, 1 October; or 2026-10-01)' },
  { field: 'about', why: 'how you like answers and what you do, for every agent' },
];

/** The memory preferences the "knowing you" nudge keeps its record in. */
export const ASKED_PREFERENCE = 'knowing_you_asked';
export const DONT_ASK_PREFERENCE = 'knowing_you_dont_ask';
/** At most one "knowing you" question a week. */
export const NUDGE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProfileGap {
  field: string;
  why: string;
  /** Asked before in a "knowing you" question: never asked that way again. */
  asked: boolean;
  /** The owner said not to ask about it. */
  declined: boolean;
}

export interface ProfileGaps {
  gaps: ProfileGap[];
  /** The one field a "knowing you" question may ask now, or null. */
  nudge: { field: string; why: string } | null;
  lastAskedAt: string | null;
}

/** Which known field names a free-text preference value mentions. */
export function fieldsIn(value: string | null | undefined): Set<string> {
  const text = (value ?? '').toLowerCase();
  const out = new Set<string>();
  for (const { field } of PROFILE_GAP_REASONS) {
    // "places.work", or "work" alone; "fullName" as a word, never inside another.
    const word = field.toLowerCase().replace(/^places\./, '');
    if (new RegExp(`(?:^|[^a-z.])(?:places\\.)?${word}(?![a-z])`).test(text)) out.add(field);
  }
  if (/\b(?:all|everything)\b/.test(text)) for (const { field } of PROFILE_GAP_REASONS) out.add(field);
  return out;
}

/**
 * The empty useful fields, with whether each was asked before or declined,
 * and the one a weekly "knowing you" question may ask now.
 */
export function profileGaps(
  profile: OwnerProfile,
  places: readonly OwnerPlace[],
  record: { asked?: string | null; askedAt?: Date | null; dontAsk?: string | null } = {},
  now: Date = new Date(),
): ProfileGaps {
  const has = (label: string): boolean => places.some((p) => p.label.toLowerCase() === label);
  const empty = (field: string): boolean => {
    switch (field) {
      case 'places.home': return !has('home');
      case 'places.work': return !has('work');
      case 'birthday': return profile.birthday === null;
      default: return (profile as unknown as Record<string, unknown>)[field] === null;
    }
  };
  const asked = fieldsIn(record.asked);
  const declined = fieldsIn(record.dontAsk);
  const gaps = PROFILE_GAP_REASONS.filter(({ field }) => empty(field)).map(({ field, why }) => ({
    field,
    why,
    asked: asked.has(field),
    declined: declined.has(field),
  }));
  const due = !record.askedAt || now.getTime() - record.askedAt.getTime() >= NUDGE_EVERY_MS;
  const next = due ? gaps.find((g) => !g.asked && !g.declined) : undefined;
  return {
    gaps,
    nudge: next ? { field: next.field, why: next.why } : null,
    lastAskedAt: record.askedAt ? record.askedAt.toISOString() : null,
  };
}
