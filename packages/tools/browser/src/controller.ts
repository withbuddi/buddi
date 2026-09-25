import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@buddi/core/plugin';
import { BrowserManager } from './manager.js';
import { PlaywrightHost, type LaunchProblem } from './host.js';
import type { GuardedLookup } from './proxy.js';
import { PlaywrightDriver } from './driver.js';
import { ComputerDriver, NativeComputerBridge, settingsSchema, type ComputerBridge, type ComputerPermissions, type ControlSettings } from './computer.js';
import { ExtensionDriver, NOT_CONNECTED, type ExtensionBridge } from './extension.js';
import type { BrowserController, BrowserEngineStatus, BrowserHandOffer, BrowserScope, BrowserStatus, BrowserRollover, SecretFillInput, SecretTypeInput } from './service.js';
import type { BrowserCommand } from './types.js';
import { detectBrowser, HEADLESS_NOTE, installBrowser, InstallProgressReader, missingLibrariesMessage, needsHeadless, noSandboxMessage, NO_BROWSER_STATUS, probeLaunch, type BrowserAvailability, type InstallOutcome, type LaunchCheck, type ProbeDeps } from './availability.js';

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
    if (this.#settings.mode === 'computer') return new BrowserManager(() => new ComputerDriver(this.#settings, this.options.bridge?.(), this.options.allowedHosts), {
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
   * Playwright's Chromium, downloaded into its usual cache. Started here and
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
    return { ...status, ...metadata, ...(status.sessions ? { sessions: status.sessions.map((session) => ({ ...session, ...metadata })) } : {}) };
  }
  screenshot(sessionId?: string): Buffer | undefined { return this.#manager.screenshot(sessionId); }
  hand(scope?: BrowserScope): BrowserHandOffer {
    if (this.#changing) return { supported: true, message: 'Control settings are changing. Wait before driving.' };
    return this.#manager.hand(scope);
  }
  rollover(input: BrowserRollover): boolean {
    if (this.#changing) throw new Error('Control settings are changing. Wait before continuing.');
    return this.#manager.rollover(input);
  }
  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    if (this.#changing) throw new Error('Computer/browser settings are changing. Wait for the owner.');
    for (const [id, record] of this.#requests) if (record.expiresAt <= Date.now()) this.#requests.delete(id);
    if (ctx.ownerRequest) {
      if (this.#requests.get(ctx.ownerRequest.id)?.revoked) throw new Error('Control settings changed. A new owner request is required.');
      this.#requests.set(ctx.ownerRequest.id, { expiresAt: ctx.ownerRequest.expiresAt, revoked: false });
    }
    if (this.#settings.mode !== 'computer' && (command.action === 'open' || command.target?.x !== undefined)) throw new Error('Native apps and coordinate targets require Computer mode. Only the owner can change modes.');
    return this.#manager.execute(command, ctx);
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
