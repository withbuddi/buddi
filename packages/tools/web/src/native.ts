/**
 * The audit trail for a search this plugin did not run.
 *
 * ## Why it is here and not in the runtime
 *
 * When the provider searches server-side, no tool of ours is called: the model
 * asks, the API searches, the results arrive inside the same response. The
 * first reading of that was that the capability had escaped our accounting —
 * "native search costs us the audit trail". On inspection it does not. The
 * adapter can see the query in the `server_tool_use` block and the result URLs
 * in the `web_search_tool_result` block beside it, which is every column
 * `web.fetches` has.
 *
 * So the runtime reports what it saw (`RunAgentOptions.onNativeSearch`) and
 * this writes the row. It lives in the plugin because the table does: the
 * runtime imports no plugin, and `web.fetches` is this plugin's schema, to be
 * dropped with it.
 *
 * ## The row, and why it has this shape
 *
 * `kind = 'search'`, not `'search-native'`. The migration invites a third kind
 * — "a third kind should be a row, not a migration" — but the point of this
 * record is that `web.search` and the provider's own search leave the **same
 * trace**: one query the owner asked, sent to one third party, on one date, by
 * one agent. An owner reviewing what his agents looked up should not have to
 * know which backend answered to write the query. `detail` says which one did.
 *
 * `host` is the endpoint the query text was *sent to* — `api.anthropic.com`,
 * exactly as a Tavily row carries `api.tavily.com` — because that column
 * answers the privacy question: who saw the owner's words. The hosts that came
 * *back* go in `detail`, where they answer the other one: what did it read.
 */
import type { NativeSearchEvent } from '@buddi/core/plugin';
import { recordFetch, type Queryable } from './log.js';

/** Where a provider's server-side search sends the query. */
export const PROVIDER_SEARCH_HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
};

/** How many result hosts fit in `detail` before it is truncated. */
const MAX_HOSTS_LOGGED = 8;

/** `native (anthropic) · 7 results · cargurus.com, kbb.com, …` */
export function nativeSearchDetail(event: NativeSearchEvent): string {
  if (event.outcome === 'error') {
    return `native (${event.provider}) · failed: ${event.detail ?? 'unknown'}`;
  }
  const shown = event.hosts.slice(0, MAX_HOSTS_LOGGED);
  const more = event.hosts.length - shown.length;
  const hosts = shown.length === 0 ? 'no hosts reported' : shown.join(', ');
  return (
    `native (${event.provider}) · ${event.resultCount} result${event.resultCount === 1 ? '' : 's'} · ` +
    `${hosts}${more > 0 ? ` +${more} more` : ''}`
  );
}

/**
 * Write one `web.fetches` row per server-side search.
 *
 * Never throws and never fails a run: `recordFetch` already swallows its own
 * errors, and this adds nothing that can. A query with no text still gets a
 * row — that a search happened is the fact worth keeping, and an empty target
 * is more honest than a silence.
 */
export async function recordNativeSearches(
  db: Queryable,
  events: readonly NativeSearchEvent[],
): Promise<void> {
  for (const event of events) {
    await recordFetch(db, {
      kind: 'search',
      agentId: event.agentId,
      conversationId: event.conversationId,
      target: event.query === '' ? '(query not reported by the provider)' : event.query,
      host: PROVIDER_SEARCH_HOSTS[event.provider] ?? event.provider,
      outcome: event.outcome,
      detail: nativeSearchDetail(event),
    });
  }
}

/** The recorder as the loop wants it: bind the pool once, hand over the callback. */
export function nativeSearchRecorder(
  db: Queryable,
): (events: readonly NativeSearchEvent[]) => Promise<void> {
  return (events) => recordNativeSearches(db, events);
}
