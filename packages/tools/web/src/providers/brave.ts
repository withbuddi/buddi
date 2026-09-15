/**
 * Brave Search — the second backend, and the proof that the seam is real.
 *
 * It exists for two reasons. The first is that Brave runs its own index rather
 * than resold results, which is a genuinely different answer to the same
 * question and the owner may prefer it. The second is structural: a port with
 * one implementation is a guess about what a port needs. Writing the second one
 * is what showed that `SearchProvider` needed a `host` (the manifest declares
 * where it talks) and a `signupUrl` (the doctor has to say where a key comes
 * from) rather than just a `search`.
 *
 * It is not the default because its free plan asks for a credit card, and
 * signing the owner up for anything is not this task's to do.
 *
 * `BUDDI_SEARCH_PROVIDER=brave` plus `BRAVE_SEARCH_API_KEY` is the whole switch.
 */
import type { SearchProvider, SearchHit, SearchQuery, SearchDeps, SearchResult } from '../ports.js';

export const BRAVE_HOST = 'api.search.brave.com';
export const BRAVE_KEY_NAME = 'BRAVE_SEARCH_API_KEY';

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
      page_age?: unknown;
      age?: unknown;
    }>;
  };
}

/** Brave's freshness codes: a day, a week, a month, a year. */
function freshness(withinDays: number): string | undefined {
  if (withinDays <= 1) return 'pd';
  if (withinDays <= 7) return 'pw';
  if (withinDays <= 31) return 'pm';
  if (withinDays <= 366) return 'py';
  return undefined;
}

export const brave: SearchProvider = {
  id: 'brave',
  label: 'Brave Search',
  keyName: BRAVE_KEY_NAME,
  host: BRAVE_HOST,
  signupUrl: 'https://api-dashboard.search.brave.com',

  async search(query: SearchQuery, deps: SearchDeps): Promise<SearchResult> {
    const url = new URL(`https://${BRAVE_HOST}/res/v1/web/search`);
    url.searchParams.set('q', query.site ? `${query.query} site:${query.site}` : query.query);
    // Brave caps a page at 20; the tool caps its own input well below that.
    url.searchParams.set('count', String(Math.min(query.limit, 20)));
    if (query.region !== undefined) url.searchParams.set('country', query.region.toUpperCase());
    if (query.withinDays !== undefined) {
      const f = freshness(query.withinDays);
      if (f !== undefined) url.searchParams.set('freshness', f);
    }

    const response = await deps.fetch({
      url: url.toString(),
      method: 'GET',
      headers: { accept: 'application/json', 'x-subscription-token': deps.key },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          failure: {
            code: 'bad-key',
            message: `Brave rejected the subscription token (HTTP ${response.status}). The key in ${BRAVE_KEY_NAME} is missing, wrong or revoked.`,
          },
        };
      }
      if (response.status === 429) {
        return {
          ok: false,
          failure: { code: 'quota', message: 'Brave says this account is over its rate or quota limit.' },
        };
      }
      if (response.status === 0) {
        return { ok: false, failure: { code: 'unreachable', message: response.body } };
      }
      return {
        ok: false,
        failure: { code: 'provider-error', message: `Brave answered HTTP ${response.status}.` },
      };
    }

    let parsed: BraveResponse;
    try {
      parsed = JSON.parse(response.body) as BraveResponse;
    } catch {
      return {
        ok: false,
        failure: { code: 'provider-error', message: 'Brave answered something that was not JSON.' },
      };
    }

    const hits: SearchHit[] = [];
    for (const raw of parsed.web?.results ?? []) {
      const link = typeof raw.url === 'string' ? raw.url : '';
      if (link === '') continue;
      let host: string;
      try {
        host = new URL(link).host;
      } catch {
        continue;
      }
      const age = typeof raw.page_age === 'string' ? raw.page_age : undefined;
      const published = age === undefined ? undefined : isoDay(age);
      hits.push({
        rank: hits.length + 1,
        title: text(raw.title, 200) || host,
        url: link,
        source: host,
        snippet: text(raw.description, 600),
        ...(published === undefined ? {} : { published }),
      });
    }
    return { ok: true, hits };
  },
};

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Brave marks query terms with <strong> in descriptions; it is markup, not
  // prose, and it must not reach the model looking like structure it wrote.
  const collapsed = value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed;
}

function isoDay(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}
