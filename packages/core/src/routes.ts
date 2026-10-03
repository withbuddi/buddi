/**
 * Route providers (docs/plugin-host-api.md, "Routes"; docs/browser.md).
 *
 * The browser's runtime picks, per task, where an agent looks: buddi's own
 * browser, the owner's Chrome, or the owner's apps. The first two are core's.
 * The third is a *route a plugin provides*: it declares its kind, its health,
 * and a look/do pair the runtime routes `browser.act` to. Core's own computer
 * control is driven through this same interface, so moving it into a plugin
 * is a move, not a rewrite. Since host API 1.29.
 */

/** The route kinds a plugin may provide. Only `apps` today; the two browsers are core's. */
export const PROVIDED_ROUTE_KINDS = ['apps'] as const;
export type ProvidedRouteKind = (typeof PROVIDED_ROUTE_KINDS)[number];

/** Can this route be used right now, and if not, the one fix. */
export interface RouteHealth {
  /** Usable now. */
  ok: boolean;
  /** One sentence for the owner when not ok (or worth saying anyway). */
  message?: string;
  /** What the owner can press to repair it, by a short id the page maps to a button. */
  repair?: 'install' | 'permissions' | 'pair' | 'helper';
}

/** One action a route performs: the `browser.act` command, already validated. */
export interface RouteCommand {
  action: 'navigate' | 'open' | 'observe' | 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'tab' | 'close';
  url?: string;
  appId?: string;
  target?: { ref?: string; x?: number; y?: number; role?: string; name?: string; by?: string; frame?: number };
  value?: string;
  key?: string;
  direction?: 'up' | 'down';
  tabId?: string;
  observation?: string;
}

/** What a route sees: the same page shape every route answers with, so an agent cannot tell them apart. */
export interface RoutePage {
  id: string;
  url: string;
  title: string;
  tree: string;
  targets?: Array<{ ref: string; frame: number; role: string; name: string; href?: string; bounds?: { x: number; y: number; width: number; height: number } }>;
  tabs: Array<{ id: string; url: string; title: string }>;
  capturedAt: string;
  appId?: string;
  screenshotSize?: { width: number; height: number };
  /** The picture, when the route has one. Never stored, never logged. */
  screenshot?: Uint8Array;
}

/**
 * One route a plugin provides.
 *
 * `session` is the conversation's page handle the runtime mints; a route that
 * holds per-conversation state keys it by that. `do` acts; `look` answers the
 * page as it is now. A refusal before anything was dispatched throws an error
 * whose `precondition` is true, so the runtime re-looks instead of pausing.
 */
export interface RouteProvider {
  kind: ProvidedRouteKind;
  /** How the route is named to the owner ("your apps"). */
  label: string;
  /** The platforms it exists on; absent is every platform. */
  platforms?: readonly NodeJS.Platform[];
  /** One conversation at a time (a desktop has one mouse): the runtime queues the rest. */
  exclusive?: boolean;
  health(): RouteHealth | Promise<RouteHealth>;
  look(session: string): Promise<RoutePage>;
  do(session: string, command: RouteCommand): Promise<void>;
  /** The conversation is done with the route. Apps are the owner's and are never closed. */
  release?(session: string): Promise<void>;
}

/** A provider, with the plugin that declared it. */
export type RegisteredRouteProvider = RouteProvider & { plugin: string };

/** Why a `routes` declaration cannot be kept, or undefined. */
export function routeProviderProblem(route: unknown): string | undefined {
  if (!route || typeof route !== 'object') return 'a route must be an object';
  const value = route as Partial<RouteProvider>;
  if (!PROVIDED_ROUTE_KINDS.includes(value.kind as ProvidedRouteKind)) return `a route's kind must be one of ${PROVIDED_ROUTE_KINDS.join(', ')}`;
  if (typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > 60) return 'a route needs a label of at most 60 characters';
  for (const name of ['health', 'look', 'do'] as const) {
    if (typeof value[name] !== 'function') return `a route needs a ${name} handler`;
  }
  return undefined;
}
