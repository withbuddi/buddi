/**
 * Choosing a backend, reading its key, and turning its JSON into evidence.
 *
 * Both providers are exercised against a fake `fetch`, so no key is needed and
 * no socket is opened. What is being checked is the part that actually bites:
 * that a provider's answer is *parsed defensively* — every field in it was
 * ultimately written by whoever owns the page it describes.
 */
import { describe, expect, it } from 'vitest';
import { brave, BRAVE_KEY_NAME } from './providers/brave.js';
import { tavily, TAVILY_KEY_NAME } from './providers/tavily.js';
import { DEFAULT_PROVIDER, PROVIDER_VAR, resolveKey, selectProvider } from './providers/index.js';
import { NATIVE_SEARCH_REPLACES, SEARCH_BACKEND_VAR } from '@buddi/runtime';
import { createSearchTool } from './tools/search.js';
import type { SearchDeps } from './ports.js';

const answering = (status: number, body: unknown): SearchDeps => ({
  key: 'test-key',
  fetch: async (request) => {
    // The key never travels in a query string, where it would end up in logs.
    expect(request.url).not.toContain('test-key');
    return {
      ok: status >= 200 && status < 300,
      status,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      url: request.url,
    };
  },
});

describe('choosing a backend', () => {
  it('defaults to Tavily, which has a free tier that needs no card', () => {
    expect(selectProvider({}).provider.id).toBe('tavily');
    expect(DEFAULT_PROVIDER.keyName).toBe(TAVILY_KEY_NAME);
  });

  it('switches on one environment variable', () => {
    expect(selectProvider({ [PROVIDER_VAR]: 'brave' }).provider.id).toBe('brave');
    expect(selectProvider({ [PROVIDER_VAR]: 'BRAVE' }).provider.id).toBe('brave');
  });

  it('says so when the name is not one it knows, rather than failing silently', () => {
    const { provider, problem } = selectProvider({ [PROVIDER_VAR]: 'braev' });
    expect(provider.id).toBe('tavily');
    expect(problem).toMatch(/braev/);
  });
});

describe('resolving the key', () => {
  it('reads the named variable', () => {
    expect(resolveKey(tavily, { [TAVILY_KEY_NAME]: ' tvly-abc ' })).toEqual({
      configured: true,
      key: 'tvly-abc',
    });
  });

  it('treats a missing key as a configuration fact, with the name in the reason', () => {
    const state = resolveKey(brave, {});
    expect(state.configured).toBe(false);
    if (state.configured) return;
    expect(state.reason).toContain(BRAVE_KEY_NAME);
  });

  it('never mistakes the vault marker for a key', () => {
    // `buddi vault import-env` leaves `NAME=<vault>` behind. A process that
    // sees it has not been hydrated, which is a different problem from a
    // missing key and deserves a different sentence.
    const state = resolveKey(tavily, { [TAVILY_KEY_NAME]: '<vault>' });
    expect(state.configured).toBe(false);
    if (state.configured) return;
    expect(state.reason).toMatch(/never read the vault/);
  });
});

describe('Tavily', () => {
  it('turns results into hits that each carry their own source', async () => {
    const result = await tavily.search(
      { query: 'used ford bronco price new jersey', limit: 3 },
      answering(200, {
        results: [
          {
            title: 'Used Ford Bronco for Sale in NJ',
            url: 'https://www.cars.com/shopping/ford-bronco/nj/',
            content: 'Average listing price $41,500 across 312 listings.',
            published_date: '2026-08-02T00:00:00Z',
          },
          { title: 'no url here' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      rank: 1,
      source: 'www.cars.com',
      published: '2026-08-02',
    });
    expect(result.hits[0]?.snippet).toContain('$41,500');
  });

  it('names the key when the provider rejects it', async () => {
    const result = await tavily.search({ query: 'x', limit: 3 }, answering(401, {}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('bad-key');
    expect(result.failure.message).toContain(TAVILY_KEY_NAME);
  });

  it('distinguishes running out of credits from being broken', async () => {
    const result = await tavily.search({ query: 'x', limit: 3 }, answering(429, {}));
    expect(result.ok && 'x').toBeFalsy();
    if (result.ok) return;
    expect(result.failure.code).toBe('quota');
  });

  it('survives a response that is not the shape it expects', async () => {
    for (const body of ['not json at all', { results: 'a string' }, {}, { results: [{ url: 42 }] }]) {
      const result = await tavily.search({ query: 'x', limit: 3 }, answering(200, body));
      // Either a clean failure or an empty hit list; never a throw.
      if (result.ok) expect(Array.isArray(result.hits)).toBe(true);
      else expect(result.failure.code).toBe('provider-error');
    }
  });
});

describe('Brave', () => {
  it('parses its shape and strips the markup out of its descriptions', async () => {
    const result = await brave.search(
      { query: 'bronco', limit: 2 },
      answering(200, {
        web: {
          results: [
            {
              title: 'Bronco pricing',
              url: 'https://www.edmunds.com/ford/bronco/',
              description: 'The <strong>Bronco</strong> starts at $39,930.',
              page_age: '2026-07-14T12:00:00',
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits[0]?.snippet).toBe('The Bronco starts at $39,930.');
    expect(result.hits[0]?.source).toBe('www.edmunds.com');
    expect(result.hits[0]?.published).toBe('2026-07-14');
  });

  it('sends the key in a header, never in the URL', async () => {
    let sentHeaders: Record<string, string> | undefined;
    await brave.search(
      { query: 'bronco', limit: 2 },
      {
        key: 'secret-token',
        fetch: async (request) => {
          sentHeaders = request.headers;
          return { ok: true, status: 200, body: '{}', url: request.url };
        },
      },
    );
    expect(sentHeaders?.['x-subscription-token']).toBe('secret-token');
  });
});

describe('the third backend: the provider\'s own search', () => {
  it('treats "native" as a real choice rather than a typo', () => {
    const chosen = selectProvider({ BUDDI_SEARCH_PROVIDER: 'native' });
    expect(chosen.native).toBe(true);
    expect(chosen.problem).toBeUndefined();
    // The HTTP backend still comes back beside it: it is the fallback for an
    // agent on a provider that cannot search server-side.
    expect(chosen.provider.id).toBe('tavily');
  });

  it('still reports a typo, and now lists native among the names it knows', () => {
    const chosen = selectProvider({ BUDDI_SEARCH_PROVIDER: 'natiev' });
    expect(chosen.native).toBeUndefined();
    expect(chosen.problem).toContain('natiev');
    expect(chosen.problem).toContain('native');
  });

  it('leaves an explicit tavily choice alone — the override must be able to force it', () => {
    const chosen = selectProvider({ BUDDI_SEARCH_PROVIDER: 'tavily' });
    expect(chosen.native).toBeUndefined();
    expect(chosen.provider.id).toBe('tavily');
  });

  it('names the same tool the runtime withholds when the provider searches itself', () => {
    // The one string the runtime has to know about this plugin. If the tool is
    // ever renamed, this fails here rather than the model quietly being shown
    // two ways to search.
    const search = createSearchTool({ fetcher: {} as never, env: {}, provider: tavily });
    expect(NATIVE_SEARCH_REPLACES).toContain(search.name);
  });

  it('reads BUDDI_SEARCH_PROVIDER through the runtime\'s parser, so there is one meaning of it', () => {
    expect(PROVIDER_VAR).toBe(SEARCH_BACKEND_VAR);
  });
});
