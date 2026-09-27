import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolRefusal, type EffectDescription, type ToolContext } from '@buddi/core/plugin';
import { BrowserManager } from './manager.js';
import { PlaywrightHost, type LaunchProblem } from './host.js';
import type { GuardedLookup } from './proxy.js';
import { PlaywrightDriver } from './driver.js';
import { ComputerDriver, NativeComputerBridge, resolveApp, settingsSchema, spotlightApps, type AppResolver, type ComputerBridge, type ComputerPermissions, type ControlSettings, type InstalledApp } from './computer.js';
import { ExtensionDriver, NOT_CONNECTED, type ExtensionBridge } from './extension.js';
import type { BrowserController, BrowserEngineStatus, BrowserHandOffer, BrowserScope, BrowserStatus, BrowserRollover, SecretFillInput, SecretTypeInput } from './service.js';
import { BrowserPreconditionError, type BrowserCommand } from './types.js';
import { detectBrowser, HEADLESS_NOTE, installBrowser, InstallProgressReader, missingLibrariesMessage, needsHeadless, noSandboxMessage, NO_BROWSER_STATUS, probeLaunch, type BrowserAvailability, type InstallOutcome, type LaunchCheck, type ProbeDeps } from './availability.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The one control an app card carries: how long the yes lasts. */
const REMEMBER = { key: 'remember', label: 'Allow', options: ['Once', 'Always'], default: 'Once' };
/** What an app card's envelope says, read back from the ledger. */
interface AppEnvelope { tool: 'browser.act'; allowApp: string; name: string }
function isAppEnvelope(value: unknown): value is AppEnvelope {
  return typeof value === 'object' && value !== null && typeof (value as AppEnvelope).allowApp === 'string';
}

/** Owner-only mode switch. No automatic fallback and no model-selected driver. */
export class HostController implements BrowserController {
  #manager: BrowserManager;
  #settings: ControlSettings = settingsSchema.parse({});
  #permissions?: ComputerPermissions;
  #enabled = false;
  #changing = false;
  #requests = new Map<string, { expiresAt: number; revoked: boolean }>();
  #extension?: () => ExtensionBridge;
  #problem?: LaunchProblem;
  #install?: NonNullable<BrowserEngineStatus['install']>;
  /** Apps the owner allowed Once, by conversation. Memory only: the ledger answers again after a restart. */
  #once = new Map<string, Set<string>>();
  /** The conversation whose `browser.act` is running, for the driver's app check. */
  #acting?: string;
  constructor(readonly dir: string, readonly options: {
    channel?: 'chrome'; allowedHosts?: readonly string[];
    bridge?: () => ComputerBridge;
    extensionBridge?: () => ExtensionBridge;
    manager?: (settings: ControlSettings) => BrowserManager;
    lookup?: GuardedLookup;
    /** Defaults to this process's platform. Computer control exists only on darwin. */
    platform?: NodeJS.Platform;
    /** Read for DISPLAY and WAYLAND_DISPLAY. Defaults to this process's. */
    env?: NodeJS.ProcessEnv;
    /** Which browser exists here. Defaults to looking on disk. */
    detect?: () => BrowserAvailability;
    /** Playwright's Chromium installer. Injectable for tests. */
    installer?: (onLine: (line: string) => void) => Promise<InstallOutcome>;
    /** How the launch check launches. Injectable, so a test never opens a browser. */
    launch?: ProbeDeps['launch'];
    /** How an app name or bundle id is found on this Mac. Defaults to Spotlight. Injectable for tests. */
    resolveApp?: AppResolver;
  } = {}) { this.#extension = options.extensionBridge; this.#manager = this.#create(); }
  /**
   * The gateway hands its WebSocket endpoint over once it exists.
   *
   * Late rather than through the constructor because `hostBrowser` is a
   * singleton per data dir and the module that reads its manifest builds it
   * before the gateway has a server to attach a socket to. Only the composition
   * root calls this, and only before `enable`.
   */
  useExtension(bridge: () => ExtensionBridge): void { this.#extension = bridge; }
  #create(): BrowserManager {
    if (this.options.manager) return this.options.manager(this.#settings);
    if (this.#settings.mode === 'extension') {
      // Never silently fall back to another browser: with no endpoint wired,
      // the mode the owner chose simply says it is not connected.
      const offline: ExtensionBridge = { connected: () => false, send: () => Promise.reject(new Error(NOT_CONNECTED)), close: () => {} };
      return new BrowserManager(() => new ExtensionDriver(this.#extension?.() ?? offline, this.options.allowedHosts), { controlFile: path.join(this.dir, 'control.json') });
    }
    if (this.#settings.mode === 'computer') return new BrowserManager(() => new ComputerDriver(this.#settings, this.options.bridge?.(), this.options.allowedHosts,
      (appId) => this.#allowed(appId, this.#acting)), {
      controlFile: path.join(this.dir, 'control.json'), maxSessions: 1, allowOpen: true,
    });
    const host = new PlaywrightHost({ profileDir: path.join(this.dir, 'profile'), channel: this.options.channel, allowedHosts: this.options.allowedHosts, ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      headless: this.#headless, detect: () => this.#detect(), report: (problem) => { this.#problem = problem; } });
    return new BrowserManager(() => new PlaywrightDriver(host.options, host), { controlFile: path.join(this.dir, 'control.json'), closeHost: () => host.close() });
  }
  get #headless(): boolean { return needsHeadless(this.options.platform ?? process.platform, this.options.env ?? process.env); }
  #detect(): BrowserAvailability { return (this.options.detect ?? detectBrowser)(); }
  /** The agents' own browser, said for the owner and the model alike. */
  #engine(): BrowserEngineStatus {
    const found = this.#detect();
    const headless = this.#headless;
    const problem = found.engine === 'none' ? undefined : this.#problem;
    const message = found.engine === 'none' ? NO_BROWSER_STATUS
      : problem === 'missing-libraries' ? missingLibrariesMessage()
      : problem === 'no-sandbox' ? noSandboxMessage()
      : headless ? HEADLESS_NOTE : undefined;
    return { engine: found.engine, headless, ...(problem ? { problem } : {}), ...(message ? { message } : {}), ...(this.#install ? { install: { ...this.#install } } : {}) };
  }
  /**
   * Playwright's Chromium, downloaded where `PLAYWRIGHT_BROWSERS_PATH` points (the data directory's `browser/engines` in a packaged install). Started here and
   * followed through the status: an install takes a minute or more, far
   * longer than a request should wait.
   */
  installBrowser(): BrowserStatus {
    if (this.#install?.state === 'running') return this.status();
    // The installer's lines are read into numbers here and go no further: the
    // page draws a bar and says it in buddi's words, never the installer's.
    const reader = new InstallProgressReader();
    const install: NonNullable<BrowserEngineStatus['install']> = { state: 'running', progress: reader.progress };
    this.#install = install;
    const run = this.options.installer ?? ((onLine) => installBrowser({ onLine }));
    void run((line) => { install.progress = reader.read(line); }).then((outcome) => {
      install.state = outcome.ok ? 'done' : 'failed';
      install.progress = reader.finish(outcome.ok);
      install.line = outcome.ok ? 'Chromium is installed.' : outcome.detail.slice(0, 300);
      if (outcome.missingLibraries && (this.options.platform ?? process.platform) === 'linux') this.#problem = 'missing-libraries';
      else if (outcome.ok) this.#problem = undefined;
    }, (error: unknown) => {
      install.state = 'failed';
      install.progress = reader.finish(false);
      install.line = error instanceof Error ? error.message : String(error);
    });
    return this.status();
  }
  /**
   * Launch the agents' browser once and close it, headed or headless as this
   * machine dictates. Only the agents' own browser has a binary to start; the
   * other modes answer ok, since there is nothing of buddi's to launch.
   * A missing-libraries or no-sandbox failure is remembered as the status's problem, as a
   * failed launch from a real session would be.
   */
  async checkLaunch(): Promise<LaunchCheck> {
    if (this.#settings.mode !== 'playwright') return { ok: true };
    const check = await probeLaunch({
      headless: this.#headless,
      detect: () => this.#detect(),
      platform: this.options.platform ?? process.platform,
      ...(this.options.launch ? { launch: this.options.launch } : {}),
    });
    if (check.ok) this.#problem = undefined;
    else if (check.problem === 'missing-libraries' || check.problem === 'no-sandbox') this.#problem = check.problem;
    return check;
  }
  get #macOS(): boolean { return (this.options.platform ?? process.platform) === 'darwin'; }
  async enable(): Promise<void> {
    if (this.#enabled) return;
    try {
      const stored = settingsSchema.parse(JSON.parse(await readFile(path.join(this.dir, 'settings.json'), 'utf8')));
      // Computer control is macOS-only: elsewhere a stored choice of it runs, and reads, as the agents' own browser.
      // The file keeps what the owner chose.
      this.#settings = stored.mode === 'computer' && !this.#macOS ? { ...stored, mode: 'playwright' } : stored;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#manager = this.#create(); await this.#manager.enable(); this.#enabled = true;
  }
  status(scope?: BrowserScope): BrowserStatus {
    const status = this.#manager.status(scope);
    const metadata = { mode: this.#settings.mode, settings: { ...this.#settings, allowedApps: [...this.#settings.allowedApps] }, permissions: this.#permissions,
      ...(this.#settings.mode === 'playwright' ? { browser: this.#engine() } : {}) };
    const once = (entry: BrowserStatus): BrowserStatus => {
      const allowed = entry.session ? this.#once.get(entry.session.conversationId) : undefined;
      return allowed?.size && entry.session ? { ...entry, session: { ...entry.session, allowedOnce: [...allowed] } } : entry;
    };
    return once({ ...status, ...metadata, ...(status.sessions ? { sessions: status.sessions.map((session) => once({ ...session, ...metadata })) } : {}) });
  }
  /** On the owner's list, or allowed Once in this conversation. */
  #allowed(appId: string, conversationId: string | undefined): boolean {
    return this.#settings.allowedApps.includes(appId) || (conversationId !== undefined && this.#once.get(conversationId)?.has(appId) === true);
  }
  /** The app an `open` names, as found on this Mac. An allowed bundle id needs no lookup. */
  async #resolve(command: BrowserCommand, conversationId: string | undefined): Promise<InstalledApp> {
    const resolver = this.options.resolveApp ?? spotlightApps;
    if (command.app !== undefined) return resolveApp({ name: command.app }, resolver);
    const appId = command.appId!;
    if (this.#allowed(appId, conversationId)) return { bundleId: appId, name: appId };
    return resolveApp({ bundleId: appId }, resolver);
  }
  /** `#resolve`, with its refusal said as the tool's own sentence. */
  async #resolveOrRefuse(command: BrowserCommand, conversationId: string | undefined): Promise<InstalledApp> {
    try { return await this.#resolve(command, conversationId); }
    catch (error) { throw error instanceof BrowserPreconditionError ? new ToolRefusal(error.message) : error; }
  }
  /**
   * Session for everything but an `open`, in computer mode, of an app the
   * owner has not allowed: that one is gated, so the owner gets a card.
   *
   * Asked once per app and conversation, from core's own ledger: a yes Once
   * lets it through (remembered here, too, for the screen guards), a no is
   * refused without a second card, and a card still waiting is not doubled.
   */
  async tierFor(command: BrowserCommand, ctx: ToolContext): Promise<{ tier: 'session' | 'gated'; reason?: string }> {
    if (command.action !== 'open' || this.#settings.mode !== 'computer') return { tier: 'session' };
    const app = await this.#resolveOrRefuse(command, ctx.conversationId);
    if (this.#allowed(app.bundleId, ctx.conversationId)) return { tier: 'session' };
    const conversationId = ctx.conversationId;
    if (conversationId && UUID.test(conversationId) && ctx.buddi?.approvals.decisionsInConversation) {
      const cards = (await ctx.buddi.approvals.decisionsInConversation('browser.act', conversationId))
        .filter((card) => isAppEnvelope(card.envelope) && card.envelope.allowApp === app.bundleId);
      const last = cards.at(-1);
      if (last?.state === 'rejected') throw new ToolRefusal(`The owner said no to ${app.name} this time.`);
      if (last?.state === 'pending') throw new ToolRefusal(`The owner has not answered the card about ${app.name} yet. Tell them it is waiting, and wait.`);
      if (last && ['approved', 'executing', 'succeeded'].includes(last.state) && (last.choices?.remember ?? 'Once') === 'Once') {
        this.#allowOnce(conversationId, app.bundleId);
        return { tier: 'session' };
      }
    }
    return { tier: 'gated' };
  }
  async describe(command: BrowserCommand, ctx: ToolContext): Promise<EffectDescription> {
    // Always looked up, never read from an allowance: the executor describes
    // again before it runs, and the card must say the same both times.
    const app = await this.#resolveOrRefuse(command, undefined);
    const agent = ctx.agentId ?? 'An agent';
    const envelope: AppEnvelope = { tool: 'browser.act', allowApp: app.bundleId, name: app.name };
    return {
      envelope,
      preview: `Use ${app.name} on your computer?\n${agent} wants to open ${app.name} (${app.bundleId}). While it works, buddi sees that window's screen and sends it to the model, as with the apps you allowed already.`,
      choices: [{ ...REMEMBER, options: [...REMEMBER.options] }],
    };
  }
  #allowOnce(conversationId: string, appId: string): void {
    const apps = this.#once.get(conversationId) ?? new Set<string>();
    apps.add(appId); this.#once.set(conversationId, apps);
  }
  /**
   * The owner said yes on the card. Once: this conversation. Always: the
   * owner's list, written the way Settings writes it — without restarting
   * the driver, since the agent's session is usually live. A full list falls
   * back to Once and says so.
   */
  async #grant(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    if (this.#settings.mode !== 'computer') throw new BrowserPreconditionError('Computer control is no longer on, so there is no app to allow. Ask the owner.');
    if (!ctx.conversationId) throw new Error('An app is allowed for a conversation, and this call has none.');
    const app = await this.#resolve(command, undefined);
    let remember = ctx.choices?.remember === 'Always' ? 'Always' : 'Once';
    let note = '';
    if (remember === 'Always' && !this.#settings.allowedApps.includes(app.bundleId)) {
      if (this.#settings.allowedApps.length >= 32) { remember = 'Once'; note = ' The list of apps is full (32), so it is allowed for this conversation only.'; }
      else await this.#writeSettings({ ...this.#settings, allowedApps: [...this.#settings.allowedApps, app.bundleId] });
    }
    if (remember === 'Once') this.#allowOnce(ctx.conversationId, app.bundleId);
    const how = remember === 'Always' ? 'Always: it is now on the list in Settings' : 'Once: for this conversation';
    return {
      allowed: { appId: app.bundleId, name: app.name, remember },
      message: `Allowed ${app.name} (${how}).${note}`,
      forAgent: `The owner allowed ${app.name} (${remember}). Nothing was opened yet: call browser.act {action:"open", appId:"${app.bundleId}"} again to open it.${note}`,
    };
  }
  async #writeSettings(next: ControlSettings): Promise<void> {
    const parsed = settingsSchema.parse(next);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'settings.json'); const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(parsed), { mode: 0o600 }); await rename(temp, file);
    this.#settings = parsed;
  }
  screenshot(sessionId?: string): Buffer | undefined { return this.#manager.screenshot(sessionId); }
  hand(scope?: BrowserScope): BrowserHandOffer {
    if (this.#changing) return { supported: true, message: 'Control settings are changing. Wait before driving.' };
    return this.#manager.hand(scope);
  }
  rollover(input: BrowserRollover): boolean {
    if (this.#changing) throw new Error('Control settings are changing. Wait before continuing.');
    const moved = this.#manager.rollover(input);
    const once = this.#once.get(input.previousConversationId);
    if (moved && once) { this.#once.delete(input.previousConversationId); this.#once.set(input.conversationId, once); }
    return moved;
  }
  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    if (this.#changing) throw new Error('Computer/browser settings are changing. Wait for the owner.');
    for (const [id, record] of this.#requests) if (record.expiresAt <= Date.now()) this.#requests.delete(id);
    if (ctx.ownerRequest) {
      if (this.#requests.get(ctx.ownerRequest.id)?.revoked) throw new Error('Control settings changed. A new owner request is required.');
      this.#requests.set(ctx.ownerRequest.id, { expiresAt: ctx.ownerRequest.expiresAt, revoked: false });
    }
    if (this.#settings.mode !== 'computer' && (command.action === 'open' || command.target?.x !== undefined)) throw new Error('Native apps and coordinate targets require Computer mode. Only the owner can change modes.');
    // The owner's yes on an app card, run by core's executor: record it; the agent opens next.
    if (ctx.actionId !== undefined && command.action === 'open') return this.#grant(command, ctx);
    let run = command;
    if (command.action === 'open') {
      const app = await this.#resolve(command, ctx.conversationId);
      if (!this.#allowed(app.bundleId, ctx.conversationId)) throw new BrowserPreconditionError(`${app.name} is not allowed yet. Ask to open it again so the owner gets a card.`);
      run = { ...command, appId: app.bundleId, app: undefined };
    }
    this.#acting = ctx.conversationId;
    try { return await this.#manager.execute(run, ctx); }
    finally { if (this.#acting === ctx.conversationId) this.#acting = undefined; }
  }
  /**
   * The gates `execute` runs before anything reaches a manager, secret uses
   * included: settings are not changing mid-flight, and a request the owner
   * revoked while changing them is not one a secret can ride.
   */
  #secret(run: (manager: BrowserManager) => Promise<unknown>, ctx: ToolContext): Promise<unknown> {
    if (this.#changing) throw new Error('Computer/browser settings are changing. Wait for the owner.');
    for (const [id, record] of this.#requests) if (record.expiresAt <= Date.now()) this.#requests.delete(id);
    if (ctx.ownerRequest) {
      if (this.#requests.get(ctx.ownerRequest.id)?.revoked) throw new Error('Control settings changed. A new owner request is required.');
      this.#requests.set(ctx.ownerRequest.id, { expiresAt: ctx.ownerRequest.expiresAt, revoked: false });
    }
    return run(this.#manager);
  }
  async secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown> {
    return this.#secret((manager) => manager.secretFill(input, ctx), ctx);
  }
  async secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown> {
    return this.#secret((manager) => manager.secretType(input, ctx), ctx);
  }
  async control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string): Promise<BrowserStatus> {
    if (this.#changing) throw new Error('Wait for the settings change to finish.');
    await this.#manager.control(action, sessionId); return this.status();
  }
  async configure(input: unknown): Promise<BrowserStatus> {
    const next = settingsSchema.parse(input);
    if (next.mode === 'computer' && !this.#macOS) throw new Error('Computer control is macOS-only. Choose another mode.');
    if (!this.#enabled) throw new Error('Host control is unavailable. Start buddi serve.');
    if (this.#changing) throw new Error('Settings are already changing.');
    const current = this.#manager.status();
    if (current.busy || current.sessions?.length) throw new Error('Release all active sessions before changing control settings.');
    this.#changing = true;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, 'settings.json'); const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, file);
      for (const record of this.#requests.values()) record.revoked = true;
      await this.#manager.shutdown(); this.#settings = next; this.#manager = this.#create(); await this.#manager.enable();
      return this.status();
    } finally { this.#changing = false; }
  }
  async checkPermissions(prompt = false): Promise<BrowserStatus> {
    if (this.#changing || this.#manager.status().busy || this.#manager.status().sessions?.length) throw new Error('Release computer/browser sessions before checking permissions.');
    this.#changing = true;
    try {
    if (process.platform !== 'darwin') this.#permissions = { supported: false, accessibility: false, screenRecording: false, message: 'Computer mode requires macOS 14+. Browser automation remains an explicit alternative.' };
    else {
      const bridge = this.options.bridge?.() ?? new NativeComputerBridge();
      const result = await bridge.run({ operation: 'permissions', prompt });
      this.#permissions = { supported: result.supported === true, accessibility: result.accessibility === true, screenRecording: result.screenRecording === true };
    }
    return this.status();
    } finally { this.#changing = false; }
  }
  async shutdown(): Promise<void> { this.#enabled = false; await this.#manager.shutdown(); }
}
