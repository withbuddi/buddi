import type { InstallProgress, LaunchCheck } from './availability.js';
import { randomUUID } from 'node:crypto';
import type { EffectDescription, SurfaceProfile, ToolContext } from '@buddi/core/plugin';
import { FORM_KIND, NATIVE_KIND, fieldBoundTo, secretKindFor, takeDelivered } from './secrets.js';
import type { LoginKeeper } from './logins.js';
import type { BrowserCommand, BrowserDriver, BrowserHand, LoginAck, LoginCheck, Observation, SeenLoginReport } from './types.js';
import { LOGIN_GONE, LOGIN_GRACE_MS, APP_BEHIND, BrowserOpenedError, BrowserPreconditionError, UNTRUSTED, observedLine } from './types.js';
import { ownerCard, siteOf, type ChromeLink, type OwnerCard, type CardKind } from './routes.js';
import type { RouteKind, ControlSettings } from './settings.js';
import { missionMark, type BrowserTelemetry, type StopCause } from './telemetry.js';
import { readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DownloadRefused, downloadSource, type DownloadStore, type DownloadUsage } from './downloads.js';

/** One download an action produced, as `browser.act` reports it: an artifact id to hand a plugin's import tool, or why not. */
export type DownloadReport =
  | { artifactId: string; name: string; size: number; type: string }
  | { name: string; refused: string };

function sizeWord(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Said when the owner has stopped agents' browsing. On Telegram the way back
 * is a command in the same chat; everywhere else the Resume card in the chat
 * itself, or Settings.
 */
export function browserStoppedMessage(surface?: SurfaceProfile): string {
  return surface?.id === 'telegram'
    ? 'The owner stopped agents\' browsing. Tap Resume on the card, or send /browser resume here.'
    : 'The owner stopped agents\' browsing. Tap Resume on the card in this chat to let agents look again.';
}

/** Kept for the surfaces that still name it: the owner has the page in their hands. */
export function browserPausedMessage(surface?: SurfaceProfile): string {
  return surface?.id === 'telegram'
    ? 'You have the page. Give it back from the dashboard, or send /browser resume here.'
    : 'You have the page. Give it back when you are done and the agent carries on.';
}

/** A page that did not answer after every retry: said once, never as an instruction to retry. */
export function browserWaitMessage(_surface?: SurfaceProfile): string {
  return 'The page did not answer after several tries.';
}

/** The extension's last word after waiting for the owner to leave their tab (extension commands.ts, `WATCHED`). */
const OWNER_WATCHING = /You are looking at this tab/i;
/** What the agent is told instead: no ask, no retry loop; the bar in the tab already asks the owner. */
export const OWNER_WATCHING_MESSAGE = 'The owner is looking at that tab, and the bar in it asks them whether you may carry on there. Nothing was done. Work on something else for a moment, then try again.';

/** An observation failure no waiting fixes: the tab or window it was reading is gone. */
const SCREEN_GONE = /\b(tab|window)\b[^.]*\b(closed|gone)\b|has been closed|target closed/i;
/** The waits before each re-read when the page gave no answer: 0.5, 1, 2, 4 and 8 seconds (six attempts in all). */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];
/** Targeting refusals in a row before the task asks the owner whether to keep going. */
export const MAX_TARGETING_FAILURES = 8;
/** The task's budget: actions and minutes, renewed by any owner touch in the conversation. */
export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_LIFETIME_MS = 60 * 60_000;
/** How long a run stays parked on its page waiting for the owner's card. */
export const PARK_MS = 60 * 60_000;

/** The three ways an agent can get a screen, by their old names (the dashboard still reads them). */
export type BrowserMode = 'computer' | 'playwright' | 'extension';
/** A route by the mode name the dashboard and Telegram already know. */
export function modeOf(route: RouteKind): BrowserMode {
  return route === 'chrome' ? 'extension' : route === 'apps' ? 'computer' : 'playwright';
}

/** Health of one route, as Settings and `browser.status` show it. */
export interface RouteStatus {
  kind: RouteKind;
  /** The owner's switch allows it (own: always). */
  allowed: boolean;
  /** It could serve a page right now. */
  available: boolean;
  /** Who provides it: core, or a plugin's name ('' when nothing does). */
  provider: string;
  /** Apps: a plugin provides the route here. False: the row offers the Computer plugin instead. */
  installed?: boolean;
  /** Apps: how the providing plugin names it. */
  label?: string;
  message?: string;
  repair?: 'install' | 'permissions' | 'pair' | 'helper' | 'sandbox';
  /** Chrome: a pairing exists / the extension is connected right now. */
  paired?: boolean;
  connected?: boolean;
  /** Chrome: `paired` and `connected` in one word: `unpaired`, `closed` (paired, Chrome not connected) or `connected`. */
  link?: ChromeLink;
  /** Apps: the yes/no/ask switch. */
  mode?: 'off' | 'ask' | 'on';
}

export interface BrowserStatus {
  /** The route of the selected session, by its old mode name; absent with no session. */
  mode?: BrowserMode;
  /** Where the selected session looks. */
  route?: RouteKind;
  settings?: ControlSettings;
  state: 'unavailable' | 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'expired' | 'error';
  enabled: boolean;
  busy: boolean;
  session?: { id: string; agentId: string; conversationId: string; requestId: string; task: string; expiresAt: string; steps: number; maxSteps: number;
    route?: RouteKind;
    /** The apps route: apps the owner allowed Once for this session's conversation. */
    allowedOnce?: string[];
    /** The apps route: every app this conversation was let into (on the plugin's list, or allowed by card). */
    allowedApps?: string[] };
  page?: Omit<Observation, 'tree' | 'targets'>;
  lastAction?: string;
  message?: string;
  hasScreenshot: boolean;
  /** The card this page is parked on, waiting for the owner. */
  needsOwner?: OwnerCard;
  /**
   * The owner holds this page where it already is, so there is no picture to
   * stream: a take-over of a page in the owner's Chrome brings its tab to the
   * front of their Chrome instead. Present only while paused that way; the
   * Canvas says where the page is and offers Give it back (`resume`), and the
   * bar in the tab offers the same. Absent: a take-over streams frames as before.
   */
  held?: BrowserHeld;
  /** Owner dashboard only; agent tools receive just their conversation. */
  sessions?: BrowserStatus[];
  /** The agents' own browser on this machine: what launches, and how. */
  browser?: BrowserEngineStatus;
  /** Every route, its switch and its health. */
  routes?: RouteStatus[];
  /** A global Stop that holds: when, and until when (absent: until the owner says). */
  stop?: { at: string; until?: string };
  /** This conversation's pin, when asked for a conversation. */
  pin?: string;
  /** Sites buddi added to "needs my sign-in" itself, beside the owner's own `settings.signInSites`. */
  learnedSignInSites?: string[];
  /** The owner's Chrome and this buddi: `unpaired`, `closed` (paired, not connected now) or `connected`. Same as the chrome route's `link`. */
  chrome?: ChromeLink;
}
/** Who holds a page in place, and where: today only the owner, in their own Chrome. */
export interface BrowserHeld { by: 'owner'; where: 'chrome' }
/** What the agents' own browser is here, and what the owner can do about it. */
export interface BrowserEngineStatus {
  /** `none`: nothing to launch until the owner installs one. */
  engine: 'chromium' | 'chrome' | 'none';
  /** It runs headless: by default, or because this Linux machine has no display. */
  headless: boolean;
  /** The last launch failed for missing Linux libraries, or because the system would not let Chromium start its sandbox. */
  problem?: 'missing-libraries' | 'no-sandbox';
  /** One or two sentences for the owner, when there is something to say. */
  message?: string;
  install?: { state: 'running' | 'done' | 'failed'; line?: string; progress?: InstallProgress };
}
export interface BrowserScope { sessionId?: string; agentId?: string; conversationId?: string }
export interface BrowserHandOffer { supported: boolean; message?: string; hand?: BrowserHand }
/** Trusted lifecycle input, never exposed in an agent tool schema. */
export interface BrowserRollover { ownerId: string; agentId: string; previousConversationId: string; conversationId: string }
/** What `secret.fill` asks: the secret's name and the field's ref; the observation is optional, the latest by default. */
export interface SecretFillInput { name: string; ref: string; observation?: string | undefined }
/** What `secret.type` asks: the secret's name; the focused app is the backend's answer. */
export interface SecretTypeInput { name: string }
/** An owner touch: a message or a card tap in a conversation. */
export interface BrowserTouch { conversationId: string; agentId?: string; text?: string }
/** The owner gave back a page they held: whose it was. */
export interface BrowserGiveBack { sessionId: string; agentId: string; conversationId: string }
export interface BrowserController {
  /** Sign-ins the owner made on a page they held, waiting for their word or already kept (docs/browser.md, "Saving a sign-in"). */
  readonly logins?: LoginKeeper;
  enable(): Promise<void>;
  shutdown(): Promise<void>;
  status(scope?: BrowserScope): BrowserStatus;
  screenshot(sessionId?: string): Buffer | undefined;
  execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown>;
  secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown>;
  secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown>;
  /** `stop` with no session is Stop agents' browsing: it expires unless `forever` ("until I say"). */
  control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string, options?: { forever?: boolean }): Promise<BrowserStatus>;
  hand?(scope?: BrowserScope): BrowserHandOffer;
  configure?(settings: unknown): Promise<BrowserStatus>;
  installBrowser?(): BrowserStatus;
  tierFor?(command: BrowserCommand, ctx: ToolContext): Promise<{ tier: 'session' | 'gated'; reason?: string }>;
  describe?(command: BrowserCommand, ctx: ToolContext): Promise<EffectDescription>;
  checkLaunch?(): Promise<LaunchCheck>;
  rollover?(input: BrowserRollover): boolean;
  /** The owner spoke or tapped in a conversation: budgets renew and a waiting card is answered. */
  touch?(input: BrowserTouch): Promise<{ answered?: string } | void>;
  /** Pin a conversation to a route, or clear its pin (`auto`). */
  pin?(conversationId: string, pin: string): Promise<BrowserStatus>;
  /** How long a mission run waits on a card for the owner, in milliseconds (settings `missionWaitMinutes`). */
  missionWaitMs?(): number;
  /** Hear every give-back of a page the owner held (Give it back, `/browser resume`). Returns the unsubscribe. */
  onGiveBack?(listener: (info: BrowserGiveBack) => void): () => void;
  /** What the agents' downloads area holds (Settings → Browser). */
  downloadUsage?(): Promise<DownloadUsage>;
  /** Empty the agents' downloads area; Files keeps its copies. */
  clearDownloads?(): Promise<DownloadUsage>;
}

export interface BrowserServiceOptions {
  maxSteps?: number;
  lifetimeMs?: number;
  /** How long a page stays parked on a card before it is let go. At least an hour. */
  parkMs?: number;
  now?: () => number;
  allowOpen?: boolean;
  /** The backoff's clock; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  retryDelays?: readonly number[];
  telemetry?: BrowserTelemetry;
  route?: RouteKind;
  /** The owner pressed Take over in the page itself (the extension's bar): the controller decides, one page at a time. */
  requestTakeover?: (sessionId: string) => void;
  /** The owner pressed Give it back in the page itself: the controller resumes it, so the waiting run hears of it. */
  requestResume?: (sessionId: string) => void;
  /** A sign-in went out on this page while the owner held it: to the host's login keeper, and nowhere else. */
  loginSeen?: (sessionId: string, login: SeenLoginReport) => Promise<LoginAck | LoginCheck> | void;
  /** Where a download lands before it is registered in Files. Without it downloads are dropped. */
  downloads?: DownloadStore;
}

/** A result that carries a card: the run stops and the surface draws it. */
export interface CardResult { completed: false; dispatched: boolean; needsOwner: OwnerCard; message: string; notice: string; observation?: Observation }

/**
 * One conversation's page on one route.
 *
 * Every action returns the page as it is afterwards. Refusals that used to
 * stop the task are retried here (a slow page, a stale ref, a redirect) or
 * become one card the owner answers (an input that may not have landed, the
 * budget). Only the owner's own take-over pauses a page.
 */
export class BrowserService {
  #enabled = false;
  #state: BrowserStatus['state'] = 'unavailable';
  #session?: NonNullable<BrowserStatus['session']> & { ownerId: string; startedAt: number; actions: number; cards: number };
  #observation?: Observation;
  #picture?: Buffer;
  #busy = false;
  #handless = false;
  /** The owner holds the page in place (their Chrome brought it forward): no frames, no hand. */
  #held = false;
  /** The page the owner last held in place, and until when a Save they tapped there still counts (the driver's grace). */
  #lastHeld?: { id: string; until: number };
  /** Who waits for the action in flight to settle (a Give it back pressed while it stops). */
  #settleWaiters: Array<() => void> = [];
  #controller?: AbortController;
  #expiry?: ReturnType<typeof setTimeout>;
  #lastAction?: string;
  #message?: string;
  #targetingFailures = 0;
  #card?: OwnerCard;
  /** Where the page last was, so a closed tab or a new request re-opens it rather than stopping. */
  #lastUrl?: string;
  #lastActivity = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #controlTail: Promise<unknown> = Promise.resolve();
  constructor(readonly driver: BrowserDriver, readonly options: BrowserServiceOptions = {}) {}
  #now(): number { return this.options.now?.() ?? Date.now(); }
  get #route(): RouteKind { return this.options.route ?? (this.options.allowOpen ? 'apps' : 'own'); }
  #sleep(ms: number): Promise<void> { return this.options.sleep ? this.options.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)); }
  #stamp(observation: Observation): Observation { return { ...observation, observedAt: new Date(this.#now()).toISOString() }; }
  #stop(cause: StopCause, ctx?: ToolContext, recovered?: 'silent' | 'card' | 'none'): void {
    this.options.telemetry?.stop(cause, { route: this.#route, ...(ctx?.agentId ? { agent: ctx.agentId } : {}), ...(ctx?.surface?.id ? { surface: ctx.surface.id } : {}), ...missionMark(ctx),
      ...(siteOf(this.#observation?.url ?? this.#lastUrl) ? { host: siteOf(this.#observation?.url ?? this.#lastUrl)! } : {}), ...(recovered ? { recovered } : {}) });
  }

  async enable(): Promise<void> {
    if (this.#enabled) return;
    // Take over pressed in the page's own bar is the Canvas button.
    this.driver.onOwnerTakeover?.(() => {
      const id = this.#session?.id;
      if (!id) return;
      if (this.options.requestTakeover) this.options.requestTakeover(id);
      else void this.control('takeover').catch(() => undefined);
    });
    // Give it back pressed in the held tab's bar is the Canvas's Give it back.
    this.driver.onOwnerGiveBack?.(() => {
      const id = this.#session?.id;
      if (!id || this.#state !== 'paused') return;
      if (this.options.requestResume) this.options.requestResume(id);
      else void this.control('resume').catch(() => undefined);
    });
    // A sign-in the owner made on the page they hold: the keeper asks them, never a model.
    // A Save the owner tapped in their Chrome a beat after Give it back still counts, for the page they held, within the driver's grace.
    this.driver.onLoginSeen?.((login) => {
      const live = this.#state === 'paused' ? this.#session?.id : undefined;
      if (login.decision === 'check' && !live) return Promise.resolve({ ask: 'none' } as const);
      const recent = !live && login.decision && this.#lastHeld && this.#now() < this.#lastHeld.until ? this.#lastHeld.id : undefined;
      const id = live ?? recent;
      if (!id) return login.decision ? Promise.resolve({ saved: false, reason: LOGIN_GONE } as const) : undefined;
      return this.options.loginSeen?.(id, login);
    });
    this.#state = 'idle';
    this.#enabled = true;
  }

  status(_scope?: BrowserScope): BrowserStatus {
    const { tree: _tree, targets: _targets, ...page } = this.#observation ?? {};
    const session = this.#session ? (({ ownerId: _o, startedAt: _s, actions: _a, cards: _c, ...rest }) => rest)(this.#session) : undefined;
    return { state: this.#state, enabled: this.#enabled, busy: this.#busy,
      ...(session ? { session: { ...session, route: this.#route } as NonNullable<BrowserStatus['session']>, route: this.#route, mode: modeOf(this.#route) } : {}),
      ...(this.#observation ? { page: page as Omit<Observation, 'tree' | 'targets'> } : {}),
      ...(this.#card ? { needsOwner: this.#card } : {}),
      ...(this.#state === 'paused' && this.#held && this.driver.holdsInPlace ? { held: { by: 'owner' as const, where: this.driver.holdsInPlace } } : {}),
      lastAction: this.#lastAction, message: this.#message, hasScreenshot: !!this.#picture };
  }

  screenshot(_sessionId?: string): Buffer | undefined { return this.#picture; }
  /** The card this page waits on, if any. */
  get card(): OwnerCard | undefined { return this.#card; }
  /** Where this page is, or was. */
  get lastUrl(): string | undefined { return this.#observation?.url ?? this.#lastUrl; }
  /** The latest page, with its tree: what the route's post-processing reads. */
  get observation(): Observation | undefined { return this.#observation; }
  get busy(): boolean { return this.#busy; }
  /** Where this conversation's page was before it was let go, so the next action opens it again there. */
  seed(url: string): void { this.#lastUrl ??= url; }
  /** No action for this long: a page a waiting conversation may take over. */
  idleFor(): number { return this.#busy || this.#state === 'paused' || this.#card ? 0 : this.#now() - this.#lastActivity; }

  /**
   * The remote hand, and only while the owner holds this screen. Paused is the
   * take-over state, the only one in which a dashboard may drive.
   */
  hand(_scope?: BrowserScope): BrowserHandOffer {
    if (this.#held && this.#state === 'paused') return { supported: false, message: 'The page is in front of you in your Chrome.' };
    if (this.driver.supportsHand === false || !this.driver.hand) {
      return { supported: false, message: this.driver.handMessage ?? 'Take over at the computer for this route.' };
    }
    if (!this.#session) return { supported: true, message: 'No agent is looking at this page.' };
    if (this.#state !== 'paused') return { supported: true, message: 'Take over first, then you can drive.' };
    if (this.#handless || this.driver.handReady?.() === false) {
      return { supported: true, message: this.#message ?? 'There is no screen to drive. Give it back and the agent opens the page again.' };
    }
    return { supported: true, hand: this.driver.hand };
  }

  rollover(input: BrowserRollover): boolean {
    const session = this.#session;
    if (!session || session.ownerId !== input.ownerId || session.agentId !== input.agentId || session.conversationId !== input.previousConversationId) return false;
    if (!this.#enabled || this.#busy || !['running', 'paused'].includes(this.#state)) throw new Error('Wait for the page to settle before continuing the conversation.');
    session.conversationId = input.conversationId;
    this.#observation = undefined;
    this.#picture = undefined;
    this.#message = 'Task continued after conversation rollover. The next action returns the current page.';
    return true;
  }

  /**
   * Put the page on a card and wait for the owner. The run stops (the tool's
   * result carries the card) and the page stays open for at least an hour.
   */
  park(kind: CardKind, facts: Parameters<typeof ownerCard>[1] = {}): OwnerCard {
    const card = ownerCard(kind, { site: siteOf(this.lastUrl), ...facts });
    this.#card = card;
    if (this.#session) this.#session.cards++;
    this.#schedule(Math.max(Date.parse(this.#session?.expiresAt ?? '') || 0, this.#now()) + Math.max(this.options.parkMs ?? PARK_MS, PARK_MS) - this.#now());
    return card;
  }
  #cardResult(card: OwnerCard, dispatched: boolean, message?: string): CardResult {
    return { completed: false, dispatched, needsOwner: card, notice: UNTRUSTED,
      message: message ?? `Waiting for the owner: "${card.title}" Say that in one sentence and stop; the card in the chat has the buttons. The page stays open; you continue when they answer.`,
      ...(this.#observation ? { observation: this.#observation } : {}) };
  }

  /**
   * The owner spoke or tapped in this conversation: the budget renews (200
   * actions, an hour) and a waiting card is cleared. Returns the card it
   * cleared, so the caller can act on the answer (take over, use Chrome).
   */
  renew(): OwnerCard | undefined {
    const card = this.#card;
    this.#card = undefined;
    this.#targetingFailures = 0;
    if (this.#session) {
      this.#session.steps = 0;
      this.#session.maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
      const expiresAt = this.#now() + (this.options.lifetimeMs ?? DEFAULT_LIFETIME_MS);
      this.#session.expiresAt = new Date(expiresAt).toISOString();
      this.#schedule(expiresAt - this.#now() + Math.max(this.options.parkMs ?? PARK_MS, PARK_MS));
    }
    return card;
  }

  #schedule(ms: number): void {
    clearTimeout(this.#expiry);
    this.#expiry = setTimeout(() => { void this.#release('expired'); }, Math.max(1, ms));
    this.#expiry.unref?.();
  }

  #open(request: NonNullable<ToolContext['ownerRequest']> | undefined, ctx: ToolContext): void {
    const lifetime = this.options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    if (!this.#session) {
      const expiresAt = this.#now() + lifetime;
      this.#session = { id: randomUUID(), ownerId: ctx.buddi!.owner.id, agentId: ctx.agentId!, conversationId: ctx.conversationId!,
        requestId: request?.id ?? 'unattended', task: (request?.text ?? 'An unattended task').slice(0, 4000),
        expiresAt: new Date(expiresAt).toISOString(), steps: 0, maxSteps: this.options.maxSteps ?? DEFAULT_MAX_STEPS,
        startedAt: this.#now(), actions: 0, cards: 0 };
      this.#schedule(lifetime + Math.max(this.options.parkMs ?? PARK_MS, PARK_MS));
      return;
    }
    // A new owner message is an owner touch: the same page, a fresh budget.
    if (request && this.#session.requestId !== request.id) {
      this.#session.requestId = request.id;
      this.#session.task = request.text.slice(0, 4000);
      this.renew();
    }
  }

  /** One action at a time per page: a second call waits for the first rather than being refused. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => {});
    return next;
  }

  execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    return this.#serial(() => this.#execute(command, ctx));
  }

  async #execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    const request = ctx.ownerRequest;
    if (!ctx.agentId || !ctx.conversationId) throw new Error('A browser action belongs to an agent and a conversation.');
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve (dashboard or Telegram), not a separate CLI process.');
    if (this.#state === 'stopped') throw new Error(browserStoppedMessage(ctx.surface));
    if (this.#session && (this.#session.ownerId !== ctx.buddi!.owner.id || this.#session.agentId !== ctx.agentId || this.#session.conversationId !== ctx.conversationId)) {
      throw new Error('Another conversation owns this page.');
    }
    if (command.action === 'close') {
      await this.#release('idle');
      return { closed: true, notice: UNTRUSTED };
    }
    if (this.#state === 'paused') {
      throw new Error('The owner has this page in their hands. Wait for them to give it back; you continue when they do.');
    }
    // Parked on a card: nothing is done until the owner answers it.
    if (this.#card) {
      this.#open(request, ctx);
      if (this.#card) return this.#cardResult(this.#card, false);
    }
    let run = command;
    let reopened = false;
    if (!this.#session && command.action !== 'navigate' && command.action !== 'open') {
      // No page yet, or the last one was let go: open it again where it was.
      if (!this.#lastUrl || this.#route === 'apps') {
        this.#stop('start-with-navigate', ctx);
        return { completed: false, dispatched: false, notice: UNTRUSTED, message: 'No page is open in this conversation yet. Navigate to the website first.' };
      }
      this.#stop('request-ended', ctx);
      run = { action: 'navigate', url: this.#lastUrl } as BrowserCommand;
      reopened = true;
    }
    this.#open(request, ctx);
    const active = this.#session!;
    if (active.steps >= active.maxSteps || Date.parse(active.expiresAt) <= this.#now()) {
      this.#stop('budget', ctx);
      return this.#cardResult(this.park('budget'), false);
    }
    // The observation is the latest one unless the agent named another.
    if (['click', 'fill', 'select', 'press', 'scroll'].includes(run.action) && run.observation === undefined && this.#observation) {
      run = { ...run, observation: this.#observation.id };
    }
    ++active.steps; ++active.actions;
    this.#busy = true;
    this.#lastAction = run.action; // Never record form values here.
    this.#lastActivity = this.#now();
    this.#message = undefined;
    const controller = new AbortController();
    this.#controller = controller;
    const cancel = () => {
      controller.abort(ctx.signal?.reason ?? new Error('Browser action stopped.'));
      void this.#release('idle');
    };
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.#state = 'starting';
      await this.driver.start();
      controller.signal.throwIfAborted();
      this.#state = 'running';
      await this.driver.perform(run);
      const note = this.driver.takeNote?.();
      if (note) this.#message = note;
      if (run.action !== 'observe') this.#targetingFailures = 0;
      controller.signal.throwIfAborted();
      const seen = await this.#look(controller, ctx);
      if (!seen) {
        // Six reads over fifteen seconds and nothing: one card, not a loop.
        this.#stop('observation-failures', ctx, 'card');
        return this.#cardResult(this.park('uncertain'), run.action !== 'observe');
      }
      const observed = observedLine(this.#observation!.observedAt!);
      if (reopened) {
        const asked = command.action;
        return { completed: false, dispatched: false, notice: UNTRUSTED, observation: this.#observation,
          message: `${observed} No page was open, so I opened ${siteOf(this.#lastUrl) ?? 'the last page'} again. Nothing else was done; ${asked === 'observe' ? 'here it is' : 'act on this page now'}.` };
      }
      const files = await this.#collectDownloads(ctx);
      const said = [observed, this.#message, files.line].filter(Boolean).join(' ');
      return { completed: true, notice: UNTRUSTED, observation: this.#observation, ...(files.downloads ? { downloads: files.downloads } : {}), message: said };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BrowserPreconditionError) return await this.#precondition(controller, error, ctx);
      this.#state = 'running';
      if (error instanceof BrowserOpenedError) {
        // The page opened and a later step failed: hand back the page, not just the error.
        const site = siteOf(error.page.url) ?? 'the page';
        const failed = message.replace(/\.$/, '');
        if (error.page.url) this.#lastUrl = error.page.url;
        const seen = await this.#look(controller, ctx).catch(() => false);
        if (seen) {
          return { completed: false, dispatched: true, notice: UNTRUSTED, observation: this.#observation,
            message: `${observedLine(this.#observation!.observedAt!)} Opened ${site}, then this failed: ${failed}. Carry on from this page; don't open it again.` };
        }
        this.#message = `Opened ${site} in a tab, then this failed: ${failed}.`;
        throw new Error(this.#message);
      }
      if (['click', 'fill', 'select', 'press'].includes(run.action)) {
        // The input may have landed part-way: the owner looks, or tells the agent to judge from the page.
        this.#stop('uncertain-input', ctx, 'card');
        this.#observation = undefined; this.#picture = undefined;
        return this.#cardResult(this.park('uncertain'), true, `${message.replace(/\.$/, '')}. I'm not sure that went through. Say so in one sentence and stop; the card asks the owner whether to look.`);
      }
      this.#message = message;
      throw error;
    } finally {
      ctx.signal?.removeEventListener('abort', cancel);
      if (this.#controller === controller) this.#controller = undefined;
      this.#busy = false; this.#settled();
    }
  }

  /**
   * The files this page's actions downloaded, copied into the agent's
   * downloads area and registered in Files with the agent, the run and where
   * they came from (docs/browser.md, "Downloads"). A cap or a failure is a
   * line the agent repeats, never an exception: the page action itself worked.
   */
  async #collectDownloads(ctx: ToolContext): Promise<{ downloads?: DownloadReport[]; line?: string }> {
    const pending = this.driver.takeDownloads?.() ?? [];
    if (pending.length === 0) return {};
    const reports: DownloadReport[] = [];
    const store = this.options.downloads;
    const files = ctx.buddi?.files;
    for (const item of pending) {
      try {
        if (!store || !files) throw new DownloadRefused('Downloads are not set up on this buddi.');
        const stored = await store.save(ctx.agentId!, item);
        const runId = ctx.provenance?.().runId ?? ctx.jobId ?? null;
        const site = siteOf(item.url);
        const saved = await files.save({
          bytes: await readFile(stored.path), mime: stored.mime, filename: stored.filename,
          caption: site ? `Downloaded from ${site}` : 'Downloaded in the browser',
          source: { surface: 'browser', chatId: runId ?? ctx.conversationId ?? null, messageId: downloadSource(item.url) },
        });
        // Files holds it now: the landing copy goes, so the area keeps only what failed to register.
        await unlink(stored.path).catch(() => undefined);
        await rmdir(path.dirname(stored.path)).catch(() => undefined);
        reports.push({ artifactId: saved.id, name: saved.filename ?? stored.filename, size: saved.sizeBytes, type: saved.mime });
      } catch (error) {
        const reason = error instanceof DownloadRefused ? error.message : `It could not be saved (${error instanceof Error ? error.message : String(error)}).`;
        reports.push({ name: item.filename, refused: reason });
      }
    }
    const lines = reports.map((report) => 'artifactId' in report
      ? `Downloaded ${report.name} (${sizeWord(report.size)}, ${report.type}): it is in the owner's Files as artifact ${report.artifactId}. To import it, pass that id to the owning plugin's import tool; do not paste its contents into your reply.`
      : `The download ${report.name} was refused: ${report.refused}`);
    return { downloads: reports, line: lines.join(' ') };
  }

  /**
   * Read the page, re-reading at 0.5, 1, 2, 4 and 8 seconds when it does not
   * answer. A closed tab is opened again at its last address once. False when
   * all six reads failed. The app pushed behind the owner's window is said
   * straight away: open brings it back and no wait helps.
   */
  async #look(controller: AbortController, ctx: ToolContext): Promise<boolean> {
    const delays = this.options.retryDelays ?? RETRY_DELAYS_MS;
    let reopened = false;
    let counted = false;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await this.#sleep(delays[attempt - 1]!);
      controller.signal.throwIfAborted();
      try {
        const observation = await this.driver.observe();
        const picture = await this.driver.screenshot();
        controller.signal.throwIfAborted();
        this.#observation = this.#stamp(observation);
        this.#picture = picture;
        if (observation.url) this.#lastUrl = observation.url;
        return true;
      } catch (error) {
        controller.signal.throwIfAborted();
        const cause = error instanceof Error ? error.message : String(error);
        this.#observation = undefined; this.#picture = undefined;
        if (APP_BEHIND.test(cause)) {
          this.#stop('app-behind', ctx);
          throw new BrowserPreconditionError(cause);
        }
        if (SCREEN_GONE.test(cause) && !reopened && this.#lastUrl && this.#route !== 'apps') {
          reopened = true;
          this.#stop('screen-gone', ctx);
          try { await this.driver.perform({ action: 'navigate', url: this.#lastUrl } as BrowserCommand); } catch { /* the next read says */ }
          continue;
        }
        if (!counted) { counted = true; this.#stop('page-not-answered', ctx); }
      }
    }
    return false;
  }

  /**
   * Refused before anything was dispatched: a stale observation, a ref that
   * no longer matches, a page that moved. The tool looks again and answers
   * with the fresh page; nothing pauses. Eight in a row asks the owner
   * whether to keep going. The owner looking at the tab and the app behind
   * their window are said as what they are.
   */
  async #precondition(controller: AbortController, error: BrowserPreconditionError, ctx: ToolContext): Promise<never | CardResult> {
    this.#state = 'running';
    if (OWNER_WATCHING.test(error.message)) {
      this.#stop('owner-watching', ctx);
      this.#message = OWNER_WATCHING_MESSAGE;
      throw new BrowserPreconditionError(JSON.stringify({ error: OWNER_WATCHING_MESSAGE, dispatched: false }));
    }
    if (APP_BEHIND.test(error.message)) {
      this.#message = error.message;
      this.#observation = undefined; this.#picture = undefined;
      throw new BrowserPreconditionError(JSON.stringify({ error: error.message, dispatched: false,
        recovery: 'Call browser.act open with the same app now; it needs no approval. It returns the app as it is.' }));
    }
    const cause: StopCause = /stale|latest observation/i.test(error.message) ? 'stale-observation'
      : /changed since|moved|redirect|different page/i.test(error.message) ? 'redirect' : 'stale-ref';
    this.#stop(cause, ctx);
    this.#message = error.message;
    if (++this.#targetingFailures >= MAX_TARGETING_FAILURES) {
      this.#stop('targeting-cap', ctx, 'card');
      return this.#cardResult(this.park('budget'), false);
    }
    const seen = await this.#look(controller, ctx).catch(() => false);
    throw new BrowserPreconditionError(JSON.stringify({ error: error.message, dispatched: false,
      ...(seen && this.#observation?.observedAt ? { message: `${observedLine(this.#observation.observedAt)} The page changed; here it is now.` } : {}),
      recovery: seen ? 'Nothing was done. Re-evaluate from the page below and act on it; prefer target:{ref:"..."} from it.' : browserWaitMessage(),
      ...(seen ? { observation: this.#observation } : {}) }));
  }

  /**
   * The authority shell the secret tools run under: the same page, budget and
   * card rules as `execute`. A secret fill is a browser action like any other;
   * only the value's route differs.
   */
  #under(ctx: ToolContext, action: string, run: (controller: AbortController) => Promise<unknown>): Promise<unknown> {
    return this.#serial(async () => {
      ctx.signal?.throwIfAborted();
      if (!ctx.agentId || !ctx.conversationId) throw new Error('A browser action belongs to an agent and a conversation.');
      if (!this.#enabled) throw new Error('Browser driving is available through buddi serve (dashboard or Telegram), not a separate CLI process.');
      if (this.#state === 'stopped') throw new Error(browserStoppedMessage(ctx.surface));
      if (this.#session && (this.#session.ownerId !== ctx.buddi!.owner.id || this.#session.agentId !== ctx.agentId || this.#session.conversationId !== ctx.conversationId)) {
        throw new Error('Another conversation owns this page.');
      }
      if (this.#state === 'paused') throw new Error('The owner has this page in their hands. Wait for them to give it back.');
      if (!this.#session) throw new Error('Open the page with browser.act navigate before using a secret here.');
      this.#open(ctx.ownerRequest, ctx);
      if (this.#card) return this.#cardResult(this.#card, false);
      const active = this.#session;
      if (active.steps >= active.maxSteps || Date.parse(active.expiresAt) <= this.#now()) {
        this.#stop('budget', ctx);
        return this.#cardResult(this.park('budget'), false);
      }
      ++active.steps; ++active.actions;
      this.#busy = true;
      this.#lastAction = action;
      this.#lastActivity = this.#now();
      this.#message = undefined;
      const controller = new AbortController();
      this.#controller = controller;
      const cancel = () => { controller.abort(ctx.signal?.reason ?? new Error('Browser action stopped.')); void this.#release('idle'); };
      ctx.signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.#state = 'starting';
        await this.driver.start();
        controller.signal.throwIfAborted();
        this.#state = 'running';
        return await run(controller);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (error instanceof BrowserPreconditionError) return await this.#precondition(controller, error, ctx);
        // The value may be part-way into the field: the owner looks.
        this.#state = 'running';
        this.#stop('uncertain-input', ctx, 'card');
        return this.#cardResult(this.park('uncertain'), true, `${error instanceof Error ? error.message.replace(/\.$/, '') : String(error)}. I'm not sure that went through.`);
      } finally {
        ctx.signal?.removeEventListener('abort', cancel);
        if (this.#controller === controller) this.#controller = undefined;
        this.#busy = false; this.#settled();
      }
    });
  }

  /** After a fill or typing the page changed: answer with it, as every action does. */
  async #after(controller: AbortController, ctx: ToolContext, result: Record<string, unknown>): Promise<unknown> {
    const seen = await this.#look(controller, ctx).catch(() => false);
    return seen ? { ...result, observation: this.#observation, message: observedLine(this.#observation!.observedAt!) } : result;
  }

  /**
   * One owner secret into one field of the page this conversation drives
   * (docs/owner-secrets.md §3, §4). The driver reads the field's frame origin,
   * its password mark and its name from the live page; core finds the binding
   * and the destination checks it; the value crosses only into the fill.
   */
  async secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown> {
    return this.#under(ctx, 'secret.fill', async (controller) => {
      if (typeof this.driver.secretFieldInfo !== 'function' || typeof this.driver.secretFillField !== 'function') {
        throw new BrowserPreconditionError('secret.fill works on web pages (buddi\'s own browser or your Chrome); an app window has no page fields to fill.');
      }
      const observation = input.observation ?? this.#observation?.id ?? '';
      const facts = await this.driver.secretFieldInfo(observation, input.ref);
      const secrets = ctx.buddi?.secrets;
      if (secrets === undefined) throw new Error('This plugin has no secrets area; the owner updates the browser plugin to one that declares it.');
      const secret = (await secrets.list()).find((entry) => entry.name === input.name);
      if (secret === undefined) {
        throw new BrowserPreconditionError(`There is no secret named "${input.name}" bound to this browser's destinations. The owner keeps one in Settings, under Keys and secrets.`);
      }
      const visibleField = !secret.totp && !facts.password && fieldBoundTo(secret.bindings, facts.origin);
      const kind = secretKindFor(secret.totp, facts.password, visibleField);
      if (kind === FORM_KIND && facts.name.trim() === '') {
        throw new BrowserPreconditionError('That field has no name the page gives it, so it cannot be a form-field destination. Pick another ref, or ask the owner to bind the secret to the page instead.');
      }
      const named = { origin: facts.origin, field: facts.name };
      const target = kind === FORM_KIND || (visibleField && facts.name.trim() !== '') ? named : facts.origin;
      const outcome = await secrets.use(input.name, kind, target);
      if ('pending' in outcome) {
        return { pending: true, actionId: outcome.pending, message: 'The owner has a decision card for this use. Nothing was filled; ask again once it is decided.' };
      }
      if ('refused' in outcome) throw new BrowserPreconditionError(outcome.refused);
      const value = takeDelivered(outcome.use);
      if (value === undefined) throw new Error('The use delivered nothing to fill with. Ask for the secret again.');
      await this.driver.secretFillField(observation, input.ref, value, facts.origin);
      return this.#after(controller, ctx, { filled: true });
    });
  }

  /** One owner secret typed into the focused field of the focused app (owner-secrets.md §3, native typing). */
  async secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown> {
    return this.#under(ctx, 'secret.type', async (controller) => {
      if (typeof this.driver.focusedBundleId !== 'function' || typeof this.driver.nativeType !== 'function') {
        throw new BrowserPreconditionError('secret.type types into an app on this machine; a web page takes secret.fill instead.');
      }
      const bundleId = await this.driver.focusedBundleId();
      if (!bundleId) throw new BrowserPreconditionError('There is no focused application the backend can name. Bring the app forward and ask again; nothing was typed.');
      const secrets = ctx.buddi?.secrets;
      if (secrets === undefined) throw new Error('This plugin has no secrets area; the owner updates the browser plugin to one that declares it.');
      const outcome = await secrets.use(input.name, NATIVE_KIND, bundleId);
      if ('pending' in outcome) {
        return { pending: true, actionId: outcome.pending, message: 'The owner has a decision card for this use. Nothing was typed; ask again once it is decided.' };
      }
      if ('refused' in outcome) throw new BrowserPreconditionError(outcome.refused);
      const value = takeDelivered(outcome.use);
      if (value === undefined) throw new Error('The use delivered nothing to type. Ask for the secret again.');
      await this.driver.nativeType(value);
      return this.#after(controller, ctx, { typed: true });
    });
  }

  #markHeldEnd(): void {
    const id = this.#session?.id;
    if (id) this.#lastHeld = { id, until: this.#now() + LOGIN_GRACE_MS };
  }

  /** The action in flight went (its `finally` ran): whoever waited on it hears. */
  #settled(): void {
    for (const resolve of this.#settleWaiters.splice(0)) resolve();
  }

  /**
   * The interrupted action, stopped and gone: abort it again, interrupt the
   * driver, and wait for its `finally` — at most a few seconds, because a give
   * back must not hang on an action that will not finish.
   */
  async #settle(limitMs = 10_000): Promise<void> {
    this.#controller?.abort(new Error('Owner took control during an action. Inspect the site before retrying.'));
    const gone = new Promise<void>((resolve) => { this.#settleWaiters.push(resolve); });
    if (this.driver.interrupt) await this.#interrupt().catch(() => false);
    if (!this.#busy) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([gone, new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  /** Stop the action, keep the screen if the driver can. True when there is still something to drive. */
  async #interrupt(): Promise<boolean> {
    if (!this.driver.interrupt) { await this.driver.close().catch(() => {}); return false; }
    try { await this.driver.interrupt(); }
    catch { await this.driver.close().catch(() => {}); return false; }
    return this.driver.handReady?.() !== false;
  }

  async #release(state: BrowserStatus['state']): Promise<void> {
    const session = this.#session;
    if (session && this.options.telemetry) {
      this.options.telemetry.record({ type: 'browser.task', outcome: this.#card ? (this.#card.kind === 'budget' ? 'budget' : 'needs-owner') : state === 'stopped' ? 'stopped' : 'done',
        actions: session.actions, seconds: Math.round((this.#now() - session.startedAt) / 1000), cards: session.cards, agent: session.agentId, route: this.#route, ...(session.requestId === 'unattended' ? { mission: true as const } : {}) });
    }
    if (this.#observation?.url) this.#lastUrl = this.#observation.url;
    this.#handless = false;
    if (this.#held) { this.#markHeldEnd(); this.#held = false; this.driver.resume?.(); }
    this.#state = state;
    this.#controller?.abort(new Error(`Browser ${state}. An in-flight submission may have completed; inspect before retrying.`));
    clearTimeout(this.#expiry);
    this.#session = undefined;
    this.#observation = undefined;
    this.#picture = undefined;
    this.#lastAction = undefined;
    this.#message = undefined;
    this.#card = undefined;
    this.#targetingFailures = 0;
    await this.driver.close();
  }

  /**
   * Take over a page in the owner's own Chrome: no stream, the tab itself.
   * An action in flight is abandoned first (the tab is kept), then the tab is
   * brought to the front of their Chrome with its bar saying buddi waits.
   * When Chrome cannot do that (closed, an extension too old to know how),
   * the page stays paused and the message says where it is instead.
   */
  async #holdInPlace(): Promise<void> {
    this.#held = false;
    if (this.#busy) {
      this.#controller?.abort(new Error('Owner took control during an action. Inspect the site before retrying.'));
      this.#picture = undefined;
      this.#observation = undefined;
      await this.#interrupt();
    }
    try {
      await this.driver.takeover?.();
      this.#held = true;
      this.#message = 'The page is in front of you in your Chrome. Give it back when you are done.';
    } catch (error) {
      const why = error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
      this.#message = `Your Chrome couldn't bring the page forward (${why}). It is in the buddi tab group there; give it back when you are done.`;
    }
  }

  /** Only authenticated owner UI handlers call this; it is not an agent tool. */
  control(action: 'stop' | 'takeover' | 'resume' | 'release', expectedSessionId?: string): Promise<BrowserStatus> {
    const run = async () => {
      if (!this.#enabled) throw new Error('The host browser service is unavailable.');
      if (expectedSessionId !== undefined && this.#session?.id !== expectedSessionId) {
        throw new Error('The page changed. Refresh before controlling it.');
      }
      if (action === 'stop') {
        await this.#release('stopped');
      } else if (action === 'takeover') {
        this.#state = 'paused';
        this.#message = undefined;
        this.#card = undefined;
        if (this.driver.holdsInPlace) {
          await this.#holdInPlace();
        } else if (this.#busy) {
          // Take over is pressed most often *while* the agent works on a login:
          // the action is abandoned and the page kept, when the driver can.
          this.#controller?.abort(new Error('Owner took control during an action. Inspect the site before retrying.'));
          this.#picture = undefined;
          this.#observation = undefined;
          const kept = await this.#interrupt();
          this.#handless = !kept;
          this.#message = kept
            ? 'The action in flight was stopped; the page is yours. Give it back when you are done.'
            : this.driver.preservesWindows ? 'Computer input was interrupted. Your apps remain open. Give it back when you are done.' : 'The action in flight was stopped and the window closed. Give it back and the agent opens the page again.';
        } else {
          await this.driver.takeover?.();
          this.#message = this.driver.preservesWindows ? 'The app is yours. Give it back when you are done.' : 'The page is yours. Give it back when you are done.';
        }
      } else if (action === 'resume') {
        // Given back while the interrupted action is still stopping: stop it for good and wait for it, then give back. Never a refusal:
        // the owner's Chrome has already taken its bar down.
        if (this.#busy) await this.#settle();
        if (this.#held) this.#markHeldEnd();
        this.driver.resume?.();
        this.#handless = false;
        this.#held = false;
        this.#observation = undefined;
        this.#picture = undefined;
        // The owner acted: a fresh budget, and the agent's next action returns the page as the owner left it.
        this.renew();
        this.#state = this.#session ? 'running' : 'idle';
        this.#message = 'Given back. The agent carries on from the page as you left it.';
      } else {
        await this.#release(this.#state === 'stopped' ? 'stopped' : 'idle');
      }
      return this.status();
    };
    const next = this.#controlTail.then(run, run);
    this.#controlTail = next.catch(() => {});
    return next;
  }

  async shutdown(): Promise<void> {
    await this.#release('unavailable');
    this.#enabled = false;
  }
}
