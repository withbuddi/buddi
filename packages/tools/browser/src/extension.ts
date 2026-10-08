import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkUrl } from '@buddi/core/plugin';
import { fieldOrigin } from './secrets.js';
import type { PendingDownload } from './downloads.js';
import { BrowserPreconditionError, HAND_QUALITY, MAX_HAND_COPY, type BrowserCommand, type BrowserDriver, type BrowserHand, type HandFrame, type HandInput, type HandQuality, type Observation, type LoginAck, type LoginCheck, type LoginSeenListener, LOGIN_GONE, LOGIN_GRACE_MS } from './types.js';

/** Every frame name the owner's Chrome understands. */
export const EXTENSION_COMMANDS = ['navigate', 'observe', 'click', 'fill', 'select', 'press', 'scroll', 'tab', 'close', 'screenshot', 'fieldInfo', 'secretFill'] as const;
/**
 * The take-over's own, kept out of the list above: the screencast pair and
 * `input` for the remote hand and the Canvas's live picture, `copy` for the
 * owner's Cmd/Ctrl+C on it, `capture` for the Canvas's Capture, and
 * `hold`/`unhold` for Bring the tab to the front (the tab brought forward in
 * the owner's Chrome, its bar saying buddi waits).
 *
 * Nothing an agent can name reaches them: they exist for the owner's hand, and
 * the extension keeps the same split on its side. `fieldInfo` and `secretFill`
 * are the owner's-secret pair — `secret.fill` rides them the way `browser.act`
 * rides the rest — and only the driver sends them.
 */
export const HAND_COMMANDS = ['screencast.start', 'screencast.stop', 'input', 'hold', 'unhold', 'capture', 'copy'] as const;
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
  /** The field facts `fieldInfo` answered; they ride inside `observation` on the wire. */
  field?: { origin: string; password: boolean; name: string };
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
  /** A pairing record exists, whether or not Chrome is connected right now. */
  paired?(): boolean;
  /**
   * What the connected extension said it can do in its hello. `live`: the
   * Canvas's watching picture, painted in a background tab, the remote hand,
   * `capture`, `copy` and the window's buttons. An extension from before
   * says nothing, and a take-over brings its tab to the front instead.
   */
  supports?(feature: string): boolean;
  /**
   * What the owner did in the page itself, for one session: `takeover` from the
   * in-tab bar's Take over. Returns the unsubscribe. Since extension protocol
   * "bar" (docs/browser.md, "Work in view").
   */
  events?(session: string, listener: (event: ExtensionEvent) => void): () => void;
  /**
   * A sign-in the owner answered in a tab they hold (the waiting bar's "Save
   * this login?"), for one session: Save with the pair, Never with the site.
   * Only from the paired socket. A Save is answered with what became of it
   * (the bar says Saved, or why not). Returns the unsubscribe.
   */
  logins?(session: string, listener: (login: ExtensionLogin) => Promise<LoginAck | LoginCheck> | void): () => void;
  /**
   * A download an agent's action started in this session's tab finished in
   * the owner's Chrome (extension with the optional `downloads` permission).
   * Only from the paired socket. Returns the unsubscribe.
   */
  downloads?(session: string, listener: (file: ExtensionDownload) => void): () => void;
}
/**
 * A finished download in the owner's Chrome: where Chrome saved it on this
 * machine and what it reported. The browser service reads the file under the
 * downloads store's checks (in the owner's home, just written, the size Chrome
 * reported, not a link) and never anything else.
 */
export interface ExtensionDownload { path: string; filename: string; url: string; mime?: string; size?: number }
/** How long after an agent's action a finished download in the owner's Chrome is still that action's. */
export const DOWNLOAD_WINDOW_MS = 5 * 60 * 1000;
/** What the extension sends when the owner answers the save prompt in a held tab. The password only with Save. */
export interface ExtensionLogin { decision: 'save' | 'never' | 'check'; origin: string; username: string; password?: string }
/** What the extension needs before it asks: sites never to ask about, and logins already kept. */
export interface ExtensionLoginFacts { never: string[]; saved: Array<{ site: string; username: string }> }
/** How long after Give it back a Save tapped in the tab still counts. */
export { LOGIN_GRACE_MS, LOGIN_GONE };
/**
 * An unsolicited event from the extension about one session: `takeover` from
 * the working bar, `giveback` from the bar a held tab shows (extension
 * from 0.1.0-pre.39).
 */
export type ExtensionEvent = 'takeover' | 'giveback' | 'castended';

/** How the Canvas's picture is painted while an agent works: the hand's normal size, two frames a second. */
export const WATCH_QUALITY = { ...HAND_QUALITY, interval: 500 } as const;

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
  constructor(readonly bridge: ExtensionBridge, readonly allowedHosts?: readonly string[], readonly options: { logins?: () => ExtensionLoginFacts; now?: () => number } = {}) {}

  async start(): Promise<void> {
    if (!this.bridge.connected()) throw new Error(NOT_CONNECTED);
    if (!this.#downloadsOff) this.#downloadsOff = this.bridge.downloads?.(this.session, (file) => this.#downloaded(file));
  }

  #downloadsOff?: () => void;
  #downloads: PendingDownload[] = [];
  /** When this driver last sent an action that can start a download; nothing before that is the agent's. */
  #lastAction = -Infinity;
  #downloaded(file: ExtensionDownload): void {
    const now = this.options.now?.() ?? Date.now();
    if (now - this.#lastAction > DOWNLOAD_WINDOW_MS || this.#downloads.length >= 20) return;
    this.#downloads.push({ filename: file.filename, url: file.url, read: { path: file.path },
      ...(file.mime ? { mime: file.mime } : {}), ...(file.size !== undefined ? { size: file.size } : {}) });
  }
  takeDownloads(): PendingDownload[] { return this.#downloads.splice(0); }

  #events?: () => void;
  #onTakeover?: () => void;
  #onGiveBack?: () => void;
  #listen(): void {
    this.#events?.();
    this.#events = this.bridge.events?.(this.session, (event) => {
      if (event === 'takeover') this.#onTakeover?.();
      else if (event === 'giveback') this.#onGiveBack?.();
      // Chrome took the picture away (the tab closed, or the owner pressed Cancel on its debugging bar).
      else if (event === 'castended') { this.#latest = undefined; this.#watching = false; }
    });
  }
  /** The in-tab bar's Take over: the service treats it as the Canvas button. */
  onOwnerTakeover(listener: () => void): void { this.#onTakeover = listener; this.#listen(); }
  /** The held tab's Give it back: the service treats it as the Canvas's. */
  onOwnerGiveBack(listener: () => void): void { this.#onGiveBack = listener; this.#listen(); }
  /** Does the connected extension paint its tabs live (focus emulated) and take the remote hand? */
  #live(): boolean { return this.bridge.supports?.('live') === true; }
  /**
   * Only an extension from before the live picture holds the page in place on
   * Take over: its background tab never painted, so its tab came to the front
   * instead. A live one is taken over like buddi's own browser, from wherever
   * the owner is, and Bring the tab to the front is its own action.
   */
  get holdsInPlace(): 'chrome' | undefined { return this.#live() ? undefined : 'chrome'; }

  /*
   * The Canvas's picture. One subscription for the driver's life: every frame
   * the extension paints for this session lands here, the newest is kept for
   * the Page tab (`livePicture`), and while the owner holds the page the same
   * frames go to their hand.
   */
  #latest?: HandFrame;
  #watching = false;
  #handFrames?: (frame: HandFrame) => void;
  #subscribed?: () => void;
  #subscribe(): void {
    if (this.#subscribed || !this.bridge.frames) return;
    this.#subscribed = this.bridge.frames(this.session, (frame) => {
      this.#latest = frame;
      this.#handFrames?.(frame);
    });
  }
  /** The newest frame of the page as it is now, while the extension paints it. Never evidence. */
  livePicture(): Buffer | undefined { return this.#watching || this.#handFrames ? this.#latest?.jpeg : undefined; }
  /**
   * Ask the extension to paint this session's tab for the Canvas. Idempotent
   * on its side; it follows the agent to a new tab by itself. A failure is a
   * picture missing, never a failed action.
   */
  async #watch(): Promise<void> {
    if (!this.#live() || this.#handFrames || !this.bridge.connected()) return;
    this.#subscribe();
    try {
      await this.bridge.send({ name: 'screencast.start', session: this.session, args: { ...WATCH_QUALITY, everyNthFrame: 1, watch: true } });
      this.#watching = true;
    } catch { this.#watching = false; }
  }

  /** Whether the owner holds this session's tab, and until when a Save tapped there still counts after they gave it back. */
  #held = false;
  #heldUntil = 0;
  #logins?: () => void;
  /**
   * A sign-in the owner answered in the tab they hold. Only while they hold it
   * (or just gave it back): a Save from a tab buddi is driving is not the
   * owner's. The pair goes to the listener and nowhere else.
   */
  onLoginSeen(listener: LoginSeenListener): void {
    this.#logins?.();
    this.#logins = this.bridge.logins?.(this.session, (login) => {
      const now = this.options.now?.() ?? Date.now();
      if (login.decision === 'check' && !this.#held) return Promise.resolve({ ask: 'none' as const });
      if (!this.#held && now >= this.#heldUntil) return Promise.resolve({ saved: false, reason: LOGIN_GONE });
      if ((login.decision === 'save' || login.decision === 'check') && !login.password) return Promise.resolve({ saved: false, reason: LOGIN_GONE });
      try { return listener({ origin: login.origin, username: login.username, password: login.password ?? '', decision: login.decision }); }
      catch { return Promise.resolve({ saved: false, reason: LOGIN_GONE }); }
    });
  }

  #invalidate(): void { this.#observation = undefined; this.#picture = undefined; }

  #note?: string;
  takeNote(): string | undefined { const note = this.#note; this.#note = undefined; return note; }

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
      this.#note = undefined;
      this.#lastAction = this.options.now?.() ?? Date.now();
      const result = await this.#send('navigate', { url: checked.href });
      // The extension's one line about where the page opened, on the observation passthrough.
      const note = (result.observation as { note?: unknown } | null | undefined)?.note;
      if (typeof note === 'string' && note.trim() !== '') this.#note = note.trim().slice(0, 300);
      await this.#watch();
      return;
    }
    if (command.action === 'tab') {
      this.#invalidate();
      await this.#send('tab', { tabId: command.tabId });
      await this.#watch();
      return;
    }
    if (!this.#observation || command.observation !== this.#observation.id) throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.');
    const target = command.target ? { ref: command.target.ref, role: command.target.role, name: command.target.name, by: command.target.by, frame: command.target.frame } : undefined;
    const args: Record<string, unknown> = { ...(target ? { target } : {}), ...(command.value !== undefined ? { value: command.value } : {}),
      ...(command.key !== undefined ? { key: command.key } : {}), ...(command.direction !== undefined ? { direction: command.direction } : {}) };
    this.#invalidate(); // Never replay evidence once dispatch may have started.
    this.#lastAction = this.options.now?.() ?? Date.now();
    await this.#send(command.action, args);
  }

  /**
   * The facts a secret fill is aimed by, as the extension's page side read them.
   *
   * The driver holds the evidence identity (same refusal as any acting
   * command); the extension holds the refs and answers the field's own frame
   * origin, its password mark and its accessible name. `fieldInfo` rides the
   * result frame's passthrough observation, which is the one channel the
   * gateway relays untouched.
   */
  async secretFieldInfo(observation: string, ref: string): Promise<{ origin: string; password: boolean; name: string }> {
    if (!this.#observation || observation !== this.#observation.id) throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.');
    const result = await this.#send('fieldInfo', { ref });
    const field = (result.observation as { field?: unknown } | null | undefined)?.field;
    if (!field || typeof field !== 'object' || typeof (field as { origin?: unknown }).origin !== 'string') {
      throw new BrowserPreconditionError('The field could not be read. Observe again and pick a fresh ref.');
    }
    const { origin, password, name } = field as { origin: string; password?: unknown; name?: unknown };
    // A second, local guard: the target a use is asked for is canonical or nothing.
    return { origin: fieldOrigin(origin), password: password === true, name: typeof name === 'string' ? name : '' };
  }

  /**
   * One owner secret into one field, through the debugger's insertText.
   *
   * The extension re-resolves the ref and re-reads the frame's origin and
   * refuses unless it is still `expectedOrigin` — the navigation between the
   * owner's approval and the fill refuses before anything is entered. The value
   * crosses the loopback socket to buddi's own paired extension (owner-secrets
   * §3) and is kept by nothing on the way.
   */
  async secretFillField(observation: string, ref: string, value: string, expectedOrigin: string): Promise<void> {
    if (!this.#observation || observation !== this.#observation.id) throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.');
    this.#invalidate(); // Never replay evidence once dispatch may have started.
    await this.#send('secretFill', { ref, value, expectedOrigin });
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

  /**
   * The owner takes the page. The agent's evidence is dropped; with a live
   * extension that is all, and the remote hand is theirs from wherever they
   * are. An extension from before brings the tab to the front instead.
   */
  async takeover(): Promise<void> {
    this.#invalidate();
    if (!this.#live()) await this.bringToFront();
  }
  /**
   * Bring the tab to the front, for an owner at this machine: the session's
   * tab becomes the active one and its window comes forward, with the bar
   * saying buddi waits and offering Give it back (and the save-a-login
   * question for a sign-in made there).
   */
  async bringToFront(): Promise<void> {
    this.#invalidate();
    if (!this.bridge.connected()) throw new Error(NOT_CONNECTED);
    // What the tab needs to ask about a sign-in: the sites never to ask about, the logins already kept.
    const logins = this.options.logins?.();
    await this.bridge.send({ name: 'hold', session: this.session, args: logins ? { logins } : {}, owner: true });
    this.#held = true;
  }

  /**
   * Capture, for the owner's Files: the tab's viewport as a PNG, password
   * fields painted over, with its title and address. Whoever holds the page;
   * nothing of the agent's evidence is spent.
   */
  async capture(): Promise<{ png: Buffer; title: string; url: string }> {
    if (!this.#live()) throw new BrowserPreconditionError('Update the buddi extension in Chrome to capture a page there.');
    if (!this.bridge.connected()) throw new BrowserPreconditionError(NOT_CONNECTED);
    const result = await this.bridge.send({ name: 'capture', session: this.session, args: {}, owner: true });
    const png = typeof result.screenshot === 'string' && result.screenshot !== '' ? Buffer.from(result.screenshot, 'base64') : undefined;
    if (!png) throw new BrowserPreconditionError('Your Chrome did not hand over a picture of that page.');
    const page = (result.observation ?? {}) as { url?: unknown; title?: unknown };
    const url = typeof page.url === 'string' ? page.url.slice(0, 4096) : '';
    this.#checkHost(url);
    return { png, title: typeof page.title === 'string' ? page.title.slice(0, 1000) : '', url };
  }
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
  /** Given back: the waiting bar goes, and the agent may act in that tab although the owner is looking at it. */
  resume(): void {
    this.#invalidate();
    if (this.#held) this.#heldUntil = (this.options.now?.() ?? Date.now()) + LOGIN_GRACE_MS;
    this.#held = false;
    if (!this.bridge.connected()) return;
    void this.bridge.send({ name: 'unhold', session: this.session, args: {}, owner: true }).catch(() => undefined);
  }

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
  readonly hand: BrowserHand = {
    start: async (onFrame: (frame: HandFrame) => void, quality: HandQuality = HAND_QUALITY) => {
      this.#subscribe();
      this.#handFrames = onFrame;
      this.#invalidate();
      // The last picture the Canvas had is the hand's first, so the owner never looks at an empty frame.
      if (this.#latest) onFrame(this.#latest);
      try { await this.#send('screencast.start', { ...quality, everyNthFrame: 1 }); }
      catch (error) { this.#handFrames = undefined; throw error; }
    },
    /**
     * A smaller picture, without dropping the subscription.
     *
     * `screencast.start` on a session that already has one restarts it, which
     * is exactly what a re-tune is; the frames keep arriving on the same
     * listener because that listener belongs to the session, not to the cast.
     */
    tune: async (quality: HandQuality) => {
      if (!this.#handFrames || !this.bridge.connected()) return;
      await this.#send('screencast.start', { ...quality, everyNthFrame: 1 }).catch(() => undefined);
    },
    input: async (event: HandInput) => {
      if (event.kind === 'copy') return;
      if (event.kind === 'nav') {
        // An extension from before has no window buttons; Chrome's own are right there in the owner's window.
        if (!this.#live()) throw new BrowserPreconditionError('Use Chrome’s own buttons for that page.');
        // A typed address goes through the same check an agent's navigate does.
        if (event.action === 'navigate') {
          const checked = checkUrl(event.url ?? '').url;
          if (this.allowedHosts?.length && !this.allowedHosts.includes(checked.hostname)) throw new BrowserPreconditionError('This website is outside the configured browser hosts.');
          await this.#send('input', { kind: 'nav', action: 'navigate', url: checked.href }, true);
          return;
        }
        await this.#send('input', { kind: 'nav', action: event.action }, true);
        return;
      }
      await this.#send('input', event as unknown as Record<string, unknown>, true);
    },
    /** The owner's Cmd/Ctrl+C: the selection in the tab they hold, never a password field. */
    copy: async () => {
      if (!this.#live() || !this.bridge.connected()) return '';
      const result = await this.bridge.send({ name: 'copy', session: this.session, args: {}, owner: true }).catch(() => undefined);
      const copied = (result?.observation as { copied?: unknown } | null | undefined)?.copied;
      return typeof copied === 'string' ? copied.slice(0, MAX_HAND_COPY) : '';
    },
    /** The owner gave it back: the picture goes back to watching for the Canvas, or stops. */
    stop: async () => {
      this.#handFrames = undefined;
      if (!this.bridge.connected()) return;
      if (this.#live()) {
        this.#watching = false;
        await this.#watch();
        if (this.#watching) return;
      }
      await this.#send('screencast.stop').catch(() => undefined);
    },
  };

  async close(): Promise<void> {
    this.#invalidate();
    this.#downloadsOff?.();
    this.#downloadsOff = undefined;
    // The listener lives as long as the driver: a page re-opened in the same session keeps its bar.
    this.#subscribed?.();
    this.#subscribed = undefined;
    this.#handFrames = undefined;
    this.#latest = undefined;
    this.#watching = false;
    // A closed socket has already forgotten the session; nothing to close.
    if (!this.bridge.connected()) return;
    await this.bridge.send({ name: 'close', session: this.session, args: {} }).catch(() => undefined);
  }
}
