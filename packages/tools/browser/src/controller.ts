import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@buddi/core';
import { BrowserManager } from './manager.js';
import { PlaywrightHost } from './host.js';
import { PlaywrightDriver } from './driver.js';
import { ComputerDriver, NativeComputerBridge, settingsSchema, type ComputerBridge, type ComputerPermissions, type ControlSettings } from './computer.js';
import type { BrowserController, BrowserScope, BrowserStatus } from './service.js';
import type { BrowserCommand } from './types.js';

/** Owner-only mode switch. No automatic fallback and no model-selected driver. */
export class HostController implements BrowserController {
  #manager: BrowserManager;
  #settings: ControlSettings = settingsSchema.parse({});
  #permissions?: ComputerPermissions;
  #enabled = false;
  #changing = false;
  #requests = new Map<string, { expiresAt: number; revoked: boolean }>();
  constructor(readonly dir: string, readonly options: {
    channel?: 'chrome'; allowedHosts?: readonly string[];
    bridge?: () => ComputerBridge;
    manager?: (settings: ControlSettings) => BrowserManager;
  } = {}) { this.#manager = this.#create(); }
  #create(): BrowserManager {
    if (this.options.manager) return this.options.manager(this.#settings);
    if (this.#settings.mode === 'computer') return new BrowserManager(() => new ComputerDriver(this.#settings, this.options.bridge?.(), this.options.allowedHosts), {
      controlFile: path.join(this.dir, 'control.json'), maxSessions: 1, allowOpen: true,
    });
    const host = new PlaywrightHost({ profileDir: path.join(this.dir, 'profile'), channel: this.options.channel, allowedHosts: this.options.allowedHosts });
    return new BrowserManager(() => new PlaywrightDriver(host.options, host), { controlFile: path.join(this.dir, 'control.json'), closeHost: () => host.close() });
  }
  async enable(): Promise<void> {
    if (this.#enabled) return;
    try { this.#settings = settingsSchema.parse(JSON.parse(await readFile(path.join(this.dir, 'settings.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#manager = this.#create(); await this.#manager.enable(); this.#enabled = true;
  }
  status(scope?: BrowserScope): BrowserStatus {
    const status = this.#manager.status(scope);
    const metadata = { mode: this.#settings.mode, settings: { ...this.#settings, allowedApps: [...this.#settings.allowedApps] }, permissions: this.#permissions };
    return { ...status, ...metadata, ...(status.sessions ? { sessions: status.sessions.map((session) => ({ ...session, ...metadata })) } : {}) };
  }
  screenshot(sessionId?: string): Buffer | undefined { return this.#manager.screenshot(sessionId); }
  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    if (this.#changing) throw new Error('Computer/browser settings are changing. Wait for the owner.');
    for (const [id, record] of this.#requests) if (record.expiresAt <= Date.now()) this.#requests.delete(id);
    if (ctx.ownerRequest) {
      if (this.#requests.get(ctx.ownerRequest.id)?.revoked) throw new Error('Control settings changed. A new owner request is required.');
      this.#requests.set(ctx.ownerRequest.id, { expiresAt: ctx.ownerRequest.expiresAt, revoked: false });
    }
    if (this.#settings.mode === 'playwright' && (command.action === 'open' || command.target?.x !== undefined)) throw new Error('Native apps and coordinate targets require Computer mode. Only the owner can change modes.');
    return this.#manager.execute(command, ctx);
  }
  async control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string): Promise<BrowserStatus> {
    if (this.#changing) throw new Error('Wait for the settings change to finish.');
    await this.#manager.control(action, sessionId); return this.status();
  }
  async configure(input: unknown): Promise<BrowserStatus> {
    const next = settingsSchema.parse(input);
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
