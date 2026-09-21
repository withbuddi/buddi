import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkUrl } from '@buddi/tool-web';
import { BrowserPreconditionError, type BrowserCommand, type BrowserDriver, type Observation } from './types.js';

export const browserApps = ['com.google.Chrome', 'com.apple.Safari', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser', 'org.mozilla.firefox'] as const;
/** The browsers that keep several profiles and accept `--profile-directory`. */
export const chromiumApps: readonly string[] = ['com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser'];
export const settingsSchema = z.object({
  mode: z.enum(['computer', 'playwright', 'extension']).default('computer'),
  browserApp: z.enum(browserApps).default('com.google.Chrome'),
  allowedApps: z.array(z.string().min(3).max(200).regex(/^[A-Za-z0-9.-]+$/)).min(1).max(32).default(['com.google.Chrome', 'com.apple.Safari']),
  /** A Chromium profile directory ("Default", "Profile 2"). Absent: whatever window is in front. */
  browserProfile: z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/).optional(),
}).strict().refine((value) => value.allowedApps.includes(value.browserApp), 'The selected browser must also be in allowedApps');
export type ControlSettings = z.infer<typeof settingsSchema>;
export interface ComputerPermissions { supported: boolean; accessibility: boolean; screenRecording: boolean; message?: string }
export interface ComputerBridge {
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancel(): void;
}

/** Do not copy vault/provider/database secrets into the native UI helper. */
export function computerEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

/** One-shot, bounded, fixed native executable. No shell or model-supplied code. */
export class NativeComputerBridge implements ComputerBridge {
  #children = new Set<ChildProcessWithoutNullStreams>();
  constructor(readonly executable = fileURLToPath(new URL('../dist/native/buddi-computer', import.meta.url))) {}
  run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') return Promise.reject(new BrowserPreconditionError('Computer control currently requires macOS 14+. Select Browser automation explicitly to use Playwright on this host.'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { env: computerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.#children.add(child);
      const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error('Computer helper timed out. Input may have partially completed; inspect before retrying.'); child.kill('SIGKILL'); }, input.operation === 'permissions' && input.prompt ? 60_000 : 20_000);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 24 * 1024 * 1024) { failure = new Error('Computer helper response exceeded its limit'); child.kill('SIGKILL'); }
        else chunks.push(chunk);
      });
      child.stderr.resume(); // Never log captured content or input values.
      child.stdin.on('error', () => {});
      child.on('error', (error) => { failure = new Error(`Computer helper unavailable: ${error.message}. Build @buddi/tool-browser on macOS first.`); });
      child.on('close', (code, signal) => {
        clearTimeout(timer); this.#children.delete(child);
        if (failure) { reject(failure); return; }
        if (code !== 0 || signal) { reject(new Error('Computer helper interrupted. Inspect the app before retrying any input.')); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if (typeof result.error === 'string') throw result.dispatched === false ? new BrowserPreconditionError(result.error) : new Error(result.error);
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  cancel(): void { for (const child of this.#children) child.kill('SIGKILL'); }
}

const nodeSchema = z.object({ path: z.array(z.number().int().min(0)), role: z.string(), name: z.string(), value: z.string(), secure: z.boolean(), enabled: z.boolean(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }) });
const snapshotSchema = z.object({ identity: z.string(), title: z.string(), nodes: z.array(nodeSchema).max(500), jpeg: z.string(), width: z.number().positive(), height: z.number().positive(), imageHash: z.string() });
type Snapshot = z.infer<typeof snapshotSchema>;
const roles: Record<string, string> = { AXButton: 'button', AXLink: 'link', AXTextField: 'textbox', AXTextArea: 'textbox', AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXComboBox: 'combobox', AXPopUpButton: 'combobox', AXMenuItem: 'menuitem' };

export class ComputerDriver implements BrowserDriver {
  readonly preservesWindows = true;
  /**
   * No remote hand in computer mode.
   *
   * The native helper acts on accessibility nodes — click this button, fill
   * that field — and has no raw pointer or keystroke primitive to forward a
   * hand to. Streaming the window would therefore give the owner a picture
   * they cannot touch, which is worse than one honest sentence.
   */
  readonly supportsHand = false;
  readonly handMessage = 'Take over at the computer for this mode.';
  #appId?: string;
  #snapshot?: Snapshot;
  #observation?: Observation;
  #picture?: Buffer;
  #generation = 0;
  constructor(readonly settings: ControlSettings, readonly bridge: ComputerBridge = new NativeComputerBridge(), readonly allowedHosts?: readonly string[]) {}
  async start(): Promise<void> {
    const permissions = await this.bridge.run({ operation: 'permissions', prompt: false });
    if (!permissions.accessibility || !permissions.screenRecording) throw new BrowserPreconditionError('Computer control needs macOS Accessibility and Screen Recording permission. Use Check permissions on the Browser / Computer page. No browser debugging fallback was used.');
  }
  #invalidate(): void { this.#snapshot = undefined; this.#observation = undefined; this.#picture = undefined; }
  async perform(command: BrowserCommand): Promise<void> {
    const generation = this.#generation;
    if (command.action === 'close') { await this.close(); return; }
    if (command.action === 'open' || command.action === 'navigate') {
      const appId = command.action === 'navigate' ? this.settings.browserApp : command.appId!;
      if (!this.settings.allowedApps.includes(appId)) throw new BrowserPreconditionError('This app is not owner-allowed. Ask the owner to add its bundle ID in Computer settings.');
      let url: string | undefined;
      if (command.action === 'navigate') {
        const checked = checkUrl(command.url!).url;
        if (this.allowedHosts?.length && !this.allowedHosts.includes(checked.hostname)) throw new BrowserPreconditionError('This website is outside the configured browser hosts.');
        url = checked.href;
      }
      this.#invalidate();
      const profile = command.action === 'navigate' && chromiumApps.includes(appId) ? this.settings.browserProfile : undefined;
      await this.bridge.run({ operation: 'open', appId, ...(profile ? { profile } : {}) });
      if (generation !== this.#generation) throw new Error('Computer action cancelled');
      this.#appId = appId;
      if (url) await this.bridge.run({ operation: 'act', action: 'navigate', appId, url, ...(profile ? { profile } : {}) });
      return;
    }
    if (!this.#appId) throw new BrowserPreconditionError('Open an owner-allowed application or navigate first.');
    if (command.action === 'observe') return;
    if (command.action === 'select' || command.action === 'tab') throw new BrowserPreconditionError('Computer mode has no DOM select or tab IDs. Observe, then click the visible accessibility target for the tab or option.');
    if (!this.#snapshot || command.observation !== this.#observation?.id) throw new BrowserPreconditionError('Stale computer observation. Observe again before acting.');
    const snapshot = this.#snapshot;
    let node: Snapshot['nodes'][number] | undefined;
    if (command.target?.x !== undefined) {
      if (command.action !== 'click' || command.target.y === undefined || command.target.x >= snapshot.width || command.target.y >= snapshot.height) throw new BrowserPreconditionError('Only click accepts coordinates, measured inside the latest screenshot.');
    } else if (command.target) {
      if (command.target.ref) {
        const match = /^ax(\d+)$/.exec(command.target.ref);
        node = match ? snapshot.nodes[Number(match[1])] : undefined;
      } else {
        const matches = snapshot.nodes.filter((n) => n.name === command.target?.name && (command.target.by !== 'role' || (roles[n.role] ?? n.role) === command.target.role));
        if (matches.length === 1) node = matches[0];
      }
      if (!node || node.secure || !node.enabled) throw new BrowserPreconditionError('Target is missing, ambiguous, disabled or secure. Copy an exact accessibility ref from the latest observation.');
    }
    const input = { operation: 'act', appId: this.#appId, action: command.action, identity: snapshot.identity,
      ...(node ? { target: node } : {}), ...(command.target?.x !== undefined ? { x: command.target.x, y: command.target.y, imageHash: snapshot.imageHash } : {}),
      value: command.value, key: command.key, direction: command.direction };
    this.#invalidate(); // Never replay evidence once dispatch may have started.
    await this.bridge.run(input);
  }
  async observe(): Promise<Observation> {
    if (!this.#appId) throw new BrowserPreconditionError('No selected application. Open an allowed app first.');
    const generation = this.#generation;
    const appId = this.#appId;
    const snapshot = snapshotSchema.parse(await this.bridge.run({ operation: 'observe', appId }));
    if (generation !== this.#generation) throw new Error('Computer observation cancelled');
    this.#snapshot = snapshot;
    const targets = snapshot.nodes.flatMap((node, i) => node.secure || !node.enabled ? [] : [{ ref: `ax${i}`, frame: 0, role: roles[node.role] ?? node.role, name: node.name, bounds: node.bounds }]);
    this.#picture = Buffer.from(snapshot.jpeg, 'base64');
    this.#observation = { id: randomUUID(), appId, url: `app://${appId}`, title: snapshot.title,
      tree: targets.map((t) => `${t.ref} ${t.role} ${JSON.stringify(t.name)} ${JSON.stringify(snapshot.nodes[Number(t.ref.slice(2))]?.value ?? '')}`).join('\n').slice(0, 32_000), targets, tabs: [], capturedAt: new Date().toISOString(), screenshotSize: { width: snapshot.width, height: snapshot.height } };
    return this.#observation;
  }
  async screenshot(): Promise<Buffer | undefined> { return this.#picture; }
  async close(): Promise<void> { ++this.#generation; this.bridge.cancel(); this.#invalidate(); /* Never close a user's applications. */ }
  async takeover(): Promise<void> { ++this.#generation; this.bridge.cancel(); this.#invalidate(); }
  resume(): void { this.#invalidate(); }
}
