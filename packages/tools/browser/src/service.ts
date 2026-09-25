import type { InstallProgress, LaunchCheck } from './availability.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { SurfaceProfile, ToolContext } from '@buddi/core/plugin';
import { FORM_KIND, NATIVE_KIND, secretKindFor, takeDelivered } from './secrets.js';
import type { BrowserCommand, BrowserDriver, BrowserHand, Observation } from './types.js';
import { BrowserPreconditionError, UNTRUSTED } from './types.js';

/**
 * "The owner stopped the browser", said where the owner can undo it.
 *
 * The *fact* is one sentence; the way back differs by surface, and the surface
 * is already on the tool context (`ctx.surface`), so the plugin says it rather
 * than leaving a relay to guess. On Telegram the way back is a command in the
 * same chat; everywhere else it is the dashboard's own Settings page, which is
 * where the Stop button lives.
 */
export function browserStoppedMessage(surface?: SurfaceProfile): string {
  return surface?.id === 'telegram'
    ? 'The owner stopped the browser. Only the owner can enable it again — send /browser resume here.'
    : 'The owner stopped the browser. Only the owner can enable it again in the dashboard, on the Settings page.';
}

/** The three ways an agent can get a screen. */
export type BrowserMode = 'computer' | 'playwright' | 'extension';

/** Already classified: do not retry observation or overwrite the paused state. */
class ObservationFailure extends Error {}

export interface BrowserStatus {
  mode?: BrowserMode;
  settings?: { mode: BrowserMode; browserApp: string; allowedApps: string[]; browserProfile?: string };
  permissions?: { accessibility: boolean; screenRecording: boolean; supported: boolean; message?: string };
  state: 'unavailable' | 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'expired' | 'error';
  enabled: boolean;
  busy: boolean;
  session?: { id: string; agentId: string; conversationId: string; requestId: string; task: string; expiresAt: string; steps: number; maxSteps: number };
  page?: Omit<Observation, 'tree' | 'targets'>;
  lastAction?: string;
  message?: string;
  hasScreenshot: boolean;
  /** Owner dashboard only; agent tools receive just their conversation. */
  sessions?: BrowserStatus[];
  /** The agents' own browser on this machine: what launches, and how. Own-browser mode only. */
  browser?: BrowserEngineStatus;
}
/** What the agents' own browser is here, and what the owner can do about it. */
export interface BrowserEngineStatus {
  /** `none`: nothing to launch until the owner installs one. */
  engine: 'chromium' | 'chrome' | 'none';
  /** No display on this Linux machine, so it runs headless. */
  headless: boolean;
  /** The last launch failed for missing Linux libraries, or because the system would not let Chromium start its sandbox. */
  problem?: 'missing-libraries' | 'no-sandbox';
  /** One or two sentences for the owner, when there is something to say. */
  message?: string;
  /**
   * The install started from the dashboard, while it runs and after.
   * `progress` is the installer's output read into numbers, for a progress
   * bar; `line` is buddi's sentence at the end — installed, or why not —
   * never the installer's raw progress text.
   */
  install?: { state: 'running' | 'done' | 'failed'; line?: string; progress?: InstallProgress };
}
export interface BrowserScope { sessionId?: string; agentId?: string; conversationId?: string }
/**
 * What the dashboard is offered when it asks to drive.
 *
 * `supported: false` is a mode that will never have a hand and the sentence to
 * show instead; a supported mode with no `hand` is one nobody has taken over
 * yet, which is a state the owner can leave by pressing Take over.
 */
export interface BrowserHandOffer { supported: boolean; message?: string; hand?: BrowserHand }
/** Trusted lifecycle input, never exposed in an agent tool schema. */
export interface BrowserRollover { ownerId: string; agentId: string; previousConversationId: string; conversationId: string }
/** What `secret.fill` asks: the secret's name, and the ref and observation the latest evidence carries. */
export interface SecretFillInput { name: string; ref: string; observation: string }
/** What `secret.type` asks: the secret's name; the focused app is the backend's answer. */
export interface SecretTypeInput { name: string }
export interface BrowserController {
  enable(): Promise<void>;
  shutdown(): Promise<void>;
  status(scope?: BrowserScope): BrowserStatus;
  screenshot(sessionId?: string): Buffer | undefined;
  execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown>;
  /**
   * The owner's secret into one field of the page this conversation drives
   * (docs/owner-secrets.md §3, §4). Same authority as `execute`; the
   * value crosses only from the vault through the destination's `deliver` to
   * the driver, and the result says filled, pending or the refusal — never a
   * value.
   */
  secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown>;
  /** The owner's secret typed into the focused field of the focused app, in Computer mode. */
  secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown>;
  control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string): Promise<BrowserStatus>;
  /** The remote hand for one session. Owner UI only; no agent tool reaches it. */
  hand?(scope?: BrowserScope): BrowserHandOffer;
  configure?(settings: unknown): Promise<BrowserStatus>;
  checkPermissions?(prompt?: boolean): Promise<BrowserStatus>;
  /** Start Playwright's Chromium install. Returns at once; the status carries its progress. */
  installBrowser?(): BrowserStatus;
  /** Launch the agents' browser once and close it: does it start on this machine? Owner UI only. */
  checkLaunch?(): Promise<LaunchCheck>;
  rollover?(input: BrowserRollover): boolean;
}

/** One host controller shared by all registry instances/surfaces in serve.
 * CLI processes are deliberately unavailable, not a second browser owner. */
export class BrowserService {
  #enabled = false;
  #state: BrowserStatus['state'] = 'unavailable';
  #session?: NonNullable<BrowserStatus['session']> & { ownerId: string };
  #observation?: Observation;
  #picture?: Buffer;
  #busy = false;
  /**
   * The screen this session had is gone.
   *
   * Set when a take-over had to close the driver to end the action in flight,
   * and cleared by resume. Belt to `handReady`'s braces: a hand offered over
   * nothing is a live view that never paints its first frame, and the owner
   * has no way to tell that from a slow link.
   */
  #handless = false;
  #controller?: AbortController;
  #expiry?: ReturnType<typeof setTimeout>;
  #lastAction?: string;
  #message?: string;
  #preconditionFailures = 0;
  #needsObservation = false;
  #spent = new Set<string>();
  #controlTail: Promise<unknown> = Promise.resolve();
  #diskTail: Promise<void> = Promise.resolve();
  constructor(readonly driver: BrowserDriver, readonly options: {
    controlFile?: string;
    maxSteps?: number;
    lifetimeMs?: number;
    now?: () => number;
    allowOpen?: boolean;
  } = {}) {}
  #now(): number { return this.options.now?.() ?? Date.now(); }

  async enable(): Promise<void> {
    if (this.#enabled) return;
    if (this.options.controlFile) {
      try {
        const state = JSON.parse(await readFile(this.options.controlFile, 'utf8'));
        this.#state = state.stopped ? 'stopped' : 'idle';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.#state = 'idle';
      }
    } else this.#state = 'idle';
    this.#enabled = true;
  }

  status(_scope?: BrowserScope): BrowserStatus {
    const { tree: _tree, targets: _targets, ...page } = this.#observation ?? {};
    const { ownerId: _owner, ...session } = this.#session ?? {};
    return { state: this.#state, enabled: this.#enabled, busy: this.#busy,
      ...(this.#session ? { session: session as NonNullable<BrowserStatus['session']> } : {}),
      ...(this.#observation ? { page: page as Omit<Observation, 'tree' | 'targets'> } : {}),
      lastAction: this.#lastAction, message: this.#message, hasScreenshot: !!this.#picture };
  }

  screenshot(_sessionId?: string): Buffer | undefined { return this.#picture; }

  /**
   * The remote hand, and only while the owner holds this screen.
   *
   * Paused is the take-over state, so it is also the only state in which a
   * dashboard may drive: an agent mid-action and a hand on the same page would
   * be two drivers, and the evidence rules here assume exactly one.
   */
  hand(_scope?: BrowserScope): BrowserHandOffer {
    if (this.driver.supportsHand === false || !this.driver.hand) {
      return { supported: false, message: this.driver.handMessage ?? 'Take over at the computer for this mode.' };
    }
    if (!this.#session) return { supported: true, message: 'No agent is driving this screen.' };
    if (this.#state !== 'paused') return { supported: true, message: 'Take over first, then you can drive.' };
    // Paused is not the same as paintable. A take-over that interrupted an
    // action closed the screen that action was on, and a hand offered over
    // nothing is a live view that never draws its first frame.
    if (this.#handless || this.driver.handReady?.() === false) {
      return { supported: true, message: this.#message ?? 'There is no screen to drive. Resume and ask the agent to open the page again.' };
    }
    return { supported: true, hand: this.driver.hand };
  }

  rollover(input: BrowserRollover): boolean {
    const session = this.#session;
    if (!session || session.ownerId !== input.ownerId || session.agentId !== input.agentId || session.conversationId !== input.previousConversationId) return false;
    if (!this.#enabled || this.#busy || !['running', 'paused'].includes(this.#state)) throw new Error('Wait for computer/browser control to settle before continuing the conversation.');
    if (Date.parse(session.expiresAt) <= this.#now()) return false;
    this.#spent.add(session.requestId);
    session.conversationId = input.conversationId;
    this.#observation = undefined;
    this.#picture = undefined;
    this.#needsObservation = true;
    this.#message = 'Task continued after conversation rollover. Observe the current page before acting. Human takeover, if active, still requires owner resume.';
    return true;
  }

  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    const request = ctx.ownerRequest;
    if (!request || !request.id || !request.text.trim() || request.expiresAt <= this.#now() ||
      !ctx.agentId || !ctx.conversationId || (ctx.delegationDepth ?? 0) > 0) {
      throw new Error('A current authenticated owner request is required.');
    }
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve (dashboard or Telegram), not a separate CLI process.');
    if (this.#state === 'stopped') throw new Error(browserStoppedMessage(ctx.surface));
    if (this.#busy) throw new Error('Browser is busy; overlapping actions are refused.');
    if (this.#session && (this.#session.ownerId !== ctx.buddi!.owner.id || this.#session.agentId !== ctx.agentId || this.#session.conversationId !== ctx.conversationId)) {
      throw new Error('Another agent/conversation owns the browser. Ask the owner to release it from the dashboard.');
    }
    if (this.#spent.has(request.id)) throw new Error('This browser request has ended. A new owner message is required.');
    if (command.action === 'close') {
      this.#spent.add(request.id);
      await this.#release('idle');
      return { closed: true, notice: UNTRUSTED };
    }
    if (this.#state === 'paused') throw new Error('Browser is under human control or needs inspection. Wait for the owner to resume in the dashboard, then observe.');
    if (this.#needsObservation && command.action !== 'observe') throw new Error('A fresh observation is required: observe the current page before acting. Do not replay an earlier action.');
    if (!this.#session || this.#session.requestId !== request.id) {
      if (!this.#session && command.action !== 'navigate' && !(this.options.allowOpen && command.action === 'open')) throw new Error('Start with navigate, or open an allowed application in computer mode.');
      this.#rekey(request, ctx.agentId!, ctx.conversationId!, ctx.buddi!.owner.id);
    }
    const active = this.#session;
    if (!active || Date.parse(active.expiresAt) <= this.#now() || active.steps >= active.maxSteps) {
      await this.#release('expired');
      throw new Error('Browser task reached its time or step limit. Ask the owner for a new request.');
    }
    ++active.steps;
    this.#busy = true;
    this.#lastAction = command.action; // Never record form values here.
    this.#message = undefined;
    const controller = new AbortController();
    this.#controller = controller;
    const cancel = () => {
      controller.abort(ctx.signal?.reason ?? new Error('Browser action stopped.'));
      this.#spent.add(request.id);
      void this.#release('stopped');
      void this.#persistStop(true).catch(() => {});
    };
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.#state = 'starting';
      await this.driver.start();
      controller.signal.throwIfAborted();
      ctx.signal?.throwIfAborted();
      this.#state = 'running';
      await this.driver.perform(command);
      if (command.action !== 'observe') this.#preconditionFailures = 0;
      controller.signal.throwIfAborted();
      // Once input succeeds, observation loss must not invite replaying it.
      // For an observe-only command, however, observation IS the whole action.
      try {
        const observation = await this.driver.observe();
        const picture = await this.driver.screenshot();
        controller.signal.throwIfAborted();
        this.#observation = observation;
        this.#picture = picture;
        this.#needsObservation = false;
      } catch (error) {
        controller.signal.throwIfAborted();
        this.#observation = undefined;
        this.#picture = undefined;
        this.#needsObservation = true;
        this.#state = 'paused';
        const cause = error instanceof Error ? error.message : String(error);
        const recovery = 'Control is paused. Ask the owner to inspect the selected app/window and the reported cause, then use Resume access and ask for a fresh observation. Do not retry while paused or guess targets. This is an observation failure, not an ownership conflict.';
        this.#message = `${command.action === 'observe' ? 'Observation failed' : 'Action completed, but observation failed'}: ${cause}. ${recovery}${command.action === 'observe' ? '' : ' Do not repeat the action; its effect may already have happened.'}`;
        const result = { completed: command.action !== 'observe', observed: false, error: cause,
          state: 'paused', recovery, message: this.#message, notice: UNTRUSTED };
        if (command.action === 'observe') throw new ObservationFailure(JSON.stringify(result));
        return result;
      }
      controller.signal.throwIfAborted();
      return { completed: true, notice: UNTRUSTED, observation: this.#observation, message: this.#message };
    } catch (error) {
      if (error instanceof ObservationFailure) throw error;
      if (!controller.signal.aborted && error instanceof BrowserPreconditionError) {
        await this.#precondition(controller, error);
      }
      if (!controller.signal.aborted) {
        this.#state = error instanceof BrowserPreconditionError ? 'running'
          : ['click', 'fill', 'select', 'press'].includes(command.action) ? 'paused' : 'error';
        this.#message = `${error instanceof Error ? error.message : String(error)}${this.#state === 'paused' ? ' The action may have partially completed. Inspect it before resuming; do not repeat a submission.' : ''}`;
      }
      throw error;
    } finally {
      ctx.signal?.removeEventListener('abort', cancel);
      if (this.#controller === controller) this.#controller = undefined;
      this.#busy = false;
    }
  }

  /**
   * A new owner message continues the session under that message's request:
   * the old one is spent, the step budget and the failure count reset, and the
   * expiry runs from now. The session id survives, so the conversation still
   * owns the same screen it always did.
   */
  #rekey(request: NonNullable<ToolContext['ownerRequest']>, agentId: string, conversationId: string, ownerId: string): void {
    const expiresAt = Math.min(request.expiresAt, this.#now() + (this.options.lifetimeMs ?? 20 * 60_000));
    if (this.#session) this.#spent.add(this.#session.requestId);
    this.#preconditionFailures = 0;
    this.#session = { id: this.#session?.id ?? randomUUID(), ownerId, agentId,
      conversationId, requestId: request.id, task: request.text.slice(0, 4000),
      expiresAt: new Date(expiresAt).toISOString(), steps: 0, maxSteps: this.options.maxSteps ?? 80 };
    clearTimeout(this.#expiry);
    this.#expiry = setTimeout(() => { void this.#release('expired'); }, Math.max(1, expiresAt - this.#now()));
    this.#expiry.unref?.();
  }

  /**
   * The precondition path every refused action takes, `browser.act`'s and the
   * secret tools' alike: count the failure, pause on the third, and recover
   * fresh evidence so the next call acts on what the page now shows rather
   * than on the stale arguments. Nothing was dispatched for any of these.
   */
  async #precondition(controller: AbortController, error: BrowserPreconditionError): Promise<never> {
    this.#message = error.message;
    this.#state = ++this.#preconditionFailures >= 3 ? 'paused' : 'running';
    if (this.#state === 'paused') this.#message += ' Repeated targeting failures: ask the owner to inspect and resume. No input was dispatched.';
    // Recover evidence, never replay input. Keep this a failed tool result
    // so the runtime skips any remaining sequential calls in this batch.
    try {
      const observation = await this.driver.observe();
      const picture = await this.driver.screenshot();
      controller.signal.throwIfAborted();
      this.#observation = observation;
      this.#picture = picture;
    } catch (observationError) {
      controller.signal.throwIfAborted();
      this.#observation = undefined;
      this.#picture = undefined;
      this.#needsObservation = true;
      this.#state = 'paused';
      this.#message += ` Recovery observation failed: ${observationError instanceof Error ? observationError.message : String(observationError)}. Inspect the selected app/window and this error, then resume and observe. Do not retry while paused.`;
    }
    throw new BrowserPreconditionError(JSON.stringify({ error: this.#message, dispatched: false,
      recovery: this.#state === 'paused' ? 'Wait for owner resume. Do not retry.' : 'Re-evaluate using the fresh observation below. Prefer target:{ref:"..."} and this observation.id. Do not guess an index or reuse the previous observation.',
      observation: this.#observation }));
  }

  /**
   * The authority shell the secret tools run under: exactly `execute`'s gates —
   * the same authenticated owner request, the same single-owner lock, the same
   * stopped/busy/paused/fresh-evidence refusals, the same step and expiry
   * budget — and its start sequence and precondition path. A secret fill is a
   * browser action like any other; only the value's route differs.
   */
  async #under(ctx: ToolContext, action: string, run: (controller: AbortController) => Promise<unknown>): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    const request = ctx.ownerRequest;
    if (!request || !request.id || !request.text.trim() || request.expiresAt <= this.#now() ||
      !ctx.agentId || !ctx.conversationId || (ctx.delegationDepth ?? 0) > 0) {
      throw new Error('A current authenticated owner request is required.');
    }
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve (dashboard or Telegram), not a separate CLI process.');
    if (this.#state === 'stopped') throw new Error(browserStoppedMessage(ctx.surface));
    if (this.#busy) throw new Error('Browser is busy; overlapping actions are refused.');
    if (this.#session && (this.#session.ownerId !== ctx.buddi!.owner.id || this.#session.agentId !== ctx.agentId || this.#session.conversationId !== ctx.conversationId)) {
      throw new Error('Another agent/conversation owns the browser. Ask the owner to release it from the dashboard.');
    }
    if (this.#spent.has(request.id)) throw new Error('This browser request has ended. A new owner message is required.');
    if (this.#state === 'paused') throw new Error('Browser is under human control or needs inspection. Wait for the owner to resume in the dashboard, then observe.');
    if (this.#needsObservation) throw new Error('A fresh observation is required: observe the current page before acting. Do not replay an earlier action.');
    if (!this.#session) throw new Error('Start with navigate, or open an allowed application, and observe before using a secret here.');
    if (this.#session.requestId !== request.id) this.#rekey(request, ctx.agentId!, ctx.conversationId!, ctx.buddi!.owner.id);
    const active = this.#session;
    if (!active || Date.parse(active.expiresAt) <= this.#now() || active.steps >= active.maxSteps) {
      await this.#release('expired');
      throw new Error('Browser task reached its time or step limit. Ask the owner for a new request.');
    }
    ++active.steps;
    this.#busy = true;
    this.#lastAction = action;
    this.#message = undefined;
    const controller = new AbortController();
    this.#controller = controller;
    const cancel = () => {
      controller.abort(ctx.signal?.reason ?? new Error('Browser action stopped.'));
      this.#spent.add(request.id);
      void this.#release('stopped');
      void this.#persistStop(true).catch(() => {});
    };
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.#state = 'starting';
      await this.driver.start();
      controller.signal.throwIfAborted();
      ctx.signal?.throwIfAborted();
      this.#state = 'running';
      return await run(controller);
    } catch (error) {
      if (!controller.signal.aborted && error instanceof BrowserPreconditionError) {
        await this.#precondition(controller, error);
      }
      if (!controller.signal.aborted) {
        // A failed fill or a failed typing is an uncertain input: the value may
        // be part-way into the field, so the session pauses rather than invites
        // a repeat, exactly as a fill or a click does.
        this.#state = 'paused';
        this.#message = `${error instanceof Error ? error.message : String(error)} The action may have partially completed. Inspect it before resuming; do not repeat a submission.`;
      }
      throw error;
    } finally {
      ctx.signal?.removeEventListener('abort', cancel);
      if (this.#controller === controller) this.#controller = undefined;
      this.#busy = false;
    }
  }

  /**
   * One owner secret into one field of the page this conversation drives
   * (docs/owner-secrets.md §3, §4).
   *
   * The order is the security argument. The driver reads the field's frame
   * origin, its password mark and its accessible name from the live page — the
   * backend reports, the agent never claims (§8) — then core finds the binding,
   * the destination checks that target against it, the rule is applied and the
   * vault read, and the destination's `deliver` parks the value against the use
   * id. Only then does the driver fill, re-checking the origin once more
   * against what the use was delivered for. The result is `{ filled: true }`
   * or a pending card; a refusal is the refusal's own sentence, and a value
   * appears in none of them.
   */
  async secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown> {
    return this.#under(ctx, 'secret.fill', async () => {
      if (typeof this.driver.secretFieldInfo !== 'function' || typeof this.driver.secretFillField !== 'function') {
        throw new BrowserPreconditionError('secret.fill works in Playwright browser automation or in the buddi extension mode; this mode has no page fields to fill. Switch modes on the dashboard Settings page.');
      }
      const facts = await this.driver.secretFieldInfo(input.observation, input.ref);
      const secrets = ctx.buddi?.secrets;
      if (secrets === undefined) throw new Error('This plugin has no secrets area; the owner updates the browser plugin to one that declares it.');
      const secret = (await secrets.list()).find((entry) => entry.name === input.name);
      if (secret === undefined) {
        throw new BrowserPreconditionError(`There is no secret named "${input.name}" bound to this browser's destinations. The owner keeps one in Settings, under Keys and secrets.`);
      }
      const kind = secretKindFor(secret.totp, facts.password);
      if (kind === FORM_KIND && facts.name.trim() === '') {
        throw new BrowserPreconditionError('That field has no name the page gives it, so it cannot be a form-field destination. Observe again, or ask the owner to bind the secret to the page instead.');
      }
      const outcome = await secrets.use(input.name, kind, kind === FORM_KIND ? { origin: facts.origin, field: facts.name } : facts.origin);
      if ('pending' in outcome) {
        return { pending: true, actionId: outcome.pending, message: 'The owner has a decision card for this use. Nothing was filled; ask again once it is decided.' };
      }
      if ('refused' in outcome) throw new BrowserPreconditionError(outcome.refused);
      const value = takeDelivered(outcome.use);
      if (value === undefined) throw new Error('The use delivered nothing to fill with. Ask for the secret again.');
      await this.driver.secretFillField(input.observation, input.ref, value, facts.origin);
      this.#needsObservation = true; // The field just changed; the next action observes first.
      return { filled: true };
    });
  }

  /**
   * One owner secret typed into the focused field of the focused app
   * (owner-secrets.md §3, native typing).
   *
   * The bundle id is the backend's answer about whatever app is in front right
   * now, and the helper re-checks it before the first keystroke, so an app
   * switch between the owner's approval and the typing refuses with nothing
   * typed. There is no observed target here — the field is whatever the owner
   * left focused — which is why the destination's loosest rule is a card every
   * time.
   */
  async secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown> {
    return this.#under(ctx, 'secret.type', async () => {
      if (typeof this.driver.focusedBundleId !== 'function' || typeof this.driver.nativeType !== 'function') {
        throw new BrowserPreconditionError('secret.type works in Computer mode, which types into the focused app on this machine through macOS accessibility; this mode has no native typing. Switch modes on the dashboard Settings page.');
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
      this.#needsObservation = true; // The screen just changed; the next action observes first.
      return { typed: true };
    });
  }

  async #persistStop(stopped: boolean): Promise<void> {
    if (!this.options.controlFile) return;
    const file = this.options.controlFile;
    const write = async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ stopped }), { mode: 0o600 });
      await rename(temp, file);
    };
    const next = this.#diskTail.then(write, write);
    this.#diskTail = next.catch(() => {});
    await next;
  }

  /**
   * Stop the action, keep the screen if the driver can.
   *
   * True when there is still something to drive afterwards. A driver with no
   * `interrupt` — or one whose page really did go — has its screen closed
   * instead, which is the old behaviour and still the honest answer when there
   * is nothing left to paint.
   */
  async #interrupt(): Promise<boolean> {
    if (!this.driver.interrupt) { await this.driver.close().catch(() => {}); return false; }
    try { await this.driver.interrupt(); }
    catch { await this.driver.close().catch(() => {}); return false; }
    return this.driver.handReady?.() !== false;
  }

  async #release(state: BrowserStatus['state']): Promise<void> {
    this.#needsObservation = false;
    this.#handless = false;
    this.#state = state;
    if (this.#session) this.#spent.add(this.#session.requestId);
    this.#controller?.abort(new Error(`Browser ${state}. An in-flight submission may have completed; inspect before retrying.`));
    clearTimeout(this.#expiry);
    this.#session = undefined;
    this.#observation = undefined;
    this.#picture = undefined;
    this.#lastAction = undefined;
    this.#message = undefined;
    this.#preconditionFailures = 0;
    await this.driver.close();
  }

  /** Only authenticated owner UI handlers call this; it is not an agent tool. */
  control(action: 'stop' | 'takeover' | 'resume' | 'release', expectedSessionId?: string): Promise<BrowserStatus> {
    const run = async () => {
      if (!this.#enabled) throw new Error('The host browser service is unavailable.');
      if (expectedSessionId !== undefined && this.#session?.id !== expectedSessionId) {
        throw new Error('The browser session changed. Refresh before controlling it.');
      }
      if (action === 'stop') {
        // Revoke in memory before disk IO, so a pending call cannot race it.
        const closing = this.#release('stopped');
        await this.#persistStop(true);
        await closing;
      } else if (action === 'takeover') {
        this.#state = 'paused';
        this.#message = undefined;
        if (this.#busy) {
          // The owner presses Take over *because* the agent is working: it
          // reached a login, an MFA prompt or a consent banner and is still
          // going round on it. That page is the whole point of the button, so
          // the action is abandoned and the page is kept. Every branch of
          // `execute` that would otherwise decide what this failure means is
          // guarded by `controller.signal.aborted`, so aborting here is also
          // what stops the interrupted command from overwriting `paused`.
          this.#controller?.abort(new Error('Owner took control during an action. Inspect the site before retrying.'));
          this.#picture = undefined;
          this.#observation = undefined;
          this.#needsObservation = !!this.#session;
          const kept = await this.#interrupt();
          this.#handless = !kept;
          this.#message = kept
            ? 'The in-flight action was interrupted; the page is still open and yours to use. Resume here when ready, then ask the agent to observe.'
            : this.driver.preservesWindows ? 'Computer input was interrupted. Your apps remain open. Inspect the result, resume, then ask the agent to observe.' : 'The in-flight action was interrupted and the window closed. Resume and ask the agent to navigate again.';
        } else {
          await this.driver.takeover?.();
          this.#message = this.driver.preservesWindows ? 'Computer control is paused. Use the selected app, then resume here and ask the agent to observe.' : 'Use this conversation’s host tab for login or manual work. Resume here when ready, then ask the agent to observe.';
        }
      } else if (action === 'resume') {
        if (this.#busy) throw new Error('Wait for the interrupted action to settle before resuming.');
        await this.#persistStop(false);
        this.driver.resume?.();
        this.#handless = false;
        this.#preconditionFailures = 0;
        this.#observation = undefined;
        this.#picture = undefined;
        this.#needsObservation = !!this.#session;
        if (this.#session && Date.parse(this.#session.expiresAt) <= this.#now()) await this.#release('idle');
        this.#state = this.#session ? 'running' : 'idle';
        this.#message = 'Ready. Send a new message to the agent to continue.';
      } else {
        const stopped = this.#state === 'stopped';
        await this.#release(stopped ? 'stopped' : 'idle');
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
