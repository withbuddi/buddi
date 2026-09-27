import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkUrl } from '@buddi/core/plugin';
import { BrowserPreconditionError, type BrowserCommand, type BrowserDriver, type Observation } from './types.js';

export const browserApps = ['com.google.Chrome', 'com.apple.Safari', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser', 'org.mozilla.firefox'] as const;
/** The browsers that keep several profiles and accept `--profile-directory`. */
export const chromiumApps: readonly string[] = ['com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser'];
export const settingsSchema = z.object({
  /** A separate browser by default on every platform; "Use my apps" is an explicit, macOS-only choice. */
  mode: z.enum(['computer', 'playwright', 'extension']).default('playwright'),
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

/** One installed application, as Spotlight names it. */
export interface InstalledApp { bundleId: string; name: string }
/**
 * Find installed applications by display name, by bundle id, or (`near`) the
 * ones whose name is close to a name that matched nothing. Never launches anything.
 */
export type AppQuery = { name: string } | { bundleId: string } | { near: string };
export type AppResolver = (query: AppQuery) => Promise<InstalledApp[]>;

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 4 << 20, env: computerEnvironment() }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

/** Levenshtein distance, bounded by the two strings' lengths. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * A display name close to what was asked, ignoring case: one contains the
 * other (three letters at least), or a small edit distance — two for a name
 * up to eight characters, three above, always less than half of what was asked.
 * The same name is not "close": it matched.
 */
export function isNearName(asked: string, name: string): boolean {
  const a = asked.trim().toLowerCase(); const n = name.trim().toLowerCase().replace(/\.app$/, '');
  if (!a || !n || a === n) return false;
  if (Math.min(a.length, n.length) >= 3 && (n.includes(a) || a.includes(n))) return true;
  const limit = Math.min(Math.max(a.length, n.length) <= 8 ? 2 : 3, Math.floor((a.length - 1) / 2));
  return Math.abs(a.length - n.length) <= limit && editDistance(a, n) <= limit;
}

const appName = (appPath: string) => appPath.replace(/^.*\//, '').replace(/\.app$/i, '');
/** Each bundle's id and display name, through `mdls`. A bundle without an id is left out. */
async function describeApps(paths: string[]): Promise<InstalledApp[]> {
  const found = await Promise.all(paths.map(async (appPath) => {
    try {
      const [id, name] = (await execText('mdls', ['-raw', '-nullMarker', '', '-name', 'kMDItemCFBundleIdentifier', '-name', 'kMDItemDisplayName', appPath])).split('\0');
      return id?.trim() ? [{ bundleId: id.trim(), name: (name ?? '').trim().replace(/\.app$/i, '') || appName(appPath) }] : [];
    } catch { return []; }
  }));
  return found.flat();
}

/**
 * Installed applications through Spotlight: `mdfind` for the bundles, `mdls`
 * for each one's bundle id and display name. Five seconds per call; nothing
 * is opened. A name is matched exactly, ignoring case, with or without `.app`.
 * `near` lists every application bundle once and keeps the few whose file
 * name is close before asking `mdls` about them.
 */
export const spotlightApps: AppResolver = async (query) => {
  if (process.platform !== 'darwin') return [];
  const quoted = (text: string) => text.replace(/[\\'"*?]/g, (c) => `\\${c}`);
  const bundles = "kMDItemContentType == 'com.apple.application-bundle'";
  const filter = 'near' in query ? bundles
    : 'name' in query ? `${bundles} && (kMDItemDisplayName == '${quoted(query.name)}'c || kMDItemDisplayName == '${quoted(query.name)}.app'c)`
    : `${bundles} && kMDItemCFBundleIdentifier == '${quoted(query.bundleId)}'`;
  const bundlePaths = (await execText('mdfind', [filter])).split('\n').map((line) => line.trim()).filter(Boolean);
  const paths = 'near' in query ? bundlePaths.slice(0, 5_000).filter((appPath) => isNearName(query.near, appName(appPath))).slice(0, 10) : bundlePaths.slice(0, 20);
  return describeApps(paths);
};

const unique = (apps: InstalledApp[]) => [...new Map(apps.map((app) => [app.bundleId, app])).values()];
const listed = (apps: InstalledApp[]) => apps.map((app) => `${app.name} (${app.bundleId})`).join(', ');

/**
 * The one application a name or a bundle id stands for, or the refusal.
 * Several copies of the same bundle id are one app. A name that matches
 * nothing gets the close names back, never one picked for the agent.
 */
export async function resolveApp(query: { name: string } | { bundleId: string }, resolver: AppResolver = spotlightApps): Promise<InstalledApp> {
  let found: InstalledApp[];
  try { found = await resolver(query); } catch { found = []; }
  if ('bundleId' in query) found = found.filter((app) => app.bundleId === query.bundleId);
  else found = found.filter((app) => app.name.toLowerCase() === query.name.trim().toLowerCase());
  const apps = unique(found);
  const asked = 'name' in query ? query.name.trim() : query.bundleId;
  if (apps.length === 0 && 'name' in query) {
    let near: InstalledApp[];
    try { near = unique((await resolver({ near: asked })).filter((app) => isNearName(asked, app.name))).slice(0, 5); } catch { near = []; }
    if (near.length === 1) throw new BrowserPreconditionError(`No app called ${asked}. Did you mean ${listed(near)}? Ask again with that name.`);
    if (near.length > 1) throw new BrowserPreconditionError(`No app called ${asked}. Close names: ${listed(near)}. Say which.`);
  }
  if (apps.length === 0) throw new BrowserPreconditionError('name' in query ? `No installed app is called ${asked}.` : `No installed app has the bundle id ${asked}.`);
  if (apps.length > 1) throw new BrowserPreconditionError(`Several apps are called ${asked}: ${listed(apps)}. Say which bundle id.`);
  return apps[0]!;
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
/** The native helper's refusal when the selected app is not the frontmost one (Computer.swift, `state`). */
const NOT_IN_FRONT = /selected app is no longer in front/i;
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
  /**
   * `allows` is the controller's answer for an app: the owner's list, or an
   * app the owner allowed once for the conversation acting now. Without it,
   * the settings' list alone.
   */
  constructor(readonly settings: ControlSettings, readonly bridge: ComputerBridge = new NativeComputerBridge(), readonly allowedHosts?: readonly string[],
    readonly allows: (appId: string) => boolean = (appId) => settings.allowedApps.includes(appId),
    /** An app's display name for the agent's sentences. Absent or unknown: the bundle id. */
    readonly nameOf: (appId: string) => Promise<string | undefined> = async () => undefined) {}
  /**
   * The helper, with its "not in front" refusal said to the agent: the owner's
   * own window came forward (the dashboard, typically), and open brings the
   * app back. Nothing was sent to either app.
   */
  async #run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    try { return await this.bridge.run(input); }
    catch (error) {
      if (!(error instanceof BrowserPreconditionError) || !NOT_IN_FRONT.test(error.message)) throw error;
      const appId = String(input.appId ?? this.#appId ?? '');
      const name = async (id: string) => { try { return (await this.nameOf(id)) || id; } catch { return id; } };
      let front: string | undefined;
      try { const focused = await this.bridge.run({ operation: 'focused' }); front = typeof focused.appId === 'string' && focused.appId.trim() ? focused.appId.trim() : undefined; } catch { front = undefined; }
      const inFront = front && front !== appId ? ` (${await name(front)} is)` : '';
      throw new BrowserPreconditionError(`${await name(appId)} is no longer in front${inFront}. Call open with the same app to bring it forward, then observe again. No input was sent.`);
    }
  }
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
      if (!this.allows(appId)) throw new BrowserPreconditionError('This app is not owner-allowed. Ask the owner to add its bundle ID in Computer settings.');
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
    await this.#run(input);
  }
  async observe(): Promise<Observation> {
    if (!this.#appId) throw new BrowserPreconditionError('No selected application. Open an allowed app first.');
    const generation = this.#generation;
    const appId = this.#appId;
    const snapshot = snapshotSchema.parse(await this.#run({ operation: 'observe', appId }));
    if (generation !== this.#generation) throw new Error('Computer observation cancelled');
    this.#snapshot = snapshot;
    const targets = snapshot.nodes.flatMap((node, i) => node.secure || !node.enabled ? [] : [{ ref: `ax${i}`, frame: 0, role: roles[node.role] ?? node.role, name: node.name, bounds: node.bounds }]);
    this.#picture = Buffer.from(snapshot.jpeg, 'base64');
    this.#observation = { id: randomUUID(), appId, url: `app://${appId}`, title: snapshot.title,
      tree: targets.map((t) => `${t.ref} ${t.role} ${JSON.stringify(t.name)} ${JSON.stringify(snapshot.nodes[Number(t.ref.slice(2))]?.value ?? '')}`).join('\n').slice(0, 32_000), targets, tabs: [], capturedAt: new Date().toISOString(), screenshotSize: { width: snapshot.width, height: snapshot.height } };
    return this.#observation;
  }
  /**
   * The app the owner is using right now, as the helper reports it — never the
   * agent's claim (owner-secrets.md §8). Remembered so the typing goes to the
   * same app the use was delivered for: an app switch in between is refused.
   */
  #focused?: string;
  async focusedBundleId(): Promise<string | undefined> {
    const result = await this.bridge.run({ operation: 'focused' });
    const appId = typeof result.appId === 'string' ? result.appId.trim() : '';
    this.#focused = appId === '' ? undefined : appId;
    return this.#focused;
  }
  /**
   * The owner's secret into the focused field, over the same chunked keyboard
   * write `browser.act`'s fill uses — focus guards included on the helper's
   * side. Unlike that fill there is no observed target here: the field is
   * whatever the owner left focused, which is exactly why every use is a card.
   */
  async nativeType(value: string): Promise<void> {
    const appId = this.#focused;
    if (!appId) throw new BrowserPreconditionError('No focused application was read for this use. Ask which app is in front again, then ask for the secret.');
    const generation = this.#generation;
    this.#invalidate(); // Never replay evidence once dispatch may have started.
    await this.bridge.run({ operation: 'secretType', appId, value });
    if (generation !== this.#generation) throw new Error('Computer action cancelled');
  }
  async screenshot(): Promise<Buffer | undefined> { return this.#picture; }
  async close(): Promise<void> { ++this.#generation; this.bridge.cancel(); this.#invalidate(); /* Never close a user's applications. */ }
  async takeover(): Promise<void> { ++this.#generation; this.bridge.cancel(); this.#invalidate(); }
  resume(): void { this.#invalidate(); }
}
