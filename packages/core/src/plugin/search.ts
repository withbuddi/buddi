/**
 * Who searches the web for an agent: the name of the owner's override and its
 * parser, and what one server-side search looks like when the runtime reports
 * it. Moved here from `@buddi/runtime` (docs/plugin-host-api.md §3): the
 * runtime reads the override before a request is built, the web plugin reads
 * it to pick its backend and records the searches, and both now read it from
 * one place. Pure: names, a parser and types.
 */

/** The owner's existing override. Named here because this is where it is parsed. */
export const SEARCH_BACKEND_VAR = 'BUDDI_SEARCH_PROVIDER';

/** The value that *forces* the provider's own search rather than merely allowing it. */
export const NATIVE_BACKEND_ID = 'native';

/** What `BUDDI_SEARCH_PROVIDER` says, normalised. */
export type SearchBackendChoice =
  /** Unset: the platform picks — native where the provider has it. */
  | { mode: 'auto' }
  /** `native`: the provider's own search, and nothing else. */
  | { mode: 'native' }
  /** A backend the plugin owns (`tavily`, `brave`, or a typo it will report). */
  | { mode: 'named'; id: string };

export function parseSearchBackend(
  env: Record<string, string | undefined> = process.env,
): SearchBackendChoice {
  const named = (env[SEARCH_BACKEND_VAR] ?? '').trim().toLowerCase();
  if (named === '') return { mode: 'auto' };
  if (named === NATIVE_BACKEND_ID) return { mode: 'native' };
  return { mode: 'named', id: named };
}

/**
 * One server-side search, as the audit trail needs it.
 *
 * The claim that native search costs us the audit trail turned out to be
 * wrong on inspection: the adapter sees the query in the `server_tool_use`
 * block and the result URLs in the `web_search_tool_result` block that follows
 * it. That is every column `web.fetches` has — who asked, when, what for,
 * where it went, how it ended — so a native search leaves the same trace a
 * `web.search` call does. What is *not* here is the page text, which is the
 * same thing the plugin's own log refuses to store.
 */
export interface NativeSearchRecord {
  /** What the model asked for, in its own words. */
  query: string;
  /** Result hosts, de-duplicated, in the order they ranked. */
  hosts: string[];
  resultCount: number;
  outcome: 'ok' | 'error';
  /** The provider's error code, when it failed. */
  detail?: string;
}

/** One server-side search, stamped with the run that caused it. */
export interface NativeSearchEvent extends NativeSearchRecord {
  agentId: string;
  conversationId: string;
  /** The provider that ran it — which is also where the query text went. */
  provider: string;
}
