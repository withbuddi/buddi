/**
 * Route providers (docs/plugin-host-api.md, "Routes"; docs/browser.md).
 *
 * The browser's runtime picks, per task, where an agent looks: buddi's own
 * browser, the owner's Chrome, or the owner's apps. The first two are core's.
 * The third is a *route a plugin provides*: it declares its kind, its health,
 * and a look/do pair the runtime routes `browser.act` to. Computer control is
 * `@withbuddi/plugin-computer`, which provides `apps` through exactly this
 * interface; core has no apps route of its own. Since host API 1.29.
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

/** One thing a route can reach (an app): its id and the name the owner knows it by. */
export interface RouteTarget { id: string; name: string }

/**
 * What a route can reach, and the owner's list of it (an `apps` route: the
 * apps agents may open). Core keeps the conversation's own yeses (an app
 * allowed Once by card) and draws the card; the provider answers who a name
 * stands for, whether it is on the owner's list, and what to do with one that
 * is not. Core calls `do` with `open` only for a target it let through: listed,
 * or allowed by the owner's card.
 */
export interface RouteReach {
  /**
   * The one target a name or an id stands for. A name that matches nothing,
   * or several, throws with `precondition: true` and the close names, never a
   * pick made for the agent.
   */
  resolve(query: { name: string } | { id: string }): Promise<RouteTarget>;
  /** On the owner's list: opened without asking. */
  listed(id: string): boolean | Promise<boolean>;
  /** A target not on the list: `ask` the owner with a card (Once / Always), or `refuse`. */
  unlisted(): 'ask' | 'refuse' | Promise<'ask' | 'refuse'>;
  /** The owner said Always on the card: put it on the list. False when it cannot (the list is full). */
  remember?(target: RouteTarget): Promise<boolean>;
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
  /** What the route can reach and the owner's list of it; absent, everything it is asked for. */
  reach?: RouteReach;
  /**
   * The owner takes over: stop anything in flight and send no input until
   * `resume`. A provided route has no remote hand, so the Canvas shows the
   * route's frames and `handMessage` (where the owner takes over instead).
   */
  takeover?(session: string): Promise<void>;
  resume?(session: string): void | Promise<void>;
  /** One sentence for the Canvas's Take over on this route ("Take over at the Mac"). */
  handMessage?: string;
  /**
   * Native typing for `secret.type`: the target in front right now, as the
   * route itself reads it (never the agent's claim), and the owner's secret
   * typed into its focused field. A route without them refuses `secret.type`.
   */
  focused?(session: string): Promise<string | undefined>;
  typeSecret?(session: string, value: string): Promise<void>;
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
  for (const name of ['release', 'takeover', 'resume', 'focused', 'typeSecret'] as const) {
    if (value[name] !== undefined && typeof value[name] !== 'function') return `a route's ${name} must be a function`;
  }
  if ((value.focused === undefined) !== (value.typeSecret === undefined)) return 'a route declares focused and typeSecret together, or neither';
  if (value.handMessage !== undefined && (typeof value.handMessage !== 'string' || value.handMessage.length > 200)) return "a route's handMessage is one sentence of at most 200 characters";
  if (value.reach !== undefined) {
    const reach = value.reach as Partial<RouteReach> | null;
    if (!reach || typeof reach !== 'object') return "a route's reach must be an object";
    for (const name of ['resolve', 'listed', 'unlisted'] as const) {
      if (typeof reach[name] !== 'function') return `a route's reach needs ${name}`;
    }
    if (reach.remember !== undefined && typeof reach.remember !== 'function') return "a route's reach.remember must be a function";
  }
  return undefined;
}
