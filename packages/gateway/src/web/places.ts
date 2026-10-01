/**
 * The owner's places on Settings → Profile (docs/dashboard.md, Profile).
 *
 *   POST /api/owner/places/find    { address }            → { found: [{ name, latitude, longitude, timezone? }] }
 *   POST /api/owner/places         { id?, label, address, name, latitude, longitude, timezone? } → { place, places }
 *   POST /api/owner/places/remove  { id }                 → { places }
 *
 * Finding goes to Open-Meteo's geocoder through core's own `http` area (the
 * address guard in front of it, the town's coordinates back); saving and
 * removing are core's (`places.ts`). `GET /api/owner` carries the list.
 */
import {
  GEOCODER_HOST,
  PlaceRefusal,
  createHttpArea,
  findPlaces,
  foundPlaceName,
  isKnownTimezone,
  listOwnerPlaces,
  removeOwnerPlace,
  saveOwnerPlace,
  type HttpArea,
  type OwnerPlace,
} from '@buddi/core';
import { createHttpTransport } from '@buddi/runtime';
import type { Pool } from 'pg';

export interface PlacesDeps {
  pool: Pool;
  log: (line: string) => void;
  /** The geocoder's road; a test hands in a stub. */
  http?: HttpArea;
}

export interface PlacesReply {
  status: number;
  body: unknown;
}

let shared: HttpArea | undefined;
function geocoder(deps: PlacesDeps): HttpArea {
  if (deps.http) return deps.http;
  shared ??= createHttpArea({ plugin: 'places', network: [GEOCODER_HOST], log: deps.log, transport: createHttpTransport });
  return shared;
}

/** The list, as the page draws it. A database not yet migrated answers none. */
export async function placesList(pool: Pool): Promise<OwnerPlace[]> {
  try {
    return await listOwnerPlaces(pool);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') return [];
    throw err;
  }
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

export async function placesRoute(deps: PlacesDeps, path: string, body: Record<string, unknown>): Promise<PlacesReply | undefined> {
  if (path === '/api/owner/places/find') {
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (address.length < 2) return { status: 400, body: { error: 'Type an address or a town first.' } };
    if (address.length > 200) return { status: 400, body: { error: 'Keep the address under 200 characters.' } };
    try {
      const found = await findPlaces(geocoder(deps), address);
      return {
        status: 200,
        body: {
          found: found.map((place) => ({
            name: foundPlaceName(place),
            latitude: place.latitude,
            longitude: place.longitude,
            ...(place.timezone ? { timezone: place.timezone } : {}),
          })),
        },
      };
    } catch (err) {
      deps.log(`places: finding "${address.slice(0, 40)}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 502, body: { error: 'The place finder did not answer. Check the connection and try again.' } };
    }
  }

  if (path === '/api/owner/places') {
    const timezone = typeof body.timezone === 'string' && body.timezone.trim() !== '' ? body.timezone.trim() : null;
    if (timezone !== null && !isKnownTimezone(timezone)) return { status: 400, body: { error: `"${timezone}" is not a timezone this host knows.` } };
    try {
      const place = await saveOwnerPlace(deps.pool, {
        ...(typeof body.id === 'string' && body.id !== '' ? { id: body.id } : {}),
        label: typeof body.label === 'string' ? body.label : '',
        address: typeof body.address === 'string' ? body.address : null,
        name: typeof body.name === 'string' ? body.name : '',
        latitude: num(body.latitude),
        longitude: num(body.longitude),
        timezone,
      });
      return { status: 200, body: { place, places: await placesList(deps.pool) } };
    } catch (err) {
      if (err instanceof PlaceRefusal) return { status: 400, body: { error: err.message } };
      throw err;
    }
  }

  if (path === '/api/owner/places/remove') {
    const id = typeof body.id === 'string' ? body.id : '';
    const removed = id === '' ? null : await removeOwnerPlace(deps.pool, id);
    if (!removed) return { status: 404, body: { error: 'That place is not saved.' } };
    return { status: 200, body: { removed, places: await placesList(deps.pool) } };
  }

  return undefined;
}
