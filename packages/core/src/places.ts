/**
 * The owner's places: Home, Work and any other they name, beside the timezone
 * (docs/dashboard.md, Settings → Profile).
 *
 * Each is a label, the address as the owner typed it, what the geocoder
 * matched it to (a town, its region and country), the coordinates and the
 * place's own zone. Stored in `core.owner_places`; written only by the owner
 * (the Profile page), read by agents' context and by plugins that declare
 * `owner:places` (`ctx.buddi.owner.places()`, host API 1.18).
 *
 * Finding a place goes to Open-Meteo's geocoder, which needs no key and is
 * what the weather plugin already uses. It searches place names, not street
 * addresses, so an address is taken apart at its commas and each part is
 * asked for; the answers are ranked by how many of the other parts they
 * agree with ("Portland, Maine" prefers the Portland whose region is Maine).
 * The coordinates are the town's: the street stays on this machine.
 */
import type { HttpArea } from './host/types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export const GEOCODER_HOST = 'geocoding-api.open-meteo.com';
export const GEOCODER_URL = `https://${GEOCODER_HOST}/v1/search`;
export const GEOCODE_TIMEOUT_MS = 8_000;

/** The labels the Profile page suggests before the owner has them. */
export const SUGGESTED_PLACES = ['Home', 'Work'] as const;
export const PLACE_LABEL_MAX = 40;
export const PLACE_ADDRESS_MAX = 200;
export const PLACES_MAX = 20;

/** One of the owner's places, as core keeps it and a plugin reads it. */
export interface OwnerPlace {
  /** `home`, `work`, `mums`: the label's slug, stable across renames. */
  id: string;
  label: string;
  /** As the owner typed it; null for a place brought in without one. */
  address: string | null;
  /** What the geocoder matched: "Lyon, Auvergne-Rhône-Alpes, France". */
  name: string;
  latitude: number;
  longitude: number;
  /** The place's own IANA zone, when known. */
  timezone: string | null;
}

/** One answer to a search: a town, where it is and its zone. */
export interface FoundPlace {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  admin1?: string;
  country?: string;
}

export class PlaceRefusal extends Error {
  override readonly name = 'PlaceRefusal';
}

const COLUMNS = 'id, label, address, place_name, latitude, longitude, timezone';

function toPlace(row: Record<string, unknown>): OwnerPlace {
  return {
    id: String(row.id),
    label: String(row.label),
    address: row.address === null || row.address === undefined ? null : String(row.address),
    name: String(row.place_name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezone: row.timezone === null || row.timezone === undefined ? null : String(row.timezone),
  };
}

/** Every place, in the owner's order. A database without the table answers none. */
export async function listOwnerPlaces(db: Queryable): Promise<OwnerPlace[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from core.owner_places order by position, created_at, lower(label)`,
  );
  return rows.map((row) => toPlace(row as Record<string, unknown>));
}

/** `Home` → `home`, `Mum's` → `mum-s`. */
export function placeSlug(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, 40) || 'place';
}

/** "Lyon, Auvergne-Rhône-Alpes, France", without saying a part twice. */
export function foundPlaceName(place: Pick<FoundPlace, 'name' | 'admin1' | 'country'>): string {
  const parts = [place.name, place.admin1, place.country].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.filter((p, i) => parts.indexOf(p) === i).join(', ');
}

export interface PlaceInput {
  /** Present to change that place; absent to add one. */
  id?: string;
  label: string;
  address?: string | null;
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string | null;
}

const clean = (text: string, max: number): string => text.trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Add a place or change one. The label is the owner's own word and unique
 * whatever its case; the id is made from it once and kept through renames.
 */
export async function saveOwnerPlace(db: Queryable, input: PlaceInput): Promise<OwnerPlace> {
  const label = clean(input.label ?? '', PLACE_LABEL_MAX);
  if (label === '') throw new PlaceRefusal('Give the place a name, like Home or Work.');
  const name = clean(input.name ?? '', 200);
  if (name === '') throw new PlaceRefusal('Find the place first, so buddi knows where it is.');
  const { latitude, longitude } = input;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new PlaceRefusal('Those coordinates are not on Earth.');
  }
  const address = input.address === undefined || input.address === null ? null : clean(input.address, PLACE_ADDRESS_MAX) || null;
  const timezone = input.timezone === undefined || input.timezone === null || input.timezone.trim() === '' ? null : input.timezone.trim();
  const places = await listOwnerPlaces(db);
  const clash = places.find((p) => p.label.toLowerCase() === label.toLowerCase() && p.id !== input.id);
  if (clash) throw new PlaceRefusal(`You already have a place called ${clash.label}.`);
  if (input.id !== undefined) {
    const { rows } = await db.query(
      `update core.owner_places
          set label = $2, address = $3, place_name = $4, latitude = $5, longitude = $6, timezone = $7, updated_at = now()
        where id = $1
        returning ${COLUMNS}`,
      [input.id, label, address, name, latitude, longitude, timezone],
    );
    if (!rows[0]) throw new PlaceRefusal('That place is not saved any more.');
    return toPlace(rows[0] as Record<string, unknown>);
  }
  if (places.length >= PLACES_MAX) throw new PlaceRefusal(`${PLACES_MAX} places is the most buddi keeps.`);
  let id = placeSlug(label);
  for (let n = 2; places.some((p) => p.id === id); n += 1) id = `${placeSlug(label)}-${n}`;
  // Home first, then Work, then the rest in the order they were added.
  const suggested = SUGGESTED_PLACES.findIndex((s) => s.toLowerCase() === label.toLowerCase());
  const position = suggested >= 0 ? suggested : SUGGESTED_PLACES.length + places.length;
  const { rows } = await db.query(
    `insert into core.owner_places (id, label, address, place_name, latitude, longitude, timezone, position)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${COLUMNS}`,
    [id, label, address, name, latitude, longitude, timezone, position],
  );
  return toPlace(rows[0] as Record<string, unknown>);
}

export async function removeOwnerPlace(db: Queryable, id: string): Promise<OwnerPlace | null> {
  const { rows } = await db.query(`delete from core.owner_places where id = $1 returning ${COLUMNS}`, [id]);
  return rows[0] ? toPlace(rows[0] as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------------ *
 * Finding a place
 * ------------------------------------------------------------------ */

const fold = (text: string): string =>
  text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The parts of an address worth asking a place-name geocoder about: split at
 * commas and new lines, each without its numbers (a street number, a postcode),
 * at most four, nothing said twice.
 */
export function addressParts(address: string): string[] {
  const parts = address
    .split(/[,\n;]+/)
    .map((part) => part.replace(/\S*\d\S*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 2);
  return parts.filter((p, i) => parts.findIndex((q) => fold(q) === fold(p)) === i).slice(0, 4);
}

/** The geocoder's answer, shaped. Pure. */
export function toFoundPlaces(payload: unknown): FoundPlace[] {
  const results = (payload as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const latitude = typeof r.latitude === 'number' ? r.latitude : Number.NaN;
    const longitude = typeof r.longitude === 'number' ? r.longitude : Number.NaN;
    if (typeof r.name !== 'string' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      name: r.name,
      latitude,
      longitude,
      ...(typeof r.timezone === 'string' ? { timezone: r.timezone } : {}),
      ...(typeof r.admin1 === 'string' ? { admin1: r.admin1 } : {}),
      ...(typeof r.country === 'string' ? { country: r.country } : {}),
    }];
  });
}

async function searchName(http: HttpArea, name: string, signal?: AbortSignal): Promise<FoundPlace[]> {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '10');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  const response = await http.request({
    url: url.toString(),
    headers: { accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    idleTimeoutMs: GEOCODE_TIMEOUT_MS,
    maxBytes: 1_000_000,
  });
  if (!response.ok) throw new Error(`The place finder answered ${response.status}; try again in a while.`);
  return toFoundPlaces(await response.json());
}

/**
 * Up to five towns an address may mean, best first. Each part of the address
 * is asked for; an answer scores for being named exactly what was asked and
 * for each other part its region or country agrees with, and keeps the
 * geocoder's own order (which favours bigger places) between equals.
 */
export async function findPlaces(http: HttpArea, address: string, signal?: AbortSignal): Promise<FoundPlace[]> {
  const parts = addressParts(address);
  if (parts.length === 0) return [];
  const answers = await Promise.all(parts.map((part) => searchName(http, part, signal).catch((err: unknown) => err)));
  if (answers.every((a) => a instanceof Error)) throw answers[0] as Error;
  const folded = parts.map(fold);
  const scored: Array<{ place: FoundPlace; score: number; order: number }> = [];
  answers.forEach((answer, which) => {
    if (answer instanceof Error || !Array.isArray(answer)) return;
    (answer as FoundPlace[]).forEach((place, index) => {
      const context = [place.admin1, place.country].filter((x): x is string => typeof x === 'string').map(fold);
      let score = fold(place.name) === folded[which] ? 3 : 0;
      for (let other = 0; other < folded.length; other += 1) {
        if (other !== which && context.some((c) => c === folded[other] || c.startsWith(`${folded[other]} `))) score += 2;
      }
      scored.push({ place, score, order: which * 100 + index });
    });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const seen = new Set<string>();
  const out: FoundPlace[] = [];
  for (const { place } of scored) {
    const key = `${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
    if (out.length === 5) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Places that used to live in the weather plugin
 * ------------------------------------------------------------------ */

/**
 * Bring the weather plugin's Home and Work into core, once.
 *
 * Before 1.18 the weather plugin kept the owner's places in `weather.place`.
 * Its place marked home (as Home, whatever it was called) and its places
 * called Home or Work move here, keeping a place the owner already has under
 * that label. The import is recorded, so it runs once per installation: a
 * place removed afterwards is not brought back. A database without the
 * weather schema records nothing, so a weather plugin restored later is still
 * read. Answers how many places came in, or null when it had already run or
 * there was nothing to read. The one place core reads a plugin's table, and
 * only this once.
 */
export async function importWeatherPlaces(pool: Queryable): Promise<number | null> {
  const { rows: exists } = await pool.query(`select to_regclass('weather.place') is not null as present`);
  if (exists[0]?.present !== true) return null;
  const { rows: done } = await pool.query(`select 1 from core.owner_place_imports where source = 'weather'`);
  if (done.length > 0) return null;
  const { rows } = await pool.query(
    `select label, name, latitude, longitude, timezone, is_home from weather.place order by is_home desc, created_at`,
  );
  const wanted: Array<{ label: string; row: Record<string, unknown> }> = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const label = String(row.label ?? '').trim();
    const lower = label.toLowerCase();
    const as = lower === 'home' || lower === 'work' ? (lower === 'home' ? 'Home' : 'Work') : row.is_home === true ? 'Home' : undefined;
    if (as === undefined || wanted.some((w) => w.label === as)) continue;
    wanted.push({ label: as, row });
  }
  const { rows: claimed } = await pool.query(
    `insert into core.owner_place_imports (source, imported) values ('weather', $1)
     on conflict (source) do nothing returning source`,
    [wanted.length],
  );
  if (claimed.length === 0) return null;
  let imported = 0;
  for (const { label, row } of wanted) {
    const id = placeSlug(label);
    const { rows: inserted } = await pool.query(
      `insert into core.owner_places (id, label, address, place_name, latitude, longitude, timezone, position)
       select $1, $2, $3, $3, $4, $5, $6, $7
        where not exists (select 1 from core.owner_places where lower(label) = lower($2) or id = $1)
       returning id`,
      [id, label, String(row.name), Number(row.latitude), Number(row.longitude), row.timezone ?? null, label === 'Home' ? 0 : 1],
    );
    imported += inserted.length;
  }
  if (imported !== wanted.length) {
    await pool.query(`update core.owner_place_imports set imported = $1 where source = 'weather'`, [imported]);
  }
  return imported;
}
