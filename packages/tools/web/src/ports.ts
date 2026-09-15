/**
 * The seam between this plugin and whoever does the searching.
 *
 * Search is the one part of this plugin that cannot be done without a third
 * party, and a third party is the one part of a personal assistant that
 * reliably changes: a free tier closes, a price appears, an API is retired,
 * the owner decides he would rather not send his questions to that company.
 * None of that should cost more than one line in `providers/index.ts`.
 *
 * So a provider is an object with an id, the name of the secret it needs, the
 * host it talks to, and one method. It never holds the key (the key is resolved
 * per call, from the environment the vault filled in), it never opens its own
 * socket (it is handed the guarded fetcher), and it returns *hits*, not the
 * provider's own JSON — so nothing downstream knows which company answered.
 */

/** What an agent asked for. */
export interface SearchQuery {
  query: string;
  /** How many results to return. The provider may return fewer. */
  limit: number;
  /** Restrict to one site, e.g. `cars.com`. */
  site?: string | undefined;
  /** Only pages the provider believes are newer than this many days. */
  withinDays?: number | undefined;
  /** An IANA-ish region hint, e.g. `us`. Providers that ignore it, ignore it. */
  region?: string | undefined;
}

/**
 * One result — evidence with a source.
 *
 * The shape is the point. An agent that is handed `{ text }` writes an answer
 * with no citations in it; an agent handed a list where every item carries its
 * own `source` and `url` writes "Cars.com lists…", because that is the shape of
 * the thing in front of it. Snippets are short on purpose: a snippet is a
 * reason to call `web.read`, not a substitute for it.
 */
export interface SearchHit {
  /** 1-based, so an agent can say "result 3" and be understood. */
  rank: number;
  title: string;
  url: string;
  /** The host, pre-extracted, because this is what a citation actually names. */
  source: string;
  /** The provider's extract. Never the whole page. */
  snippet: string;
  /** `YYYY-MM-DD` when the provider claims to know it. Claimed, not verified. */
  published?: string | undefined;
}

export interface SearchDeps {
  /** The guarded fetcher. A provider never builds its own. */
  fetch: (request: {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ ok: boolean; status: number; body: string; url: string }>;
  /** The API key, already resolved. A provider never reads the environment. */
  key: string;
}

export type ProviderFailure =
  | { code: 'bad-key'; message: string }
  | { code: 'quota'; message: string }
  | { code: 'provider-error'; message: string }
  | { code: 'unreachable'; message: string };

export type SearchResult =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; failure: ProviderFailure };

export interface SearchProvider {
  /** What `BUDDI_SEARCH_PROVIDER` names, and what the result is labelled with. */
  readonly id: string;
  /** Owner-facing: "Tavily". */
  readonly label: string;
  /** The secret's name, in `.env` and in the vault. */
  readonly keyName: string;
  /** The one host it talks to, for the manifest's `network` declaration. */
  readonly host: string;
  /** Where the owner gets a key. Printed by `buddi doctor`. */
  readonly signupUrl: string;
  search(query: SearchQuery, deps: SearchDeps): Promise<SearchResult>;
}
