import { BrowserService, type BrowserServiceOptions, type BrowserHandOffer, type BrowserScope, type BrowserStatus, type BrowserRollover, type SecretFillInput, type SecretTypeInput } from './service.js';
import type { BrowserCommand, BrowserDriver } from './types.js';
import type { ToolContext } from '@buddi/core/plugin';
import { originOf } from './routes.js';
import { missionMark } from './telemetry.js';
import type { OwnerCard } from './routes.js';

export interface BrowserManagerOptions extends BrowserServiceOptions {
  /** Pages open at once on this route; one more waits its turn (never an error to the owner). */
  maxSessions?: number;
  /** The owner's Chrome: two conversations never act on the same origin at the same time. */
  siteLocks?: boolean;
  /** A page with no action for this long may be let go for a conversation that is waiting. */
  idleEvictMs?: number;
  /** How long a conversation waits for a page before it is told every page is busy. */
  queueTimeoutMs?: number;
  closeHost?: () => Promise<void>;
}

/** The waiting conversation re-checks at least this often, beside being woken on every release. */
const QUEUE_POLL_MS = 1_000;

/**
 * One route's pages: one per conversation.
 *
 * Several agents may look at once. A route with a cap (the own browser's
 * three pages, the desktop's one) queues the next conversation instead of
 * refusing it, and lets go of a page nobody has touched for a while when
 * someone waits. In the owner's Chrome, actions on the same origin are
 * serialised so two agents never type into one site together.
 */
export class BrowserManager {
  #children = new Map<string, BrowserService>();
  #opening = new Map<string, Promise<BrowserService>>();
  #waiters: Array<() => void> = [];
  /** Slots claimed by conversations still opening their page. */
  #reserved = 0;
  /** Calls in flight per conversation: a page about to be used is never swept or evicted. */
  #inflight = new Map<string, number>();
  #locks = new Map<string, Promise<void>>();
  /** Where each conversation's page last was, so a page let go opens again where it stood. */
  #lastUrls = new Map<string, string>();
  #enabled = false;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly createDriver: () => BrowserDriver, readonly options: BrowserManagerOptions = {}) {}
  get #now(): number { return this.options.now?.() ?? Date.now(); }
  async enable(): Promise<void> { this.#enabled = true; }
  get enabled(): boolean { return this.#enabled; }
  #empty(): BrowserStatus { return { state: !this.#enabled ? 'unavailable' : 'idle', enabled: this.#enabled, busy: false, hasScreenshot: false }; }
  #find(scope: BrowserScope): BrowserService | undefined {
    return [...this.#children.values()].find((child) => {
      const session = child.status().session;
      return session && (scope.sessionId !== undefined ? session.id === scope.sessionId : session.agentId === scope.agentId && session.conversationId === scope.conversationId);
    });
  }
  /** The page a conversation has on this route, if any. */
  child(scope: BrowserScope): BrowserService | undefined { return this.#find(scope); }
  /** Every page with a session, for the dashboard. */
  pages(): BrowserService[] { return [...this.#children.values()].filter((child) => child.status().session); }
  status(scope?: BrowserScope): BrowserStatus {
    if (scope) return this.#find(scope)?.status() ?? this.#empty();
    const sessions = this.pages().map((child) => child.status());
    const latest = sessions.at(-1) ?? this.#empty();
    return { ...latest, busy: latest.busy || this.#opening.size > 0, sessions };
  }
  screenshot(sessionId?: string): Buffer | undefined {
    const id = sessionId ?? this.status().session?.id;
    return id ? this.#find({ sessionId: id })?.screenshot() : undefined;
  }
  hand(scope?: BrowserScope): BrowserHandOffer {
    const child = scope ? this.#find(scope) : undefined;
    if (!child) return { supported: true, message: 'That page changed. Refresh before driving it.' };
    return child.hand(scope);
  }
  rollover(input: BrowserRollover): boolean {
    if (!this.#enabled) return false;
    const oldKey = JSON.stringify([input.ownerId, input.agentId, input.previousConversationId]);
    const newKey = JSON.stringify([input.ownerId, input.agentId, input.conversationId]);
    const child = this.#children.get(oldKey);
    if (!child) return false;
    if (oldKey === newKey || this.#children.has(newKey) || this.#opening.has(oldKey)) throw new Error('Cannot transfer this browser conversation.');
    if (!child.rollover(input)) return false;
    this.#children.delete(oldKey);
    this.#children.set(newKey, child);
    return true;
  }
  #sweep(): void {
    for (const [key, child] of this.#children) if (!this.#opening.has(key) && !this.#inflight.get(key) && !child.status().session && !child.busy) {
      if (child.lastUrl) this.#lastUrls.set(this.#urlKey(key), child.lastUrl);
      this.#children.delete(key);
    }
    for (const wake of this.#waiters.splice(0)) wake();
  }
  /**
   * Wait for a page on this route. A page idle long enough is let go for the
   * waiting conversation; otherwise it waits, woken by every release. Only a
   * wait of many minutes says anything, and then to the agent.
   */
  async #slot(signal: AbortSignal | undefined, onWait: () => void): Promise<void> {
    const max = this.options.maxSessions;
    if (max === undefined) return;
    const deadline = this.#now + (this.options.queueTimeoutMs ?? 10 * 60_000);
    let waited = false;
    for (;;) {
      this.#sweep();
      if (this.#children.size + this.#reserved < max) { this.#reserved++; return; }
      const idleMs = this.options.idleEvictMs ?? 2 * 60_000;
      const idle = [...this.#children].filter(([key, child]) => !this.#inflight.get(key) && child.idleFor() >= idleMs).sort((a, b) => b[1].idleFor() - a[1].idleFor())[0];
      if (idle) {
        const [key, child] = idle;
        if (child.lastUrl) this.#lastUrls.set(this.#urlKey(key), child.lastUrl);
        this.#children.delete(key);
        await child.control('release').catch(() => undefined);
        continue;
      }
      if (this.#now >= deadline) throw new Error('Every page is busy with other agents right now. Try again in a few minutes.');
      if (!waited) { waited = true; onWait(); }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, QUEUE_POLL_MS);
        timer.unref?.();
        this.#waiters.push(() => { clearTimeout(timer); resolve(); });
      });
      signal?.throwIfAborted();
    }
  }
  /** Serialise actions on one origin, across conversations. */
  async #withLock<T>(origin: string | undefined, run: () => Promise<T>): Promise<T> {
    if (!origin || !this.options.siteLocks) return run();
    const previous = this.#locks.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => mine);
    this.#locks.set(origin, chained);
    await previous;
    try { return await run(); }
    finally { release(); if (this.#locks.get(origin) === chained) this.#locks.delete(origin); }
  }
  /** Where a conversation's page should open when it next comes to this route. */
  remember(agentId: string, conversationId: string, url: string): void { this.#lastUrls.set(`${agentId}|${conversationId}`, url); }
  #urlKey(key: string): string { const [, agent, conversation] = JSON.parse(key) as string[]; return `${agent}|${conversation}`; }
  async #childFor(ctx: ToolContext, create: boolean): Promise<BrowserService | undefined> {
    const key = JSON.stringify([ctx.buddi!.owner.id, ctx.agentId, ctx.conversationId]);
    const existing = this.#children.get(key) ?? await this.#opening.get(key);
    if (existing || !create) return existing;
    const opening = (async () => {
      await this.#slot(ctx.signal, () => this.options.telemetry?.stop('slot-limit', { route: this.options.route ?? 'own', ...(ctx.agentId ? { agent: ctx.agentId } : {}), ...missionMark(ctx) }));
      const reserved = this.options.maxSessions !== undefined;
      try {
        const child = new BrowserService(this.createDriver(), this.options);
        await child.enable();
        const last = this.#lastUrls.get(this.#urlKey(key));
        if (last) child.seed(last);
        this.#children.set(key, child);
        return child;
      } finally { if (reserved) this.#reserved--; }
    })();
    this.#opening.set(key, opening);
    try { return await opening; } finally { this.#opening.delete(key); }
  }
  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    if (!ctx.agentId || !ctx.conversationId) throw new Error('A browser action belongs to an agent and a conversation.');
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve.');
    this.#sweep();
    const key = JSON.stringify([ctx.buddi!.owner.id, ctx.agentId, ctx.conversationId]);
    this.#inflight.set(key, (this.#inflight.get(key) ?? 0) + 1);
    try {
      if (command.action === 'close' && !(await this.#childFor(ctx, false))) return { closed: true };
      const child = (await this.#childFor(ctx, true))!;
      const origin = originOf(command.action === 'navigate' ? command.url : child.lastUrl);
      return await this.#withLock(origin, () => child.execute(command, ctx));
    } finally {
      const left = (this.#inflight.get(key) ?? 1) - 1;
      if (left > 0) this.#inflight.set(key, left); else this.#inflight.delete(key);
      this.#sweep();
    }
  }
  /** The page this conversation already has: a secret acts on a page, it never opens one. */
  async #sessionFor(ctx: ToolContext, what: string): Promise<BrowserService> {
    ctx.signal?.throwIfAborted();
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve.');
    const child = await this.#childFor(ctx, false);
    if (!child || !child.status().session) throw new Error(`Open the page with browser.act navigate before ${what}; it acts on the page this conversation is already on.`);
    return child;
  }
  async secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown> {
    const child = await this.#sessionFor(ctx, 'secret.fill');
    try { return await this.#withLock(originOf(child.lastUrl), () => child.secretFill(input, ctx)); }
    finally { this.#sweep(); }
  }
  async secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown> {
    const child = await this.#sessionFor(ctx, 'secret.type');
    try { return await child.secretType(input, ctx); }
    finally { this.#sweep(); }
  }
  /** The owner touched this conversation: renew budgets, clear cards. Returns the cards cleared, with their pages. */
  renew(conversationId: string, agentId?: string): Array<{ child: BrowserService; card: OwnerCard | undefined }> {
    return this.pages().filter((child) => {
      const session = child.status().session!;
      return session.conversationId === conversationId && (agentId === undefined || session.agentId === agentId);
    }).map((child) => ({ child, card: child.renew() }));
  }
  /** Let go of a conversation's page on this route (it moved to another route). */
  async release(conversationId: string, agentId?: string): Promise<void> {
    for (const [key, child] of [...this.#children]) {
      const session = child.status().session;
      if (!session || session.conversationId !== conversationId || (agentId !== undefined && session.agentId !== agentId)) continue;
      if (child.lastUrl) this.#lastUrls.set(this.#urlKey(key), child.lastUrl);
      await child.control('release').catch(() => undefined);
    }
    this.#sweep();
  }
  control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string): Promise<BrowserStatus> {
    const run = async () => {
      if (!this.#enabled) throw new Error('The host browser service is unavailable.');
      if (action === 'stop' && !sessionId) {
        await Promise.all([...this.#children.values()].map((child) => child.control('stop').catch(() => undefined)));
        await this.options.closeHost?.();
        this.#children.clear();
        this.#sweep();
        return this.status();
      }
      const child = sessionId ? this.#find({ sessionId }) : undefined;
      if (sessionId && !child) throw new Error('That page changed. Refresh before controlling it.');
      if (!child) {
        if (this.pages().length === 0 && (action === 'release' || action === 'resume')) return this.status();
        throw new Error('Select a page before using this control.');
      }
      await child.control(action === 'stop' ? 'release' : action, sessionId);
      this.#sweep();
      return this.status();
    };
    const next = this.#tail.then(run, run); this.#tail = next.catch(() => {}); return next;
  }
  async shutdown(): Promise<void> {
    this.#enabled = false;
    await Promise.all([...this.#children.values()].map((child) => child.shutdown()));
    await this.options.closeHost?.(); this.#children.clear();
    for (const wake of this.#waiters.splice(0)) wake();
  }
}
