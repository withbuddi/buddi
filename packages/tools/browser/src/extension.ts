import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkUrl } from '@buddi/tool-web';
import { BrowserPreconditionError, type BrowserCommand, type BrowserDriver, type Observation } from './types.js';

/** Every frame name the owner's Chrome understands. */
export const EXTENSION_COMMANDS = ['navigate', 'observe', 'click', 'fill', 'select', 'press', 'scroll', 'tab', 'close', 'screenshot'] as const;
export type ExtensionCommandName = (typeof EXTENSION_COMMANDS)[number];

export interface ExtensionCommand {
  name: ExtensionCommandName;
  /** Conversation-scoped: the extension keeps one "buddi" tab group per session. */
  session: string;
  args: Record<string, unknown>;
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
  constructor(readonly bridge: ExtensionBridge, readonly allowedHosts?: readonly string[]) {}

  async start(): Promise<void> {
    if (!this.bridge.connected()) throw new Error(NOT_CONNECTED);
  }

  #invalidate(): void { this.#observation = undefined; this.#picture = undefined; }

  async #send(name: ExtensionCommandName, args: Record<string, unknown> = {}): Promise<ExtensionResult> {
    if (!this.bridge.connected()) throw new Error(NOT_CONNECTED);
    return this.bridge.send({ name, session: this.session, args });
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
  resume(): void { this.#invalidate(); }

  async close(): Promise<void> {
    this.#invalidate();
    // A closed socket has already forgotten the session; nothing to close.
    if (!this.bridge.connected()) return;
    await this.bridge.send({ name: 'close', session: this.session, args: {} }).catch(() => undefined);
  }
}
