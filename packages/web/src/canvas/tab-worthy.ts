/**
 * Which tool results earn a Canvas tab: the one rule, in one place.
 *
 * A tab is a place to *look at* something. A sign-in run on a live page
 * calls `secret.list`, `secret.fill` and a dozen `browser.act` steps; drawn a
 * tab each, they buried the Page the owner was watching under acknowledgements
 * he had no use for. So a result opens a tab only when its resolved renderer
 * is a real view, and the platform's own doing-tools never do:
 *
 * **Views that open a tab** (`VIEW_RENDERERS`): `table`, `tiles` (a list of
 * cards), `timeseries` and `bars` (charts), `keyvalue` (figures), `story`,
 * `document`, `diff`, `terminal`, `image`, `audio`, `preview`, `query`, and
 * `envelope` (a decision). `structured` — the generic JSON card — opens one
 * only when it has real content (rows, a list of a few, enough fields to lay
 * out: `hasSubstance` in `renderables.ts`). A plugin's declared view goes
 * through exactly this test: its descriptor resolves to a renderer, and the
 * renderer decides.
 *
 * **Tools whose results stay in the thread row** (`ROW_ONLY_TOOLS`), whatever
 * they return: `browser.*` (every step is on the Page tab's list),
 * `secret.*` and `secrets.*` (a fill, a list of names, a save — never worth
 * the screen, and never something to leave lying open), `mission.*` (reports
 * the run already said) and `owner.notify` (the message went to the owner's
 * phone; the row says where). Their row still expands to the whole result, and
 * its "Open on the canvas" draws it on demand.
 *
 * Exempt from the rule entirely: `canvas.show` (the agent asked for this to be
 * shown), a call stopped on a gate (an envelope), and a failure, which keeps a
 * quiet tab in the timeline so bad news is never hidden — unless its tool is
 * row-only, where the row's red mark is the whole story.
 */
import type { RendererName } from './types';

/** Renderers that are a real view: a result drawn by one of these opens a tab. */
export const VIEW_RENDERERS: ReadonlySet<RendererName> = new Set<RendererName>([
  'table',
  'tiles',
  'timeseries',
  'bars',
  'keyvalue',
  'story',
  'document',
  'diff',
  'terminal',
  'image',
  'audio',
  'preview',
  'query',
  'envelope',
]);

/**
 * Platform tools that act rather than show. `family.*` covers the family;
 * anything else is one tool's exact name.
 */
export const ROW_ONLY_TOOLS: readonly string[] = [
  'browser.*',
  'secret.*',
  'secrets.*',
  'mission.*',
  'owner.notify',
];

/** Does this tool's result stay in its thread row? */
export function rowOnlyTool(tool: string): boolean {
  return ROW_ONLY_TOOLS.some((pattern) => pattern.endsWith('.*')
    ? tool.startsWith(pattern.slice(0, -1))
    : tool === pattern);
}

/**
 * Does a successful result open a Canvas tab?
 *
 * `renderer` is what the result resolved to (a plugin's descriptor, or
 * `structured` when there is none) and `substantial` whether it has anything
 * in it (`hasSubstance`), which only `structured` needs.
 */
export function opensTab({ tool, renderer, substantial }: { tool: string; renderer: RendererName; substantial: boolean }): boolean {
  if (rowOnlyTool(tool)) return false;
  if (renderer === 'structured') return substantial;
  return VIEW_RENDERERS.has(renderer);
}
