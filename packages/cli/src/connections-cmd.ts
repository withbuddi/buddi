/**
 * `buddi connections`: Settings → Connections from the terminal
 * (docs/connections.md, "From the terminal").
 *
 * The connections service and the tools it registers live in the running
 * gateway, so every subcommand goes through it: the dashboard's own routes
 * (`/api/connections…`), reached as the owner the way `buddi mcp` reaches them
 * (`mcp/gateway-client.ts`: a loopback session, or a five-minute ticket off
 * loopback), with the same CSRF pair and origin the page sends. Nothing here
 * writes a store of its own, and nothing here prints or logs a token.
 *
 * `add` walks the dashboard's four screens in order: address, sign-in,
 * review, give. A sign-in on the service's own page is a consent the gateway
 * mints for the CLI (`cli: true`): the owner opens the link in any browser,
 * the service sends them to the dashboard's `/connections/callback`, and this
 * command polls the connection until it is signed in, ten minutes at most.
 * A card that recommends the device way (GitHub) prints a code and the
 * address to type it at; the gateway waits for the approval and this command
 * polls the connection until its `device` says done or why not.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseConnectionConfig, type PastedConfig } from '@buddi/core/connection-config';
import type { ConnectionsCommand } from './args.js';
import { GatewayError, GatewayUnavailable, NOT_RUNNING } from './mcp/gateway-client.js';
import { confirmTty, promptHidden } from './vault-cmd.js';

/* ------------------------------------------------------------------ *
 * What the gateway answers (web/connections.ts, @buddi/tool-mcp's views)
 * ------------------------------------------------------------------ */

export interface ConnectionView {
  id: string;
  slug: string | null;
  name: string;
  url: string;
  host: string;
  state: 'connected' | 'needs-reconnect' | 'unreachable' | 'pending-review' | 'needs-review';
  authKind: 'none' | 'oauth' | 'token';
  signedIn: boolean;
  toolCount: number;
  grant: string | null;
  unreachableSince: string | null;
  heldTools: number;
  agents: string[];
  device?: { state: 'waiting' | 'done' | 'failed'; userCode: string; verificationUri: string; expiresAt: string; reason?: string };
}

interface CatalogCard {
  id: string;
  name: string;
  url: string;
  clientIdRequired?: boolean;
  auth?: { recommended: 'device' | 'token' | 'oauth'; device?: { clientId: string }; tokenPage?: string; tokenHint?: string };
}

interface AgentChoice { id: string; name: string; handle: string; frontDesk: boolean }

interface ListAnswer {
  connections: ConnectionView[];
  catalog: CatalogCard[];
  agents: AgentChoice[];
  callbackPath: string;
}

interface ReviewTool {
  name: string;
  fullName: string;
  description: string;
  tier: 'auto' | 'gated';
  destructive: boolean;
  problem: string | null;
  change: 'added' | 'changed' | null;
}

interface ReviewView {
  connection: ConnectionView;
  slug: string;
  slugEditable: boolean;
  host: string;
  hash: string;
  tools: ReviewTool[];
  annotatedNothing: boolean;
  changes: { added: string[]; changed: string[]; removed: string[] } | null;
}

/** The three verbs the routes take. `GatewayClient` is one. */
export interface ConnectionsGateway {
  readonly baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }>;
  delete<T = unknown>(path: string): Promise<{ status: number; body: T }>;
}

export interface ConnectionsIo {
  out(line: string): void;
  err(line: string): void;
  /** A person is at a terminal: questions may be asked. */
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  ask(question: string): Promise<string>;
  /** A line with echo off (or a piped line). Never printed. */
  secret(label: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Wait for Enter without holding up the command: `pressed` resolves true on
   * Enter, false once `cancel` is called. Only asked at a terminal.
   */
  enter(question: string): { pressed: Promise<boolean>; cancel(): void };
  /** Open an address in the browser. Never throws: a failure only means the owner opens it. */
  openUrl(url: string): void;
}

export interface ConnectionsDeps {
  gateway: ConnectionsGateway | { off: string };
  json: boolean;
  io?: Partial<ConnectionsIo>;
  /** How often a waiting sign-in is asked about. Two seconds. */
  pollMs?: number;
}

/** A sign-in on the service's own page waits this long, like the dashboard. */
export const CONSENT_WAIT_MS = 10 * 60_000;

export const OPEN_IN_BROWSER = 'Open it in your browser; the page sends you back to your dashboard and this command carries on.';

function defaultIo(): ConnectionsIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: confirmTty,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await new Promise<string>((resolve) => rl.question(question, resolve)); } finally { rl.close(); }
    },
    secret: promptHidden,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    enter: (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let settle: (value: boolean) => void = () => {};
      const pressed = new Promise<boolean>((resolve) => { settle = resolve; });
      rl.question(question, () => { settle(true); rl.close(); });
      rl.on('close', () => settle(false));
      return { pressed, cancel: () => rl.close() };
    },
    openUrl: openInBrowser,
  };
}

/** `open` on macOS, `xdg-open` on Linux; elsewhere nothing, and the printed address is the answer. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const opener = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined;
  if (!opener) return;
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The owner opens it.
  }
}

/** A stop with a sentence and an exit code; the sentence is already said. */
class Stop extends Error {
  constructor(readonly code: number) { super('stop'); }
}

export async function runConnections(command: ConnectionsCommand, deps: ConnectionsDeps): Promise<number> {
  const io: ConnectionsIo = { ...defaultIo(), ...deps.io };
  if ('off' in deps.gateway) {
    io.err(deps.gateway.off);
    return 3;
  }
  const run = new Run(deps.gateway, io, deps.json, deps.pollMs ?? 2_000);
  try {
    switch (command.action) {
      case 'list': return await run.list();
      case 'add': return await run.add(command);
      case 'review': return await run.review(command.name, { keep: command.keep, ...(command.slug ? { slug: command.slug } : {}) });
      case 'give': return await run.give(command.name, command.to);
      case 'remove': return await run.remove(command.name, command.yes);
    }
  } catch (err) {
    if (err instanceof Stop) return err.code;
    if (err instanceof GatewayUnavailable) { io.err(NOT_RUNNING); return 3; }
    if (err instanceof GatewayError) { io.err(err.message); return err.status === 503 ? 3 : 1; }
    throw err;
  }
}

/** The tier as the review screen says it. */
export function tierWords(tool: { tier: 'auto' | 'gated'; destructive: boolean }): string {
  if (tool.tier === 'auto') return 'runs on its own';
  return tool.destructive ? 'asks every time' : 'asks you first';
}

const STATE_WORDS: Record<ConnectionView['state'], string> = {
  connected: 'connected',
  'pending-review': 'waiting for your review',
  'needs-review': 'changed its tools; review them',
  'needs-reconnect': 'needs you to sign in again',
  unreachable: 'unreachable, retrying',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

class Run {
  constructor(
    readonly gateway: ConnectionsGateway,
    readonly io: ConnectionsIo,
    readonly json: boolean,
    readonly pollMs: number,
  ) {}

  #listing(): Promise<ListAnswer> {
    return this.gateway.get<ListAnswer>('/api/connections');
  }

  /** A connection by its name in buddi (slug), its display name, or its id. */
  async #find(name: string): Promise<{ view: ConnectionView; listing: ListAnswer }> {
    const listing = await this.#listing();
    const wanted = name.trim().toLowerCase();
    const bySlug = listing.connections.find((c) => c.slug === wanted);
    if (bySlug) return { view: bySlug, listing };
    const byId = listing.connections.find((c) => c.id === wanted);
    if (byId) return { view: byId, listing };
    const byName = listing.connections.filter((c) => c.name.toLowerCase() === wanted);
    if (byName.length === 1) return { view: byName[0]!, listing };
    if (byName.length > 1) {
      this.io.err(`${byName.length} connections are called ${name}. Name one by its id: ${byName.map((c) => c.id).join(', ')}.`);
      throw new Stop(1);
    }
    const known = listing.connections.map((c) => c.slug ?? c.name);
    this.io.err(`There is no connection called ${name}.${known.length ? ` There is ${known.join(', ')}.` : ' Add one with buddi connections add.'}`);
    throw new Stop(1);
  }

  #agentNames(listing: ListAnswer, ids: readonly string[]): string {
    return ids.map((id) => listing.agents.find((a) => a.id === id)?.name ?? id).join(', ');
  }

  /* ---------------------------------------------------------------- list */

  async list(): Promise<number> {
    const listing = await this.#listing();
    if (this.json) {
      this.io.out(JSON.stringify(listing.connections.map((c) => ({
        id: c.id, name: c.name, slug: c.slug, state: c.state, host: c.host, url: c.url,
        signedIn: c.signedIn, tools: c.toolCount, heldTools: c.heldTools, agents: c.agents,
      })), null, 2));
      return 0;
    }
    if (listing.connections.length === 0) {
      this.io.out('No connections yet.');
      this.io.out(`Add one with buddi connections add <card|https://…>. The cards: ${listing.catalog.map((c) => c.id).join(', ')}.`);
      return 0;
    }
    for (const c of listing.connections) {
      const who = c.slug ?? c.name;
      const tools = c.slug ? plural(c.toolCount, 'tool') : 'not reviewed';
      const agents = c.agents.length > 0 ? `given to ${this.#agentNames(listing, c.agents)}` : 'given to nobody';
      const held = c.heldTools > 0 ? `, ${c.heldTools} waiting for review` : '';
      const state = c.state === 'unreachable' && c.unreachableSince ? `unreachable since ${c.unreachableSince}, retrying`
        : c.state === 'pending-review' && !c.signedIn ? 'waiting for a sign-in' : STATE_WORDS[c.state];
      this.io.out(`${who}  ${c.name} (${c.host})  ${state}  ${tools}${held}  ${agents}`);
    }
    return 0;
  }

  /* ----------------------------------------------------------------- add */

  async add(cmd: Extract<ConnectionsCommand, { action: 'add' }>): Promise<number> {
    // 1. Address. A pasted block is read before anything is asked of buddi.
    let config: PastedConfig | undefined;
    if (cmd.config !== undefined) {
      try { config = parseConnectionConfig(cmd.config); } catch (err) {
        this.io.err(err instanceof Error ? err.message : String(err));
        return 2;
      }
      for (const dropped of config.dropped) this.io.out(`buddi sends one header; ${dropped} is left out.`);
    }
    const listing = await this.#listing();
    let card: CatalogCard | undefined;
    let url: string;
    if (config) url = config.url;
    else {
      const address = cmd.address!.trim();
      if (/^https?:\/\//i.test(address)) url = address;
      else {
        card = listing.catalog.find((c) => c.id === address.toLowerCase());
        if (!card) {
          this.io.err(`There is no card called ${address}. The cards: ${listing.catalog.map((c) => c.id).join(', ')}; or give an https:// address.`);
          return 2;
        }
        url = card.url;
      }
    }
    card ??= listing.catalog.find((c) => c.url === url);
    const name = cmd.name ?? config?.name ?? card?.name;
    const added = (await this.gateway.post<{ connection: ConnectionView; signIn: 'none' | 'dynamic' | 'manual' }>(
      '/api/connections', { url, ...(name ? { name } : {}) },
    )).body;
    let view = added.connection;
    this.io.out(`Opened ${view.host}: ${view.name}.`);
    const waits = (): void => this.io.out(`${view.name} waits under Settings → Connections; buddi connections remove "${view.name}" takes it away.`);

    // 2. Sign in.
    try {
      if (added.signIn === 'none') this.io.out(`${view.name} wants no sign-in.`);
      else view = await this.#signIn(view, added.signIn, cmd, card, config);
    } catch (err) {
      if (err instanceof Stop || err instanceof GatewayError) {
        if (err instanceof GatewayError) this.io.err(err.message);
        waits();
        throw new Stop(1);
      }
      throw err;
    }

    // 3. Review.
    const reviewed = await this.#review(view, { keep: cmd.keep, ...(cmd.slug ? { slug: cmd.slug } : {}) });
    if (!reviewed) return 0;

    // 4. Give.
    return this.#give(reviewed, cmd.to, listing);
  }

  async #signIn(
    view: ConnectionView,
    signIn: 'dynamic' | 'manual',
    cmd: Extract<ConnectionsCommand, { action: 'add' }>,
    card: CatalogCard | undefined,
    config: PastedConfig | undefined,
  ): Promise<ConnectionView> {
    const header = config?.header;
    const forced = cmd.token || cmd.tokenStdin || header !== undefined;
    if (!forced && !cmd.clientId && card?.auth?.recommended === 'device' && card.auth.device) {
      return this.#device(view, card);
    }
    const wantsToken = forced || (!cmd.clientId && card?.auth?.recommended === 'token');
    if (wantsToken) return this.#token(view, cmd, card, header);
    if (signIn === 'manual' && !cmd.clientId) {
      this.io.err(`${view.name} does not let buddi register itself. Run again with --client-id <id> (an app you create in its developer settings, with the redirect address ${this.gateway.baseUrl}/connections/callback), or with --token.`);
      throw new Stop(1);
    }
    return this.#consent(view, cmd.clientId);
  }

  async #token(
    view: ConnectionView,
    cmd: Extract<ConnectionsCommand, { action: 'add' }>,
    card: CatalogCard | undefined,
    header: PastedConfig['header'],
  ): Promise<ConnectionView> {
    let token = header?.value ?? '';
    if (token === '') {
      if (card?.auth?.recommended === 'token' && !cmd.token && !cmd.tokenStdin) {
        this.io.out(`${card.name} recommends a token.${card.auth.tokenPage ? ` Make one at ${card.auth.tokenPage}` : ''}`);
        if (card.auth.tokenHint) this.io.out(card.auth.tokenHint);
      }
      if (!cmd.tokenStdin && !this.io.interactive) {
        this.io.err('There is no terminal to type the token in. Pipe it with --token-stdin.');
        throw new Stop(1);
      }
      token = (await this.io.secret(`Token for ${view.name} (not shown): `)).trim();
      if (token === '') {
        this.io.err('No token was given, so nothing was signed in.');
        throw new Stop(1);
      }
    }
    const done = await this.gateway.post<{ connection: ConnectionView }>(`/api/connections/${view.id}/token`, {
      token,
      ...(header ? { header: header.name, prefix: header.prefix } : {}),
    });
    this.io.out(`${view.name} accepted the token; buddi keeps it as one of your secrets.`);
    return done.body.connection;
  }

  /**
   * A code typed on the service's site: the gateway asks for it and waits for
   * the approval; this prints it with the address, opens the address on
   * Enter, and polls the connection until its `device` says done or why not.
   */
  async #device(view: ConnectionView, card: CatalogCard): Promise<ConnectionView> {
    let started: { userCode: string; verificationUri: string; expiresAt: string };
    try {
      started = (await this.gateway.post<{ userCode: string; verificationUri: string; expiresAt: string }>(`/api/connections/${view.id}/device`, {})).body;
    } catch (err) {
      if (err instanceof GatewayError) {
        this.io.err(`${err.message} Run again with --token to sign in with a token instead.`);
        throw new Stop(1);
      }
      throw err;
    }
    this.io.out(`Sign in to ${card.name} with this code:`);
    this.io.out('');
    this.io.out(`  ${started.userCode}`);
    this.io.out('');
    this.io.out(`Type it at ${started.verificationUri} and say yes there.`);
    const enter = this.io.interactive ? this.io.enter('Press Enter to open it in your browser, or open it yourself. ') : undefined;
    void enter?.pressed.then((pressed) => { if (pressed) this.io.openUrl(started.verificationUri); });
    try {
      const until = Math.max(Date.parse(started.expiresAt) || 0, this.io.now()) + 30_000;
      while (this.io.now() < until) {
        await this.io.sleep(this.pollMs);
        const fresh = await this.gateway.get<ConnectionView>(`/api/connections/${view.id}`).catch((err: unknown) => {
          if (err instanceof GatewayUnavailable) throw err;
          return undefined;
        });
        if (fresh?.device?.state === 'done') {
          if (enter) this.io.out('');
          this.io.out(`Signed in to ${fresh.name}.`);
          return fresh;
        }
        if (fresh?.device?.state === 'failed') {
          if (enter) this.io.out('');
          this.io.err(fresh.device.reason ?? 'The sign-in did not finish. Start it again.');
          throw new Stop(1);
        }
      }
      this.io.err('The code expired before it was approved. Start it again.');
      throw new Stop(1);
    } finally {
      enter?.cancel();
    }
  }

  async #consent(view: ConnectionView, clientId: string | undefined): Promise<ConnectionView> {
    let started: { authorizeUrl: string; redirectUri: string };
    try {
      started = (await this.gateway.post<{ authorizeUrl: string; redirectUri: string }>(
        `/api/connections/${view.id}/consent`, { cli: true, ...(clientId ? { clientId } : {}) },
      )).body;
    } catch (err) {
      if (err instanceof GatewayError && (err.body as { code?: string } | undefined)?.code === 'client-id') {
        this.io.err(`${err.message} Run again with --client-id <id> or --token. The redirect address is ${this.gateway.baseUrl}/connections/callback.`);
        throw new Stop(1);
      }
      throw err;
    }
    if (clientId) this.io.out(`The app's redirect address must be ${started.redirectUri}.`);
    this.io.out(`Sign in to ${view.name} here:`);
    this.io.out(`  ${started.authorizeUrl}`);
    this.io.out(OPEN_IN_BROWSER);
    const until = this.io.now() + CONSENT_WAIT_MS;
    while (this.io.now() < until) {
      await this.io.sleep(this.pollMs);
      const fresh = await this.gateway.get<ConnectionView>(`/api/connections/${view.id}`).catch((err: unknown) => {
        if (err instanceof GatewayUnavailable) throw err;
        return undefined;
      });
      if (fresh?.signedIn && fresh.authKind === 'oauth') {
        this.io.out(`Signed in to ${fresh.name}.`);
        return fresh;
      }
    }
    this.io.err('The sign-in did not come back within ten minutes. Start it again.');
    throw new Stop(1);
  }

  /* -------------------------------------------------------------- review */

  #printReview(review: ReviewView, slug: string): void {
    const name = review.connection.name;
    this.io.out(`${name} brings ${plural(review.tools.length, 'tool')}. buddi talks to ${review.host} for them, and nowhere else.`);
    if (review.annotatedNothing) this.io.out(`${name} says nothing about what its tools do, so every one of them asks you first.`);
    const changes = review.changes;
    if (changes && changes.added.length + changes.changed.length + changes.removed.length > 0) {
      this.io.out(`${name} changed its tools since your last review. Until you keep this list, the new and changed ones wait.`);
      if (changes.removed.length > 0) this.io.out(`  Gone: ${changes.removed.join(', ')}`);
    }
    const width = Math.max(0, ...review.tools.map((t) => t.fullName.length));
    for (const tool of review.tools) {
      const fullName = review.slugEditable ? tool.fullName.replace(/^mcp\.[^.]+\./, `mcp.${slug}.`) : tool.fullName;
      const mark = tool.change === 'added' ? '  (new)' : tool.change === 'changed' ? '  (changed)' : '';
      const extra = Math.max(0, fullName.length - tool.fullName.length);
      this.io.out(`  ${fullName.padEnd(width + extra)}  ${tierWords(tool)}${mark}`);
      const description = tool.description.replace(/\s+/g, ' ').trim();
      if (description) this.io.out(`      ${description.length > 160 ? `${description.slice(0, 157)}…` : description}`);
      if (tool.problem) this.io.out(`      Not usable: ${tool.problem}`);
    }
  }

  /** Read the review, print it, and keep it when the owner says so. The kept view, or null. */
  async #review(view: ConnectionView, opts: { keep: boolean; slug?: string }): Promise<ConnectionView | null> {
    const review = await this.gateway.get<ReviewView>(`/api/connections/${view.id}/review`);
    const slug = review.slugEditable ? (opts.slug?.trim().toLowerCase() || review.slug) : review.slug;
    if (opts.slug && !review.slugEditable && opts.slug.trim().toLowerCase() !== review.slug) {
      this.io.out(`${view.name} is already called ${review.slug}; only the first review names it.`);
    }
    if (this.json) this.io.out(JSON.stringify({ ...review, slug }, null, 2));
    else this.#printReview(review, slug);
    let keep = opts.keep;
    if (!keep && !this.json && this.io.interactive) keep = await this.io.confirm(`Keep these tools as mcp.${slug}.*?`);
    if (!keep) {
      if (!this.json) this.io.out(`Nothing was kept. Run buddi connections review ${review.slugEditable ? `"${view.name}"` : slug} --keep when you have read them.`);
      return null;
    }
    try {
      const kept = (await this.gateway.post<ConnectionView>(`/api/connections/${view.id}/review`, {
        hash: review.hash, ...(review.slugEditable ? { slug } : {}),
      })).body;
      if (!this.json) this.io.out(`Kept. ${kept.name}'s tools are called mcp.${kept.slug}.<tool>.`);
      return kept;
    } catch (err) {
      if (err instanceof GatewayError) { this.io.err(err.message); throw new Stop(1); }
      throw err;
    }
  }

  async review(name: string, opts: { keep: boolean; slug?: string }): Promise<number> {
    const { view } = await this.#find(name);
    await this.#review(view, opts);
    return 0;
  }

  /* ---------------------------------------------------------------- give */

  /** Agent ids, handles or names to ids; a sentence and a stop for one it does not know. */
  #agentIds(listing: ListAnswer, words: readonly string[]): string[] {
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const word of words) {
      const w = word.toLowerCase().replace(/^@/, '');
      const hit = listing.agents.find((a) => a.id === w || a.handle.toLowerCase().replace(/^@/, '') === w || a.name.toLowerCase() === w);
      if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else unknown.push(word);
    }
    if (unknown.length > 0) {
      this.io.err(`No such agent: ${unknown.join(', ')}. The agents: ${listing.agents.map((a) => a.handle || a.id).join(', ')}.`);
      throw new Stop(2);
    }
    return ids;
  }

  async #give(view: ConnectionView, to: string[] | undefined, listing: ListAnswer): Promise<number> {
    const grant = `mcp.${view.slug}.*`;
    let ids: string[];
    if (to !== undefined) ids = this.#agentIds(listing, to);
    else if (!this.io.interactive) {
      this.io.out(`It waits for an agent: buddi connections give ${view.slug} --to <agent>.`);
      return 0;
    } else {
      if (listing.agents.length === 0) { this.io.out('There is no agent to give it to yet.'); return 0; }
      this.io.out(`Give ${grant} to which agents?`);
      listing.agents.forEach((a, i) => this.io.out(`  ${i + 1}. ${a.name}${a.handle ? ` (${a.handle})` : ''}${a.frontDesk ? ', your front desk' : ''}`));
      const front = listing.agents.findIndex((a) => a.frontDesk);
      const fallback = front >= 0 ? String(front + 1) : '';
      const answer = (await this.io.ask(`Numbers or handles, comma-separated; nobody to keep it waiting${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
      if (answer === '' || answer.toLowerCase() === 'nobody') ids = [];
      else {
        const words = answer.split(',').map((w) => w.trim()).filter(Boolean).map((w) => {
          const n = Number(w);
          return Number.isInteger(n) && n >= 1 && n <= listing.agents.length ? listing.agents[n - 1]!.id : w;
        });
        ids = this.#agentIds(listing, words);
      }
    }
    if (ids.length === 0) {
      this.io.out(`Given to nobody: ${view.name} waits under Settings → Connections.`);
      return 0;
    }
    return this.#grant(view, ids, listing);
  }

  async #grant(view: ConnectionView, ids: string[], listing: ListAnswer): Promise<number> {
    const { body } = await this.gateway.post<{ granted: string[]; failed: Array<{ agent: string; message: string }> }>(
      `/api/connections/${view.id}/grant`, { agents: ids },
    );
    if (body.granted.length > 0) this.io.out(`Gave mcp.${view.slug}.* to ${this.#agentNames(listing, body.granted)}.`);
    for (const f of body.failed) this.io.err(`${this.#agentNames(listing, [f.agent])}: ${f.message}`);
    return body.failed.length > 0 ? 1 : 0;
  }

  async give(name: string, to: string[]): Promise<number> {
    const { view, listing } = await this.#find(name);
    if (!view.slug || view.state === 'pending-review') {
      this.io.err(`Review ${view.name}'s tools before giving them to an agent: buddi connections review "${view.name}".`);
      return 1;
    }
    const ids = this.#agentIds(listing, to);
    if (ids.length === 0) { this.io.out('Given to nobody; nothing changed.'); return 0; }
    return this.#grant(view, ids, listing);
  }

  /* -------------------------------------------------------------- remove */

  async remove(name: string, yes: boolean): Promise<number> {
    const { view, listing } = await this.#find(name);
    const who = view.agents.length > 0 ? ` ${this.#agentNames(listing, view.agents)} lose its tools.` : '';
    if (!yes) {
      if (!this.io.interactive) {
        this.io.err(`Run it again with --yes to disconnect ${view.name}.`);
        return 1;
      }
      if (!(await this.io.confirm(`Disconnect ${view.name}? Its sign-in is deleted.${who}`))) {
        this.io.out('Nothing was disconnected.');
        return 0;
      }
    }
    const { body } = await this.gateway.delete<{ name: string; touched: string[] }>(`/api/connections/${view.id}`);
    const touched = body.touched.length > 0 ? ` Its tools were taken from ${this.#agentNames(listing, body.touched)}.` : '';
    this.io.out(`Disconnected ${body.name ?? view.name}; its sign-in is deleted.${touched}`);
    return 0;
  }
}
