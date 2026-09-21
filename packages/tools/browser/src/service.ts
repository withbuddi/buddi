import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@buddi/core';
import type { BrowserCommand, BrowserDriver, Observation } from './types.js';
import { BrowserPreconditionError, UNTRUSTED } from './types.js';

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
}
export interface BrowserScope { sessionId?: string; agentId?: string; conversationId?: string }
/** Trusted lifecycle input, never exposed in an agent tool schema. */
export interface BrowserRollover { ownerId: string; agentId: string; previousConversationId: string; conversationId: string }
export interface BrowserController {
  enable(): Promise<void>;
  shutdown(): Promise<void>;
  status(scope?: BrowserScope): BrowserStatus;
  screenshot(sessionId?: string): Buffer | undefined;
  execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown>;
  control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string): Promise<BrowserStatus>;
  configure?(settings: unknown): Promise<BrowserStatus>;
  checkPermissions?(prompt?: boolean): Promise<BrowserStatus>;
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
    if (this.#state === 'stopped') throw new Error('The owner stopped the browser. Only the owner can enable it again in the dashboard.');
    if (this.#busy) throw new Error('Browser is busy; overlapping actions are refused.');
    if (this.#session && (this.#session.ownerId !== ctx.ownerId || this.#session.agentId !== ctx.agentId || this.#session.conversationId !== ctx.conversationId)) {
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
      const expiresAt = Math.min(request.expiresAt, this.#now() + (this.options.lifetimeMs ?? 20 * 60_000));
      if (this.#session) this.#spent.add(this.#session.requestId);
      this.#preconditionFailures = 0;
      this.#session = { id: this.#session?.id ?? randomUUID(), ownerId: ctx.ownerId, agentId: ctx.agentId,
        conversationId: ctx.conversationId, requestId: request.id, task: request.text.slice(0, 4000),
        expiresAt: new Date(expiresAt).toISOString(), steps: 0, maxSteps: this.options.maxSteps ?? 80 };
      clearTimeout(this.#expiry);
      this.#expiry = setTimeout(() => { void this.#release('expired'); }, Math.max(1, expiresAt - this.#now()));
      this.#expiry.unref?.();
    }
    if (Date.parse(this.#session.expiresAt) <= this.#now() || this.#session.steps >= this.#session.maxSteps) {
      await this.#release('expired');
      throw new Error('Browser task reached its time or step limit. Ask the owner for a new request.');
    }
    ++this.#session.steps;
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

  async #release(state: BrowserStatus['state']): Promise<void> {
    this.#needsObservation = false;
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
          this.#controller?.abort(new Error('Owner took control during an action. Inspect the site before retrying.'));
          await this.driver.close();
          this.#picture = undefined;
          this.#observation = undefined;
          this.#message = this.driver.preservesWindows ? 'Computer input was interrupted. Your apps remain open. Inspect the result, resume, then ask the agent to observe.' : 'The in-flight action was interrupted and the window closed. Resume and ask the agent to navigate again.';
        } else {
          await this.driver.takeover?.();
          this.#message = this.driver.preservesWindows ? 'Computer control is paused. Use the selected app, then resume here and ask the agent to observe.' : 'Use this conversation’s host tab for login or manual work. Resume here when ready, then ask the agent to observe.';
        }
      } else if (action === 'resume') {
        if (this.#busy) throw new Error('Wait for the interrupted action to settle before resuming.');
        await this.#persistStop(false);
        this.driver.resume?.();
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
