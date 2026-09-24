import { BrowserService, type BrowserController, type BrowserHandOffer, type BrowserScope, type BrowserStatus, type BrowserRollover, type SecretFillInput, type SecretTypeInput } from './service.js';
import type { BrowserCommand, BrowserDriver } from './types.js';
import type { ToolContext } from '@buddi/core/plugin';

/** Routes trusted identities to independent controllers, never model arguments.
 * The gate persists global Stop. Children share a host but only own their tabs. */
export class BrowserManager implements BrowserController {
  #children = new Map<string, BrowserService>();
  #opening = new Set<string>();
  #requests = new Map<string, { key: string; expiresAt: number; ended: boolean }>();
  #gate: BrowserService;
  #enabled = false;
  #stopped = false;
  #controlling = false;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly createDriver: () => BrowserDriver, readonly options: {
    controlFile?: string; maxSessions?: number; lifetimeMs?: number; maxSteps?: number;
    closeHost?: () => Promise<void>;
    allowOpen?: boolean;
  } = {}) {
    this.#gate = new BrowserService({ start: async () => {}, perform: async () => {},
      observe: async () => { throw new Error('Gate has no page'); }, screenshot: async () => undefined,
      close: async () => {} }, options);
  }
  async enable(): Promise<void> {
    if (this.#enabled) return;
    this.#controlling = false;
    await this.#gate.enable(); this.#enabled = true; this.#stopped = this.#gate.status().state === 'stopped';
  }
  #empty(): BrowserStatus { return { state: !this.#enabled ? 'unavailable' : this.#stopped ? 'stopped' : 'idle', enabled: this.#enabled, busy: false, hasScreenshot: false }; }
  #find(scope: BrowserScope): BrowserService | undefined {
    return [...this.#children.values()].find((child) => {
      const session = child.status().session;
      return session && (scope.sessionId !== undefined ? session.id === scope.sessionId : session.agentId === scope.agentId && session.conversationId === scope.conversationId);
    });
  }
  status(scope?: BrowserScope): BrowserStatus {
    if (scope) return this.#find(scope)?.status() ?? this.#empty();
    const sessions = [...this.#children.values()].map((child) => child.status()).filter((status) => status.session);
    const latest = sessions.at(-1) ?? this.#empty();
    return { ...latest, busy: latest.busy || this.#opening.size > 0 || this.#controlling, sessions };
  }
  screenshot(sessionId?: string): Buffer | undefined {
    const id = sessionId ?? this.status().session?.id;
    return id ? this.#find({ sessionId: id })?.screenshot() : undefined;
  }
  /** The hand belongs to one conversation's session, never to "the browser". */
  hand(scope?: BrowserScope): BrowserHandOffer {
    const child = scope ? this.#find(scope) : undefined;
    if (!child) return { supported: true, message: 'The browser session changed. Refresh before driving it.' };
    return child.hand(scope);
  }
  rollover(input: BrowserRollover): boolean {
    if (!this.#enabled || this.#stopped || this.#controlling) return false;
    const oldKey = JSON.stringify([input.ownerId, input.agentId, input.previousConversationId]);
    const newKey = JSON.stringify([input.ownerId, input.agentId, input.conversationId]);
    const child = this.#children.get(oldKey);
    if (!child) return false;
    if (oldKey === newKey || this.#children.has(newKey) || this.#opening.has(oldKey)) throw new Error('Cannot transfer this browser conversation.');
    if (!child.rollover(input)) return false;
    // Synchronous: no command or owner control can interleave with re-keying.
    this.#children.delete(oldKey);
    this.#children.set(newKey, child);
    for (const request of this.#requests.values()) if (request.key === oldKey) request.ended = true;
    return true;
  }
  #sweep(): void {
    for (const [id, record] of this.#requests) if (record.expiresAt <= Date.now()) this.#requests.delete(id);
    for (const [key, child] of this.#children) if (!this.#opening.has(key) && !child.status().session && !child.status().busy) {
      for (const request of this.#requests.values()) if (request.key === key) request.ended = true;
      this.#children.delete(key);
    }
  }
  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    const request = ctx.ownerRequest;
    if (!request?.id || !request.text.trim() || request.expiresAt <= Date.now() || !ctx.agentId || !ctx.conversationId || (ctx.delegationDepth ?? 0) > 0) throw new Error('A current authenticated owner request is required.');
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve.');
    if (this.#stopped) throw new Error('The owner stopped all browser sessions. Only the owner can resume access.');
    if (this.#controlling) throw new Error('Browser owner controls are changing. Wait for them to settle.');
    this.#sweep();
    const key = JSON.stringify([ctx.buddi!.owner.id, ctx.agentId, ctx.conversationId]);
    if (this.#opening.has(key)) throw new Error('This conversation is opening its browser tab. Wait for that action.');
    const prior = this.#requests.get(request.id);
    if (prior && (prior.ended || prior.key !== key)) throw new Error('This browser request has ended or belongs to another conversation. A new owner message is required.');
    let child = this.#children.get(key);
    if (!child) {
      if (command.action === 'close') {
        this.#requests.set(request.id, { key, expiresAt: request.expiresAt, ended: true });
        return { closed: true };
      }
      if (command.action !== 'navigate' && !(this.options.allowOpen && command.action === 'open')) throw new Error('Start with navigate and the website the owner requested, or open an allowed app in computer mode.');
      if (this.#children.size >= (this.options.maxSessions ?? 8)) throw new Error(this.options.allowOpen && this.options.maxSessions === 1 ? 'Another conversation owns computer control. The desktop has one mouse and keyboard. Ask the owner to release it; do not switch to browser automation automatically.' : 'All browser conversation slots are in use. Close a finished session in the Browser page.');
      child = new BrowserService(this.createDriver(), { lifetimeMs: this.options.lifetimeMs, maxSteps: this.options.maxSteps, allowOpen: this.options.allowOpen });
      this.#children.set(key, child);
      this.#opening.add(key);
      try { await child.enable(); } finally { this.#opening.delete(key); }
      // A Stop may arrive while enable yields, before the child starts.
      if (this.#stopped || this.#controlling || !this.#enabled) throw new Error('Browser access changed while opening the session.');
    }
    this.#requests.set(request.id, { key, expiresAt: request.expiresAt, ended: false });
    try { return await child.execute(command, ctx); }
    finally { this.#sweep(); }
  }
  /**
   * The child this conversation owns, under the same gates `execute` runs: a
   * secret use is a browser action too, and every one of those gates guards
   * the value's one route through it. There is no bootstrap here — a secret
   * acts on a page the conversation is already driving, so a conversation with
   * no session has nothing for it to act on.
   */
  #sessionFor(ctx: ToolContext, what: string): BrowserService {
    ctx.signal?.throwIfAborted();
    const request = ctx.ownerRequest;
    if (!request?.id || !request.text.trim() || request.expiresAt <= Date.now() || !ctx.agentId || !ctx.conversationId || (ctx.delegationDepth ?? 0) > 0) throw new Error('A current authenticated owner request is required.');
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve.');
    if (this.#stopped) throw new Error('The owner stopped all browser sessions. Only the owner can resume access.');
    if (this.#controlling) throw new Error('Browser owner controls are changing. Wait for them to settle.');
    this.#sweep();
    const key = JSON.stringify([ctx.buddi!.owner.id, ctx.agentId, ctx.conversationId]);
    if (this.#opening.has(key)) throw new Error('This conversation is opening its browser tab. Wait for that action.');
    const prior = this.#requests.get(request.id);
    if (prior && (prior.ended || prior.key !== key)) throw new Error('This browser request has ended or belongs to another conversation. A new owner message is required.');
    const child = this.#children.get(key);
    if (!child) throw new Error(`Start with navigate and observe before ${what}; it acts on the page this conversation is already driving.`);
    this.#requests.set(request.id, { key, expiresAt: request.expiresAt, ended: false });
    return child;
  }
  async secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown> {
    const child = this.#sessionFor(ctx, 'secret.fill');
    try { return await child.secretFill(input, ctx); }
    finally { this.#sweep(); }
  }
  async secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown> {
    const child = this.#sessionFor(ctx, 'secret.type');
    try { return await child.secretType(input, ctx); }
    finally { this.#sweep(); }
  }
  control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string): Promise<BrowserStatus> {
    const run = async () => {
      if (!this.#enabled) throw new Error('The host browser service is unavailable.');
      const child = sessionId ? this.#find({ sessionId }) : undefined;
      if (sessionId && !child) throw new Error('The browser session changed. Refresh before controlling it.');
      if (action === 'stop') {
        this.#stopped = true; this.#controlling = true;
        try {
          const closing = Promise.all([...this.#children.values()].map((value) => value.control('stop')));
          for (const request of this.#requests.values()) request.ended = true;
          await this.#gate.control('stop');
          await closing; await this.options.closeHost?.(); this.#children.clear();
        } finally { this.#controlling = false; }
        return this.status();
      }
      if (action === 'resume' && !sessionId) {
        this.#controlling = true;
        try { await this.#gate.control('resume'); this.#stopped = false; }
        finally { this.#controlling = false; }
        return this.status();
      }
      if (!child) {
        // No implicit selection when several agents are active.
        const active = [...this.#children.values()].filter((value) => value.status().session);
        if (active.length === 0 && action === 'release') return this.status();
        throw new Error('Select a browser conversation before using this control.');
      }
      await child.control(action, sessionId);
      this.#sweep();
      return this.status();
    };
    const next = this.#tail.then(run, run); this.#tail = next.catch(() => {}); return next;
  }
  async shutdown(): Promise<void> {
    this.#enabled = false; this.#controlling = true;
    await Promise.all([...this.#children.values()].map((child) => child.shutdown()));
    await this.options.closeHost?.(); await this.#gate.shutdown(); this.#children.clear();
  }
}
