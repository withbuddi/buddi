/**
 * Tavily — the default search backend.
 *
 * ## Why this one
 *
 *  - **A free tier that costs nothing and asks for nothing.** 1,000 credits a
 *    month, no card. That mattered more than anything else here: the owner must
 *    be able to turn this on without being signed up for a subscription, and
 *    the alternative with the best index (Brave) wants a payment method on file
 *    even for its free plan.
 *  - **It answers with extracts, not just links.** A search API that returns
 *    ten URLs forces ten page fetches to answer one question; Tavily returns a
 *    relevant passage per result, which is often enough to answer with a
 *    citation and no fetch at all.
 *  - **One POST, JSON in, JSON out, one host.** Nothing to keep in sync.
 *
 * It is not a search engine of its own — it sits on other indexes — and that is
 * worth saying out loud in the docs rather than implying it is Google. If the
 * owner wants a different one, `BUDDI_SEARCH_PROVIDER=brave` is the whole
 * change; see `providers/index.ts`.
 *
 * Nothing in this file trusts the response. Titles, snippets and URLs come back
 * from pages strangers wrote, and they are carried as data all the way to the
 * agent, where the untrusted notice travels with them.
 */
import type { SearchProvider, SearchHit, SearchQuery, SearchDeps, SearchResult } from '../ports.js';

export const TAVILY_HOST = 'api.tavily.com';
export const TAVILY_KEY_NAME = 'TAVILY_API_KEY';

/** What Tavily sends back, as much of it as this plugin reads. */
interface TavilyResponse {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    published_date?: unknown;
  }>;
  detail?: unknown;
  error?: unknown;
}

export const tavily: SearchProvider = {
  id: 'tavily',
  label: 'Tavily',
  keyName: TAVILY_KEY_NAME,
  host: TAVILY_HOST,
  signupUrl: 'https://app.tavily.com',

  async search(query: SearchQuery, deps: SearchDeps): Promise<SearchResult> {
    const payload: Record<string, unknown> = {
      query: query.site ? `${query.query} site:${query.site}` : query.query,
      max_results: query.limit,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    };
    if (query.withinDays !== undefined) payload['days'] = query.withinDays;
    if (query.site !== undefined) payload['include_domains'] = [query.site];

    const response = await deps.fetch({
      url: `https://${TAVILY_HOST}/search`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          failure: {
            code: 'bad-key',
            message: `Tavily rejected the API key (HTTP ${response.status}). The key in ${TAVILY_KEY_NAME} is missing, wrong or revoked.`,
          },
        };
      }
      if (response.status === 429 || response.status === 432 || response.status === 433) {
        return {
          ok: false,
          failure: {
            code: 'quota',
            message: 'Tavily says this account is out of search credits for now.',
          },
        };
      }
      if (response.status === 0) {
        return { ok: false, failure: { code: 'unreachable', message: response.body } };
      }
      return {
        ok: false,
        failure: {
          code: 'provider-error',
          message: `Tavily answered HTTP ${response.status}.`,
        },
      };
    }

    let parsed: TavilyResponse;
    try {
      parsed = JSON.parse(response.body) as TavilyResponse;
    } catch {
      return {
        ok: false,
        failure: { code: 'provider-error', message: 'Tavily answered something that was not JSON.' },
      };
    }
    return { ok: true, hits: toHits(parsed.results ?? []) };
  },
};

/** Defensive to the last field: every one of these is attacker-influenced. */
function toHits(results: TavilyResponse['results'] & object): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of results) {
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (url === '') continue;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    const published = typeof raw.published_date === 'string' ? isoDay(raw.published_date) : undefined;
    hits.push({
      rank: hits.length + 1,
      title: text(raw.title, 200) || host,
      url,
      source: host,
      snippet: text(raw.content, 600),
      ...(published === undefined ? {} : { published }),
    });
  }
  return hits;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed;
}

/** A date the provider *claims*. Normalised, never verified. */
function isoDay(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}
