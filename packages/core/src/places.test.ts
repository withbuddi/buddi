/**
 * Finding a place from an address, on a stubbed geocoder: the address taken
 * apart, each part asked for, the answers ranked by what else the address
 * says, and the town's zone carried through.
 */
import { describe, expect, it } from 'vitest';
import type { HttpArea, HttpRequest, HttpResponse } from './host/types.js';
import { addressParts, findPlaces, foundPlaceName, placeSlug } from './places.js';

const RESULTS: Record<string, unknown[]> = {
  portland: [
    { name: 'Portland', latitude: 45.52, longitude: -122.68, timezone: 'America/Los_Angeles', admin1: 'Oregon', country: 'United States' },
    { name: 'Portland', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York', admin1: 'Maine', country: 'United States' },
  ],
  maine: [],
  paris: [{ name: 'Paris', latitude: 48.85, longitude: 2.35, timezone: 'Europe/Paris', admin1: 'Île-de-France', country: 'France' }],
  france: [],
  'rue de rivoli': [],
};

function stub(): HttpArea & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async request(req: HttpRequest): Promise<HttpResponse> {
      const url = new URL(req.url);
      expect(url.hostname).toBe('geocoding-api.open-meteo.com');
      const name = url.searchParams.get('name') ?? '';
      asked.push(name);
      const results = RESULTS[name.toLowerCase()] ?? [];
      return { ok: true, status: 200, headers: {}, json: async () => ({ results }), text: async () => '' } as unknown as HttpResponse;
    },
  };
}

describe('places', () => {
  it('take an address apart at its commas, leaving numbers behind', () => {
    expect(addressParts('12 rue de Rivoli, 75001 Paris, France')).toEqual(['rue de Rivoli', 'Paris', 'France']);
    expect(addressParts('Lyon')).toEqual(['Lyon']);
    expect(addressParts('  ')).toEqual([]);
  });

  it('prefer the town the rest of the address agrees with', async () => {
    const http = stub();
    const found = await findPlaces(http, 'Portland, Maine');
    expect(found[0]).toMatchObject({ admin1: 'Maine', timezone: 'America/New_York' });
    expect(http.asked).toEqual(['Portland', 'Maine']);
  });

  it('find the town in a street address, with its zone', async () => {
    const found = await findPlaces(stub(), '12 rue de Rivoli, 75001 Paris, France');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'Paris', timezone: 'Europe/Paris' });
    expect(foundPlaceName(found[0]!)).toBe('Paris, Île-de-France, France');
  });

  it('answer nothing for nothing, and slug labels', async () => {
    expect(await findPlaces(stub(), 'Nowhere at all')).toEqual([]);
    expect(placeSlug("Mum's")).toBe('mum-s');
    expect(placeSlug('École')).toBe('ecole');
  });
});
