import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkUrl } from '@buddi/core/plugin';
import { BrowserPreconditionError, HAND_QUALITY, type BrowserCommand, type BrowserDriver, type BrowserHand, type HandFrame, type HandInput, type HandQuality, type Observation } from './types.js';

/** Every frame name the owner's Chrome understands. */
export const EXTENSION_COMMANDS = ['navigate', 'observe', 'click', 'fill', 'select', 'press', 'scroll', 'tab', 'close', 'screenshot'] as const;
/**
 * The take-over's own three, kept out of the list above.
 *
 * Nothing an agent can name reaches them: they exist for the owner's hand, and
 * the extension keeps the same split on its side.
 */
export const HAND_COMMANDS = ['screencast.start', 'screencast.stop', 'input'] as const;
export type ExtensionCommandName = (typeof EXTENSION_COMMANDS)[number] | (typeof HAND_COMMANDS)[number];

export interface ExtensionCommand {
  name: ExtensionCommandName;
  /** Conversation-scoped: the extension keeps one "buddi" tab group per session. */
  session: string;
  args: Record<string, unknown>;
  /**
   * The owner's own hand, not the agent's.
   *
   * The extension refuses input into a tab the owner is looking at, which is
   * exactly the wrong answer when the owner is the one driving. Only the
   * remote hand sets this, and only for `input`.
   */
  owner?: boolean;
}
export interface ExtensionResult {
  observation?: unknown;
  /** A base64 PNG, when the command was one that captures. */
  screenshot?: string | null;
}

/**
 * The gateway's WebSocket endpoint, seen from the plugin.
 *
 * The plugin must not import `@buddi/gateway`, so the shape lives here and the
 * gateway implements it. `send` rejects with `BrowserPreconditionError` when
 * the extension answered `precondition: true`, meaning nothing was dispatched.
 */
export interface ExtensionBridge {
  connected(): boolean;
  send(command: ExtensionCommand): Promise<ExtensionResult>;
  close(): void;
  /**
   * Resolves once nothing this bridge gave up on is still being cancelled.
   *
   * A command that timed out may still be half-done in the owner's browser, so
   * the driver waits here rather than dispatching the next one onto a page
   * nobody has seen since.
   */
  idle?(): Promise<void>;
  /**
   * Tell the browser to abandon everything still in flight, and keep the socket.
   *
   * What a take-over during an action needs: the command stops, the tab does
   * not. `idle()` is what says the browser has finished stopping.
   */
  abort?(reason?: string): void;
  /**
   * Screencast frames for one session, which arrive unasked rather than as the
   * answer to a command. Returns the unsubscribe.
   */
  frames?(session: string, onFrame: (frame: HandFrame) => void): () => void;
}

export const NOT_CONNECTED = 'Your browser is not connected. Open the buddi extension in Chrome and press Connect.';

/** What the extension is allowed to claim about a page. */
const observationSchema = z.object({
  url: z.string().max(4096).default(''),
  title: z.string().max(1000).default(''),
  tree: z.string().max(200_000).default(''),
  targets: z.array(z.object({
    ref: z.string().min(1).max(40),
    frame: z.number().int().min(0).max(10).default(0),
    role: z.string().max(60).default(''),
    name: z.string().max(300).default(''),
    href: z.string().max(2048).optional(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  })).max(400).default([]),
  tabs: z.array(z.object({ id: z.string().max(40), url: z.string().max(4096).default(''), title: z.string().max(1000).default('') })).max(100).default([]),
}).passthrough();

/**
 * The owner's own Chrome, driven through the buddi extension.
 *
 * Same observation shape as the Playwright driver, so an agent cannot tell
 * which backend answered. The identity of the evidence stays here rather than
 * with the extension: the driver stamps `id` and `capturedAt`, and refuses any
 * action whose `observation` is not the latest one it issued.
 */
export class ExtensionDriver implements BrowserDriver {
  /** Close removes this session's tab group, so the tabs do not outlive it. */
  readonly preservesWindows = false;
  readonly session = randomUUID();
  #observation?: Observation;
  #picture?: Buffer;
  /** Set when a command failed: the next one waits for the browser to settle. */
  #settling?: Promise<void>;
  constructor(readonly bridge: ExtensionBridge, readonly allowedHosts?: readonly string[]) {}

  async start(): Promise<void> {
    if (!this.bridge.connected()) throw new Error(NOT_CONNECTED);
  }

  #invalidate(): void { this.#observation = undefined; this.#picture = undefined; }

  async #send(name: ExtensionCommandName, args: Record<string, unknown> = {}, owner = false): Promise<ExtensionResult> {
    // A failure left the page in an unknown state and possibly a command still
    // being abandoned. Nothing else goes out until that has settled.
    const settling = this.#settling;
    if (settling) { this.#settling = undefined; await settling; }
    if (!this.bridge.connected()) throw new Error(NOT_CONNECTED);
    try {
      return await this.bridge.send({ name, session: this.session, args, ...(owner ? { owner: true } : {}) });
    } catch (error) {
      this.#invalidate();
      this.#settling = Promise.resolve(this.bridge.idle?.()).then(() => undefined, () => undefined);
      throw error;
    }
  }

  /** Where the browser says it is, checked against where it is allowed to be. */
  #checkHost(url: string): void {
    if (url === '' || !this.allowedHosts?.length) return;
    let hostname: string;
    try { hostname = checkUrl(url).url.hostname; }
    catch { throw new BrowserPreconditionError('Your browser is on an address this buddi cannot read. Navigate somewhere allowed and observe again.'); }
    // A redirect can land anywhere; the allow list is about where the browser
    // ends up, not only about where it was asked to go.
    if (!this.allowedHosts.includes(hostname)) throw new BrowserPreconditionError('This website is outside the configured browser hosts.');
  }

  async perform(command: BrowserCommand): Promise<void> {
    if (command.action === 'open' || command.target?.x !== undefined) throw new BrowserPreconditionError('Native apps and coordinate targets require Computer mode.');
    if (command.action === 'close') { await this.close(); return; }
    if (command.action === 'observe') return;
    if (command.action === 'navigate') {
      const checked = checkUrl(command.url!).url;
      if (this.allowedHosts?.length && !this.allowedHosts.includes(checked.hostname)) throw new BrowserPreconditionError('This website is outside the configured browser hosts.');
      this.#invalidate();
      await this.#send('navigate', { url: checked.href });
      return;
    }
    if (command.action === 'tab') {
      this.#invalidate();
      await this.#send('tab', { tabId: command.tabId });
      return;
    }
    if (!this.#observation || command.observation !== this.#observation.id) throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.');
    const target = command.target ? { ref: command.target.ref, role: command.target.role, name: command.target.name, by: command.target.by, frame: command.target.frame } : undefined;
    const args: Record<string, unknown> = { ...(target ? { target } : {}), ...(command.value !== undefined ? { value: command.value } : {}),
      ...(command.key !== undefined ? { key: command.key } : {}), ...(command.direction !== undefined ? { direction: command.direction } : {}) };
    this.#invalidate(); // Never replay evidence once dispatch may have started.
    await this.#send(command.action, args);
  }

  async observe(): Promise<Observation> {
    const result = await this.#send('observe');
    const seen = observationSchema.parse(result.observation ?? {});
    this.#checkHost(seen.url);
    for (const tab of seen.tabs) this.#checkHost(tab.url);
    this.#picture = undefined;
    this.#observation = { id: randomUUID(), url: seen.url, title: seen.title, tree: seen.tree.slice(0, 32_000),
      targets: seen.targets, tabs: seen.tabs, capturedAt: new Date().toISOString() };
    return this.#observation;
  }

  /**
   * A second round trip, because capturing costs a debugger attach.
   *
   * `observe` answers with the tree alone; the picture is its own command, so a
   * caller that only wants evidence does not pay for one. Cached against the
   * observation it belongs to, since `BrowserService` asks once per action.
   */
  async screenshot(): Promise<Buffer | undefined> {
    if (this.#picture || !this.#observation) return this.#picture;
    const result = await this.#send('screenshot');
    this.#picture = typeof result.screenshot === 'string' && result.screenshot !== '' ? Buffer.from(result.screenshot, 'base64') : undefined;
    return this.#picture;
  }

  /** The owner keeps using Chrome: takeover only drops this agent's evidence. */
  async takeover(): Promise<void> { this.#invalidate(); }
  /**
   * The owner took over mid-action: the command is abandoned, the tab is not.
   *
   * Their Chrome is their own — closing the tab an agent happened to be in
   * would be taking a page away from the person who asked to see it.
   */
  async interrupt(): Promise<void> {
    if (!this.bridge.connected()) throw new BrowserPreconditionError(NOT_CONNECTED);
    this.#invalidate();
    this.bridge.abort?.('The owner took control during this action.');
    this.#settling = undefined;
    await this.bridge.idle?.().catch(() => undefined);
  }
  resume(): void { this.#invalidate(); }

  /**
   * The remote hand: a screencast out of the session's tab, and the owner's
   * pointer and keyboard into it.
   *
   * Frames do not come back as the answer to a command — the extension pushes
   * them — so the subscription is taken before the screencast is asked for,
   * and dropped when it stops. Input is marked `owner`, which is what lets it
   * through the extension's refusal to type into a tab being watched: the
   * watcher and the typist are the same person here.
   */
  readonly supportsHand = true;
  /** No socket to the owner's Chrome is no screencast out of it. */
  handReady(): boolean { return this.bridge.connected(); }
  #frames?: () => void;
  readonly hand: BrowserHand = {
    start: async (onFrame: (frame: HandFrame) => void, quality: HandQuality = HAND_QUALITY) => {
      this.#frames?.();
      this.#frames = this.bridge.frames?.(this.session, onFrame);
      this.#invalidate();
      await this.#send('screencast.start', { ...quality, everyNthFrame: 1 });
    },
    /**
     * A smaller picture, without dropping the subscription.
     *
     * `screencast.start` on a session that already has one restarts it, which
     * is exactly what a re-tune is; the frames keep arriving on the same
     * listener because that listener belongs to the session, not to the cast.
     */
    tune: async (quality: HandQuality) => {
      if (!this.#frames || !this.bridge.connected()) return;
      await this.#send('screencast.start', { ...quality, everyNthFrame: 1 }).catch(() => undefined);
    },
    input: async (event: HandInput) => { await this.#send('input', event as unknown as Record<string, unknown>, true); },
    stop: async () => {
      this.#frames?.();
      this.#frames = undefined;
      if (!this.bridge.connected()) return;
      await this.#send('screencast.stop').catch(() => undefined);
    },
  };

  async close(): Promise<void> {
    this.#invalidate();
    this.#frames?.();
    this.#frames = undefined;
    // A closed socket has already forgotten the session; nothing to close.
    if (!this.bridge.connected()) return;
    await this.bridge.send({ name: 'close', session: this.session, args: {} }).catch(() => undefined);
  }
}
