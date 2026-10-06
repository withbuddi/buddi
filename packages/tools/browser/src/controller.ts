import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolRefusal, type EffectDescription, type RegisteredRouteProvider, type RouteTarget, type ToolContext } from '@buddi/core/plugin';
import { BrowserManager, type BrowserManagerOptions } from './manager.js';
import { PlaywrightHost, type DriverOptions, type LaunchProblem } from './host.js';
import type { GuardedLookup } from './proxy.js';
import { PlaywrightDriver } from './driver.js';
import { ExtensionDriver, NOT_CONNECTED, type ExtensionBridge } from './extension.js';
import { modeOf, browserStoppedMessage, type BrowserController, type BrowserEngineStatus, type BrowserHandOffer, type BrowserScope, type BrowserServiceOptions, type BrowserStatus, type BrowserRollover, type BrowserTouch, type BrowserGiveBack, type CardResult, type RouteStatus, type SecretFillInput, type SecretTypeInput } from './service.js';
import { BrowserPreconditionError, type BrowserCommand, type BrowserDriver, type Observation } from './types.js';
import { detectBrowser, HEADLESS_NOTE, installBrowser, InstallProgressReader, missingLibrariesMessage, needsHeadless, noSandboxMessage, NO_BROWSER_STATUS, probeLaunch, type BrowserAvailability, type InstallOutcome, type LaunchCheck, type ProbeDeps } from './availability.js';
import { applySettingsChange, migrateSettings, PIN_VALUES, settingsSchema, type ControlSettings, type RouteKind, type RoutePin } from './settings.js';
import { agoText, cardAnswer, ownerClock, chooseRoute, detectSignedOut, detectWall, ownerCard, RouteProviderDriver, routeNote, siteListed, siteOf, type ChromeLink, type ChromeMiss, type OwnerCard, type RouteChoice, type RouteReason } from './routes.js';
import { BrowserTelemetry, missionMark, readTelemetry, summarize, type TelemetrySummary } from './telemetry.js';
import { canonicalOrigin, fieldBoundTo } from './secrets.js';
import { LoginKeeper } from './logins.js';
import { DownloadStore, type DownloadStoreOptions, type DownloadUsage } from './downloads.js';
import { LOGIN_GONE, LOGIN_NOT_KEPT, type LoginAck, type LoginCheck, type SeenLoginReport } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The one control an app card carries: how long the yes lasts. */
const REMEMBER = { key: 'remember', label: 'Allow', options: ['Once', 'Always'], default: 'Once' };
interface AppEnvelope { tool: 'browser.act'; allowApp: string; name: string }
function isAppEnvelope(value: unknown): value is AppEnvelope {
  return typeof value === 'object' && value !== null && typeof (value as AppEnvelope).allowApp === 'string';
}
/** What the agent is told when an app job has no route: the one fix, never a mode. */
/** What a mission is told when it asks for the owner's Chrome (docs/browser.md, "Missions"). */
export const UNATTENDED_CHROME = "A mission looks only in buddi's own browser, never the owner's Chrome: nobody is there to watch it. Use the own browser, or report what needs the owner's sign-in.";
/** What a mission is told when it asks for an app. */
export const UNATTENDED_APPS = "A mission looks only in buddi's own browser; the owner's apps need the owner. Report what you could not do instead.";
export const APPS_UNAVAILABLE = 'Your apps are not available to agents right now. The owner can turn them on, or repair them, in Settings → Browser & apps.';
/** What the agent is told when no plugin provides the apps route. */
export const APPS_NOT_INSTALLED = 'Agents cannot work in apps here: that needs the Computer plugin (macOS), which the owner installs from Settings → Plugins.';
/** An installed app as the route names it: its id (a bundle id) and its name. */
type InstalledApp = { bundleId: string; name: string };
const asApp = (target: RouteTarget): InstalledApp => ({ bundleId: target.id, name: target.name });

/** The global Stop as it is kept on disk. */
interface StopRecord { at: number; until?: number }

const ROUTES: readonly RouteKind[] = ['own', 'chrome', 'apps'];

/**
 * Where agents may look, and the runtime that picks for them
 * (docs/browser.md).
 *
 * Three routes, one manager each: buddi's own browser (headless, shown in the
 * Canvas), the owner's Chrome (background tabs through the extension) and the
 * owner's apps (a route a plugin provides: the Computer plugin). The
 * settings are permissions; per task the runtime chooses, falls back
 * silently when a route cannot serve, and says one line when the route was
 * not its own browser. The owner is asked on four occasions only, by card.
 */
export class HostController implements BrowserController {
  #settings: ControlSettings = settingsSchema.parse({});
  #enabled = false;
  #extension?: () => ExtensionBridge;
  #providers?: () => readonly RegisteredRouteProvider[];
  #problem?: LaunchProblem;
  #install?: NonNullable<BrowserEngineStatus['install']>;
  #once = new Map<string, Set<string>>();
  /** The apps each conversation was let into (listed or allowed by card), for the Telegram picture check. */
  #opened = new Map<string, Set<string>>();
  #names = new Map<string, string>();
  #managers: Record<RouteKind, BrowserManager>;
  #ownOptions: BrowserManagerOptions;
  #host: PlaywrightHost;
  #stop?: StopRecord;
  #pins = new Map<string, RoutePin>();
  #learned = new Set<string>();
  /** The route each conversation's page is on: `[owner, agent, conversation]`. */
  #current = new Map<string, RouteKind>();
  /** Notes already said, so the chat line comes once per site and route. */
  #noted = new Set<string>();
  /** The last thing the owner's Chrome failed with, by conversation key, so the same failure is not retried a third time. */
  #chromeFailed = new Map<string, string>();
  /** Stop cards shown, by conversation, so a Resume tap is understood. */
  #stopCards = new Map<string, OwnerCard>();
  /** Cards already handed to a surface, so one moment is one card. */
  #asked = new WeakSet<OwnerCard>();
  /** Who hears that the owner gave a page back (the gateway continues the run that waited on it). */
  #giveBack = new Set<(info: BrowserGiveBack) => void>();
  readonly telemetry: BrowserTelemetry;
  /** Sign-ins the owner made on a page they held: asked about, kept or refused here, never by a model. */
  readonly logins: LoginKeeper;
  /** Where agents' downloads land before Files: capped, never executable, swept after thirty days. */
  readonly downloads: DownloadStore;
  #sweeper?: ReturnType<typeof setInterval>;
  constructor(readonly dir: string, readonly options: {
    channel?: 'chrome'; allowedHosts?: readonly string[];
    extensionBridge?: () => ExtensionBridge;
    /** Test seam: a driver per route instead of the real ones. */
    drivers?: Partial<Record<RouteKind, () => BrowserDriver>>;
    lookup?: GuardedLookup;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    detect?: () => BrowserAvailability;
    installer?: (onLine: (line: string) => void) => Promise<InstallOutcome>;
    launch?: ProbeDeps['launch'];
    /** The pin an agent's `agent.md` declares (`browser:`). */
    agentPin?: (agentId: string) => RoutePin | undefined;
    /** Passed to every page: budgets, clock, backoff. Tests shorten them. */
    service?: BrowserServiceOptions;
    /** Pages per route beyond the settings (tests). */
    limits?: Partial<Record<RouteKind, number>>;
    idleEvictMs?: number;
    queueTimeoutMs?: number;
    /** The agents' downloads area; `<data>/downloads` (beside this plugin's `<data>/browser`) by default. */
    downloadsDir?: string;
    /** Caps and retention for it (tests shrink them). */
    downloadLimits?: DownloadStoreOptions;
  } = {}) {
    this.#extension = options.extensionBridge;
    this.logins = new LoginKeeper(path.join(dir, 'logins.json'), options.service?.now ? { now: options.service.now } : {});
    this.telemetry = new BrowserTelemetry(path.join(dir, 'telemetry.jsonl'), options.service?.now);
    this.downloads = new DownloadStore(options.downloadsDir ?? path.join(path.dirname(dir), 'downloads'),
      { ...(options.service?.now ? { now: options.service.now } : {}), ...options.downloadLimits });
    const self = this;
    const hostOptions: DriverOptions = {
      profileDir: path.join(this.dir, 'profile'), channel: this.options.channel, allowedHosts: this.options.allowedHosts,
      ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      detect: () => this.#detect(), report: (problem) => { this.#problem = problem; },
    };
    // Read at launch, so Show the window applies to the next launch without a restart.
    Object.defineProperty(hostOptions, 'headless', { enumerable: true, get: () => self.#headless });
    this.#host = new PlaywrightHost(hostOptions);
    const base: BrowserServiceOptions = { ...options.service, telemetry: this.telemetry, requestTakeover: (sessionId) => { void this.control('takeover', sessionId).catch(() => undefined); },
      requestResume: (sessionId) => { void this.control('resume', sessionId).catch(() => undefined); },
      loginSeen: (sessionId, login) => this.#loginSeen(sessionId, login), downloads: this.downloads };
    this.#ownOptions = { ...base, route: 'own', maxSessions: options.limits?.own ?? this.#settings.maxOwnPages, closeHost: () => this.#host.close(),
      ...(options.idleEvictMs !== undefined ? { idleEvictMs: options.idleEvictMs } : {}), ...(options.queueTimeoutMs !== undefined ? { queueTimeoutMs: options.queueTimeoutMs } : {}) };
    this.#managers = {
      own: new BrowserManager(() => this.options.drivers?.own?.() ?? new PlaywrightDriver(this.#host.options, this.#host), this.#ownOptions),
      chrome: new BrowserManager(() => this.options.drivers?.chrome?.() ?? new ExtensionDriver(this.#bridge(), this.options.allowedHosts, { logins: () => this.#loginFacts() }),
        { ...base, route: 'chrome', siteLocks: true, maxSessions: options.limits?.chrome ?? 8,
          ...(options.idleEvictMs !== undefined ? { idleEvictMs: options.idleEvictMs } : {}), ...(options.queueTimeoutMs !== undefined ? { queueTimeoutMs: options.queueTimeoutMs } : {}) }),
      apps: new BrowserManager(() => this.#appsDriver(), { ...base, route: 'apps', allowOpen: true, maxSessions: options.limits?.apps ?? 1,
        ...(options.idleEvictMs !== undefined ? { idleEvictMs: options.idleEvictMs } : {}), ...(options.queueTimeoutMs !== undefined ? { queueTimeoutMs: options.queueTimeoutMs } : {}) }),
    };
  }
  /**
   * A sign-in on a page the owner holds. Answered in the owner's Chrome
   * already (Save or Never in the tab), or asked about in the Page tab. The
   * password stops at the keeper; whatever goes wrong is dropped without a
   * word, because a word here could carry it.
   */
  #loginSeen(sessionId: string, login: SeenLoginReport): Promise<LoginAck | LoginCheck> | void {
    if (!login.decision) { void this.logins.seen(sessionId, login).catch(() => undefined); return; }
    // The owner's Chrome asks first whether this sign-in is worth a question: the keeper compares the password's mark, and keeps nothing.
    if (login.decision === 'check') return this.logins.check(login).then((ask): LoginCheck => ({ ask }), (): LoginCheck => ({ ask: 'save' }));
    // The owner's Chrome waits to hear what became of a Save: kept, or one plain sentence why not (never the store's words).
    return this.logins.decided(login, login.decision).then(
      (answer): LoginAck => answer.outcome === 'saved' || answer.outcome === 'never' ? { saved: true } : { saved: false, reason: LOGIN_GONE },
      (): LoginAck => ({ saved: false, reason: LOGIN_NOT_KEPT }),
    );
  }
  /** What the owner's Chrome needs to know before it asks: the sites never to ask about, and the logins already kept. */
  #loginFacts(): { never: string[]; saved: Array<{ site: string; username: string }> } {
    return { never: this.logins.never(), saved: this.logins.saved().map(({ site, username }) => ({ site, username })) };
  }
  /** The gateway hands its WebSocket endpoint over once it exists. */
  useExtension(bridge: () => ExtensionBridge): void { this.#extension = bridge; }
  /** The routes plugins provide (core's registry), read on every choice. */
  useRouteProviders(providers: () => readonly RegisteredRouteProvider[]): void { this.#providers = providers; }
  /** The agents' pins from their `agent.md`. */
  useAgentPins(pin: (agentId: string) => RoutePin | undefined): void { this.options.agentPin = pin; }
  #bridge(): ExtensionBridge {
    const offline: ExtensionBridge = { connected: () => false, send: () => Promise.reject(new Error(NOT_CONNECTED)), close: () => {} };
    return this.#extension?.() ?? offline;
  }
  get #env(): NodeJS.ProcessEnv { return this.options.env ?? process.env; }
  /** Headless unless the owner asked to see the window (or BUDDI_BROWSER_HEADED=1); always headless with no display. */
  get #headless(): boolean {
    if (needsHeadless(this.options.platform ?? process.platform, this.#env)) return true;
    return !(this.#settings.showWindow || this.#env.BUDDI_BROWSER_HEADED === '1');
  }
  #detect(): BrowserAvailability { return (this.options.detect ?? detectBrowser)(); }
  #engine(): BrowserEngineStatus {
    const found = this.#detect();
    const headless = this.#headless;
    const problem = found.engine === 'none' ? undefined : this.#problem;
    const forced = needsHeadless(this.options.platform ?? process.platform, this.#env);
    const message = found.engine === 'none' ? NO_BROWSER_STATUS
      : problem === 'missing-libraries' ? missingLibrariesMessage()
      : problem === 'no-sandbox' ? noSandboxMessage()
      : forced ? HEADLESS_NOTE : undefined;
    return { engine: found.engine, headless, ...(problem ? { problem } : {}), ...(message ? { message } : {}), ...(this.#install ? { install: { ...this.#install } } : {}) };
  }

  /* ---------------- the apps route ---------------- */

  /** The plugin that provides the apps route on this platform, when one is installed. */
  #pluginApps(): RegisteredRouteProvider | undefined {
    const platform = this.options.platform ?? process.platform;
    return this.#providers?.().find((provider) => provider.kind === 'apps' && (!provider.platforms || provider.platforms.includes(platform)));
  }
  #appsDriver(): BrowserDriver {
    const test = this.options.drivers?.apps;
    if (test) return test();
    const plugin = this.#pluginApps();
    if (!plugin) throw new BrowserPreconditionError(APPS_NOT_INSTALLED);
    return new RouteProviderDriver(plugin, randomUUID());
  }

  /* ---------------- routes and their health ---------------- */

  #chromeConnected(): boolean { try { return this.#bridge().connected(); } catch { return false; } }
  #chromePaired(): boolean { try { return this.#bridge().paired?.() ?? this.#chromeConnected(); } catch { return false; } }
  /** The owner's Chrome as Settings and the composer's pin see it: not paired with this buddi, paired but closed, or connected. */
  chromeLink(): ChromeLink {
    return this.#chromeConnected() ? 'connected' : this.#chromePaired() ? 'closed' : 'unpaired';
  }
  /** Why the owner's Chrome cannot serve right now, for the one line a fallback says. */
  #chromeMiss(): ChromeMiss | undefined {
    if (!this.#settings.yourChrome) return 'off';
    const link = this.chromeLink();
    return link === 'connected' ? undefined : link;
  }
  routes(): RouteStatus[] {
    const engine = this.#engine();
    const ownOk = engine.engine !== 'none' && !engine.problem;
    const own: RouteStatus = { kind: 'own', allowed: true, available: ownOk || this.options.drivers?.own !== undefined, provider: 'core',
      ...(engine.message ? { message: engine.message } : {}),
      ...(engine.engine === 'none' ? { repair: 'install' as const } : engine.problem === 'no-sandbox' ? { repair: 'sandbox' as const } : engine.problem ? { repair: 'install' as const } : {}) };
    const connected = this.#chromeConnected();
    const paired = this.#chromePaired();
    const chrome: RouteStatus = { kind: 'chrome', allowed: this.#settings.yourChrome, available: this.#settings.yourChrome && connected, provider: 'core', paired, connected,
      link: connected ? 'connected' : paired ? 'closed' : 'unpaired',
      ...(!paired ? { message: 'Add buddi to Chrome and pair it to let agents use your Chrome.', repair: 'pair' as const }
        : !connected ? { message: 'Your Chrome is paired but not connected right now: open Chrome.' } : {}) };
    const plugin = this.#pluginApps();
    let health: { ok: boolean; message?: string; repair?: string };
    if (this.options.drivers?.apps) health = { ok: true };
    else if (plugin) { try { const answered = plugin.health(); health = answered instanceof Promise ? this.#lastPluginHealth : answered; if (answered instanceof Promise) void answered.then((value) => { this.#lastPluginHealth = value; }, () => undefined); } catch (error) { health = { ok: false, message: error instanceof Error ? error.message : String(error) }; } }
    else health = { ok: false, message: APPS_NOT_INSTALLED, repair: 'install' };
    const installed = plugin !== undefined || this.options.drivers?.apps !== undefined;
    const apps: RouteStatus = { kind: 'apps', allowed: installed && this.#settings.yourApps !== 'off', available: installed && this.#settings.yourApps !== 'off' && health.ok,
      provider: plugin?.plugin ?? (this.options.drivers?.apps ? 'test' : ''), installed, mode: this.#settings.yourApps,
      ...(plugin ? { label: plugin.label } : {}),
      ...(health.message ? { message: health.message } : {}), ...(health.repair ? { repair: health.repair as RouteStatus['repair'] } : {}) };
    return [own, chrome, apps];
  }
  #lastPluginHealth: { ok: boolean; message?: string } = { ok: true };
  #usable(): { allowed: Record<RouteKind, boolean>; available: Record<RouteKind, boolean> } {
    const list = this.routes();
    const allowed = Object.fromEntries(list.map((route) => [route.kind, route.allowed])) as Record<RouteKind, boolean>;
    const available = Object.fromEntries(list.map((route) => [route.kind, route.available])) as Record<RouteKind, boolean>;
    return { allowed, available };
  }

  /* ---------------- install and launch ---------------- */

  installBrowser(): BrowserStatus {
    if (this.#install?.state === 'running') return this.status();
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
  /** Launch the agents' own browser once and close it: does it start on this machine? */
  async checkLaunch(): Promise<LaunchCheck> {
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

  /* ---------------- lifecycle and persistence ---------------- */

  async #readJson(name: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path.join(this.dir, name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async #writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, name); const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file);
  }
  async enable(): Promise<void> {
    if (this.#enabled) return;
    void this.logins.load();
    const raw = await this.#readJson('settings.json');
    if (raw !== undefined) {
      const { settings, migrated } = migrateSettings(raw, { paired: this.#chromePaired() });
      this.#settings = settings;
      if (migrated) {
        // The first shape is kept once; a v2 file only loses the apps list the Computer plugin keeps now.
        const v2 = (raw as { version?: unknown } | null)?.version === 2;
        await this.#writeJson(v2 ? 'settings.apps.json' : 'settings.v1.json', raw).catch(() => undefined);
        await this.#writeJson('settings.json', settings);
      }
    }
    this.#ownOptions.maxSessions = this.options.limits?.own ?? this.#settings.maxOwnPages;
    const control = await this.#readJson('control.json') as { stopped?: boolean; at?: number; until?: number | null } | undefined;
    if (control?.stopped) {
      // A Stop from before expiries: it held from when it was written, for the default hour.
      let at = typeof control.at === 'number' ? control.at : undefined;
      if (at === undefined) { try { at = statSync(path.join(this.dir, 'control.json')).mtimeMs; } catch { at = this.#now(); } }
      const until = control.until === null ? undefined : typeof control.until === 'number' ? control.until : at + 60 * 60_000;
      this.#stop = { at, ...(until !== undefined ? { until } : {}) };
    }
    const pins = await this.#readJson('pins.json') as Record<string, string> | undefined;
    for (const [conversation, pin] of Object.entries(pins ?? {})) if ((PIN_VALUES as readonly string[]).includes(pin)) this.#pins.set(conversation, pin as RoutePin);
    const learned = await this.#readJson('sign-in-sites.json') as string[] | undefined;
    for (const site of Array.isArray(learned) ? learned.slice(-500) : []) if (typeof site === 'string') this.#learned.add(site);
    await Promise.all(ROUTES.map((route) => this.#managers[route].enable()));
    // Downloads older than the retention go now and once a day after.
    this.#later(this.downloads.sweep());
    this.#sweeper = setInterval(() => this.#later(this.downloads.sweep()), 24 * 60 * 60 * 1000);
    this.#sweeper.unref?.();
    this.#enabled = true;
  }
  /** What the downloads area holds, for Settings → Browser. */
  downloadUsage(): Promise<DownloadUsage> { return this.downloads.usage(); }
  /** Empty the downloads area (Files keeps its copies). */
  clearDownloads(): Promise<DownloadUsage> { return this.downloads.clear(); }
  #now(): number { return this.options.service?.now?.() ?? Date.now(); }
  /** The global Stop, if it still holds; an expired one is cleared here. */
  #activeStop(): StopRecord | undefined {
    if (this.#stop?.until !== undefined && this.#now() >= this.#stop.until) {
      this.#stop = undefined;
      this.#later(this.#writeJson('control.json', { stopped: false }));
    }
    return this.#stop;
  }

  /* ---------------- status ---------------- */

  #key(ownerId: string, agentId: string, conversationId: string): string { return JSON.stringify([ownerId, agentId, conversationId]); }
  #pageOf(scope: BrowserScope): { route: RouteKind; manager: BrowserManager } | undefined {
    for (const route of ROUTES) {
      const manager = this.#managers[route];
      if (manager.child(scope)) return { route, manager };
    }
    return undefined;
  }
  status(scope?: BrowserScope): BrowserStatus {
    const found = scope ? this.#pageOf(scope) : undefined;
    let status: BrowserStatus;
    if (scope) status = found ? found.manager.status(scope) : { state: this.#enabled ? 'idle' : 'unavailable', enabled: this.#enabled, busy: false, hasScreenshot: false };
    else {
      const sessions = ROUTES.flatMap((route) => this.#managers[route].status().sessions ?? []);
      const latest = sessions.at(-1) ?? { state: this.#enabled ? 'idle' as const : 'unavailable' as const, enabled: this.#enabled, busy: false, hasScreenshot: false };
      status = { ...latest, busy: sessions.some((session) => session.busy), sessions };
    }
    const stop = this.#activeStop();
    if (stop && !status.session) status = { ...status, state: 'stopped' };
    const metadata = {
      settings: { ...this.#settings, signInSites: [...this.#settings.signInSites] },
      // The sites buddi added itself when it met their sign-in page: one list with the owner's in Settings.
      learnedSignInSites: [...this.#learned].filter((site) => !this.#settings.signInSites.includes(site)).sort(),
      browser: this.#engine(), routes: this.routes(), chrome: this.chromeLink(),
      ...(stop ? { stop: { at: new Date(stop.at).toISOString(), ...(stop.until !== undefined ? { until: new Date(stop.until).toISOString() } : {}) } } : {}),
      ...(scope?.conversationId && this.#pins.has(scope.conversationId) ? { pin: this.#pins.get(scope.conversationId)! } : {}),
    };
    const once = (entry: BrowserStatus): BrowserStatus => {
      const allowed = entry.session ? this.#once.get(entry.session.conversationId) : undefined;
      const opened = entry.session ? this.#opened.get(entry.session.conversationId) : undefined;
      const withMode = { ...entry, mode: entry.mode ?? 'playwright' as const };
      if (!withMode.session || (!allowed?.size && !opened?.size)) return withMode;
      return { ...withMode, session: { ...withMode.session, ...(allowed?.size ? { allowedOnce: [...allowed] } : {}), ...(opened?.size ? { allowedApps: [...opened] } : {}) } };
    };
    return once({ ...status, ...metadata, ...(status.sessions ? { sessions: status.sessions.map((session) => once({ ...session, ...metadata })) } : {}) });
  }
  /** `buddi doctor browser`: the last week of stops, cards and routes. */
  telemetrySummary(days = 7): TelemetrySummary {
    const file = this.telemetry.file;
    const events = file && existsSync(file) ? readTelemetry(file) : this.telemetry.events;
    return summarize(events, this.#now(), days);
  }

  /* ---------------- apps: names, cards, Once / Always ---------------- */

  /**
   * May this conversation open the app without a card? `ask` asks every
   * time; `on` opens what the plugin lists. A Once yes counts either way.
   */
  async #allowed(appId: string, conversationId: string | undefined): Promise<boolean> {
    const once = conversationId !== undefined && this.#once.get(conversationId)?.has(appId) === true;
    if (once) return true;
    if (this.#settings.yourApps !== 'on') return false;
    const reach = this.#pluginApps()?.reach;
    if (!reach) return this.options.drivers?.apps !== undefined || this.#pluginApps() !== undefined;
    try { return (await reach.listed(appId)) === true; } catch { return false; }
  }
  #remember(app: InstalledApp): InstalledApp { if (app.name !== app.bundleId) this.#names.set(app.bundleId, app.name); return app; }
  async #resolve(command: BrowserCommand, conversationId: string | undefined): Promise<InstalledApp> {
    const reach = this.#pluginApps()?.reach;
    if (command.app === undefined && await this.#allowed(command.appId!, conversationId)) return { bundleId: command.appId!, name: this.#names.get(command.appId!) ?? command.appId! };
    if (!reach) {
      if (command.app !== undefined) throw new BrowserPreconditionError(`The apps route cannot look up ${command.app} by name. Ask with its id.`);
      return { bundleId: command.appId!, name: command.appId! };
    }
    try {
      return this.#remember(asApp(await reach.resolve(command.app !== undefined ? { name: command.app } : { id: command.appId! })));
    } catch (error) {
      if ((error as { precondition?: boolean }).precondition === true && !(error instanceof BrowserPreconditionError)) throw new BrowserPreconditionError((error as Error).message);
      throw error;
    }
  }
  async #resolveOrRefuse(command: BrowserCommand, conversationId: string | undefined): Promise<InstalledApp> {
    try { return await this.#resolve(command, conversationId); }
    catch (error) { throw error instanceof BrowserPreconditionError ? new ToolRefusal(error.message) : error; }
  }
  /** What the plugin does with an app not on its list: a card, or a refusal. */
  async #unlisted(): Promise<'ask' | 'refuse'> {
    const reach = this.#pluginApps()?.reach;
    if (!reach || this.#settings.yourApps === 'ask') return 'ask';
    try { return (await reach.unlisted()) === 'refuse' ? 'refuse' : 'ask'; } catch { return 'ask'; }
  }
  /** Session for everything but an `open` of an app the owner has not allowed: that one asks with a card. */
  async tierFor(command: BrowserCommand, ctx: ToolContext): Promise<{ tier: 'session' | 'gated'; reason?: string }> {
    if (command.action !== 'open' || this.#settings.yourApps === 'off') return { tier: 'session' };
    // No app card for a mission: nobody is there to answer it, and apps are never its route.
    if (!ctx.ownerRequest) throw new ToolRefusal(UNATTENDED_APPS);
    // No plugin provides apps: no card either; the call itself says what to install.
    if (!this.#pluginApps() && !this.options.drivers?.apps) return { tier: 'session' };
    const app = await this.#resolveOrRefuse(command, ctx.conversationId);
    if (await this.#allowed(app.bundleId, ctx.conversationId)) return { tier: 'session' };
    if (await this.#unlisted() === 'refuse') throw new ToolRefusal(`${app.name} is not on the owner's list of apps, and the owner said not to open others. They can add it in Settings → Computer.`);
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
    const app = await this.#resolveOrRefuse(command, undefined);
    const agent = ctx.agentId ?? 'An agent';
    const envelope: AppEnvelope = { tool: 'browser.act', allowApp: app.bundleId, name: app.name };
    const always = this.#settings.yourApps === 'on' && this.#pluginApps()?.reach?.remember !== undefined;
    return {
      envelope,
      preview: `Use ${app.name} on your computer?\n${agent} wants to open ${app.name} (${app.bundleId}). While it works, buddi sees that window's screen and sends it to the model, as with the apps you allowed already.`,
      choices: [{ ...REMEMBER, options: always ? [...REMEMBER.options] : ['Once'] }],
    };
  }
  #allowOnce(conversationId: string, appId: string): void {
    const apps = this.#once.get(conversationId) ?? new Set<string>();
    apps.add(appId); this.#once.set(conversationId, apps);
  }
  async #grant(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    if (this.#settings.yourApps === 'off' || !this.#pluginApps()) throw new BrowserPreconditionError('Your apps are off, so there is no app to allow. Ask the owner.');
    if (!ctx.conversationId) throw new Error('An app is allowed for a conversation, and this call has none.');
    const app = await this.#resolve(command, undefined);
    let remember = ctx.choices?.remember === 'Always' ? 'Always' : 'Once';
    let note = '';
    const reach = this.#pluginApps()?.reach;
    if (remember === 'Always') {
      let kept = false;
      try { kept = reach?.remember ? await reach.remember({ id: app.bundleId, name: app.name }) : false; } catch { kept = false; }
      if (!kept) { remember = 'Once'; note = ' The list of apps could not take it (it may be full), so it is allowed for this conversation only.'; }
    }
    if (remember === 'Once') this.#allowOnce(ctx.conversationId, app.bundleId);
    const how = remember === 'Always' ? 'Always: it is now on the list in Settings → Computer' : 'Once: for this conversation';
    return {
      allowed: { appId: app.bundleId, name: app.name, remember },
      message: `Allowed ${app.name} (${how}).${note}`,
      forAgent: `The owner allowed ${app.name} (${remember}). Nothing was opened yet: call browser.act {action:"open", appId:"${app.bundleId}"} again to open it.${note}`,
    };
  }
  async #writeSettings(next: ControlSettings): Promise<void> {
    const parsed = settingsSchema.parse(next);
    await this.#writeJson('settings.json', parsed);
    this.#settings = parsed;
    this.#ownOptions.maxSessions = this.options.limits?.own ?? parsed.maxOwnPages;
  }

  /* ---------------- pages ---------------- */

  screenshot(sessionId?: string): Buffer | undefined {
    if (sessionId) return this.#pageOf({ sessionId })?.manager.screenshot(sessionId);
    const latest = this.status().session?.id;
    return latest ? this.#pageOf({ sessionId: latest })?.manager.screenshot(latest) : undefined;
  }
  hand(scope?: BrowserScope): BrowserHandOffer {
    const found = scope ? this.#pageOf(scope) : undefined;
    if (!found) return { supported: true, message: 'That page changed. Refresh before driving it.' };
    return found.manager.hand(scope);
  }
  rollover(input: BrowserRollover): boolean {
    let moved = false;
    for (const route of ROUTES) moved = this.#managers[route].rollover(input) || moved;
    const oldKey = this.#key(input.ownerId, input.agentId, input.previousConversationId);
    const current = this.#current.get(oldKey);
    if (moved && current) { this.#current.delete(oldKey); this.#current.set(this.#key(input.ownerId, input.agentId, input.conversationId), current); }
    const once = this.#once.get(input.previousConversationId);
    if (moved && once) { this.#once.delete(input.previousConversationId); this.#once.set(input.conversationId, once); }
    const opened = this.#opened.get(input.previousConversationId);
    if (moved && opened) { this.#opened.delete(input.previousConversationId); this.#opened.set(input.conversationId, opened); }
    const pin = this.#pins.get(input.previousConversationId);
    if (pin) { this.#pins.set(input.conversationId, pin); this.#later(this.#savePins()); }
    return moved;
  }

  /** The owner's own sign-in list, plus the sites buddi met a login wall on. */
  #signInSite(site: string | undefined): boolean {
    return siteListed(site, this.#settings.signInSites) || siteListed(site, this.#learned);
  }
  #learn(site: string | undefined): void {
    if (!site || this.#learned.has(site)) return;
    this.#learned.add(site);
    this.#later(this.#saveLearned());
  }
  #learnedWrite: Promise<unknown> = Promise.resolve();
  /** One write at a time, each of the list as it is then: a late write never brings back a forgotten site. */
  #saveLearned(): Promise<void> {
    const next = this.#learnedWrite.catch(() => undefined).then(() => this.#writeJson('sign-in-sites.json', [...this.#learned].slice(-500)));
    this.#learnedWrite = next;
    return next;
  }
  async #storedLogin(ctx: ToolContext, url: string | undefined): Promise<boolean> {
    const origin = canonicalOrigin(url);
    if (!origin || !ctx.buddi?.secrets) return false;
    try { return (await ctx.buddi.secrets.list()).some((secret) => fieldBoundTo(secret.bindings, origin)); } catch { return false; }
  }
  #pinFor(ctx: ToolContext): RouteInputPins {
    return {
      conversation: ctx.conversationId ? this.#pins.get(ctx.conversationId) : undefined,
      agent: ctx.agentId ? this.options.agentPin?.(ctx.agentId) : undefined,
      global: this.#settings.defaultRoute,
    };
  }

  /** Hand a card to the surface once, as a question with choices. */
  #ask(ctx: ToolContext, card: OwnerCard): void {
    if (this.#asked.has(card)) return;
    this.#asked.add(card);
    try { ctx.ask?.({ question: card.question, options: card.options.map((option) => ({ label: option.label, ...(option.hint ? { hint: option.hint } : {}), ...(option.recommended ? { recommended: true } : {}) })), allowOther: false }); }
    catch { /* a surface's drawing never decides a run */ }
  }

  /** How long a mission run waits on a card for the owner, in milliseconds (settings `missionWaitMinutes`). */
  missionWaitMs(): number {
    return this.#settings.missionWaitMinutes * 60_000;
  }

  async execute(command: BrowserCommand, ctx: ToolContext): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve.');
    if (!ctx.agentId || !ctx.conversationId || !ctx.buddi) throw new Error('A browser action belongs to an agent and a conversation.');
    const unattended = !ctx.ownerRequest;
    // The owner's Stop: one card with Resume, never a Settings trip.
    const stop = this.#activeStop();
    if (stop && command.action !== 'close') {
      this.telemetry.stop('owner-stop', { route: 'own', agent: ctx.agentId, ...missionMark(ctx), ...(ctx.surface?.id ? { surface: ctx.surface.id } : {}) });
      // The core context carries the owner's zone; the plugin type does not name it.
      const clock = (at: number) => ownerClock(at, (ctx as { timezone?: string }).timezone);
      const wanted = command.action === 'navigate' ? siteOf(command.url) : undefined;
      const card = ownerCard('stopped', { since: clock(stop.at), stoppedAgo: agoText(this.#now() - stop.at), ...(stop.until !== undefined ? { until: clock(stop.until) } : {}), ...(wanted ? { site: wanted } : {}) });
      this.#stopCards.set(ctx.conversationId, card);
      // The owner's own Stop is not a moment to park a mission on: it says so and ends.
      if (!unattended) this.#ask(ctx, card);
      return { completed: false, dispatched: false, needsOwner: card, message: `${browserStoppedMessage(ctx.surface)} Say that in one sentence and stop.` } satisfies Omit<CardResult, 'notice'>;
    }
    // The owner's yes on an app card, run by core's executor: record it; the agent opens next.
    if (ctx.actionId !== undefined && command.action === 'open') return this.#grant(command, ctx);
    if (unattended && command.action === 'open') {
      this.telemetry.stop('apps-unavailable', { route: 'apps', agent: ctx.agentId, ...missionMark(ctx) });
      throw new ToolRefusal(UNATTENDED_APPS);
    }
    const key = this.#key(ctx.buddi.owner.id, ctx.agentId, ctx.conversationId);
    if (command.action === 'close') {
      for (const route of ROUTES) await this.#managers[route].execute(command, ctx);
      this.#current.delete(key);
      return { closed: true };
    }
    if (command.target?.x !== undefined && this.#current.get(key) !== 'apps') {
      throw new BrowserPreconditionError('Coordinates are for an app window. On a web page, use a ref from the page.');
    }
    let run = command;
    let appName: string | undefined;
    if (command.action === 'open') {
      if (!this.#pluginApps() && !this.options.drivers?.apps) {
        this.telemetry.stop('apps-unavailable', { route: 'apps', agent: ctx.agentId });
        throw new Error(APPS_NOT_INSTALLED);
      }
      if (this.#settings.yourApps === 'off') {
        this.telemetry.stop('apps-unavailable', { route: 'apps', agent: ctx.agentId, ...missionMark(ctx) });
        throw new Error(APPS_UNAVAILABLE);
      }
      const app = await this.#resolve(command, ctx.conversationId);
      if (!await this.#allowed(app.bundleId, ctx.conversationId)) throw new BrowserPreconditionError(`${app.name} is not allowed yet. Ask to open it again so the owner gets a card.`);
      run = { ...command, appId: app.bundleId, app: undefined };
      appName = app.name;
      const opened = this.#opened.get(ctx.conversationId) ?? new Set<string>();
      opened.add(app.bundleId); this.#opened.set(ctx.conversationId, opened);
    }
    // A mission browses in buddi's own browser only: asked for the owner's Chrome, it is told so plainly (no pin changes that).
    if (unattended && command.prefer === 'yours') {
      this.telemetry.stop('route-unavailable', { route: 'chrome', agent: ctx.agentId, ...missionMark(ctx) });
      throw new ToolRefusal(UNATTENDED_CHROME);
    }
    let route = this.#current.get(key);
    let choice: RouteChoice = { route, reason: 'continuing' };
    const site = siteOf(command.url);
    if (!route || command.action === 'navigate' || command.action === 'open') {
      const { allowed, available } = this.#usable();
      choice = chooseRoute({ command: run, prefer: command.prefer, pins: this.#pinFor(ctx), allowed, available, signInSite: this.#signInSite(site), unattended });
      // A task already in the owner's Chrome stays there for its next page (a checkout on
      // another domain keeps his sign-in), unless something asked for another route.
      if (route === 'chrome' && command.action === 'navigate' && choice.route === 'own' && choice.reason === 'default' && allowed.chrome && available.chrome) {
        choice = { route: 'chrome', reason: 'continuing' };
      }
      if (!choice.route) {
        this.telemetry.stop('apps-unavailable', { route: 'apps', agent: ctx.agentId, ...missionMark(ctx) });
        throw new Error(unattended ? UNATTENDED_APPS : APPS_UNAVAILABLE);
      }
      if (choice.fallbackFrom) this.telemetry.stop('route-unavailable', { route: choice.route, agent: ctx.agentId, ...missionMark(ctx), ...(site ? { host: site } : {}) });
      if (route && route !== choice.route) await this.#managers[route].release(ctx.conversationId, ctx.agentId);
      if (route !== choice.route) this.telemetry.record({ type: 'browser.route', chosen: choice.route, reason: choice.reason, ...(choice.fallbackFrom ? { fallbackFrom: choice.fallbackFrom } : {}), agent: ctx.agentId, ...missionMark(ctx), ...(site ? { host: site } : {}) });
      route = choice.route;
      this.#current.set(key, route);
    }
    let result: unknown;
    {
      try {
        result = await this.#managers[route].execute(run, ctx);
        if (route === 'chrome') this.#chromeFailed.delete(key);
      }
      catch (error) {
        // The same failure from the owner's Chrome twice running: one plain line, not a third identical try.
        const repeated = route === 'chrome' ? this.#chromeRepeat(key, error, ctx) : undefined;
        if (repeated) return repeated;
        // The owner's Chrome went away: the same page in buddi's own browser, silently.
        if (route !== 'chrome' || !(error instanceof Error) || !error.message.includes(NOT_CONNECTED.slice(0, 30))) throw error;
        this.telemetry.stop('not-connected', { route: 'chrome', agent: ctx.agentId, ...missionMark(ctx), ...(site ? { host: site } : {}) });
        const last = this.#managers.chrome.child({ agentId: ctx.agentId, conversationId: ctx.conversationId })?.lastUrl;
        await this.#managers.chrome.release(ctx.conversationId, ctx.agentId);
        route = 'own';
        this.#current.set(key, route);
        choice = { route, reason: 'chrome-unavailable', fallbackFrom: 'chrome' };
        const url = run.action === 'navigate' ? run.url : last;
        if (!url) throw error;
        result = await this.#managers.own.execute({ action: 'navigate', url } as BrowserCommand, ctx);
      }
      ({ result, route, choice } = await this.#walls(result, route, choice, ctx, unattended));
    }
    return this.#annotate(result, route, choice, ctx, appName);
  }

  /**
   * The owner's Chrome failed: remember how. The second identical failure in
   * a row is answered with one plain line and a stop, rather than letting
   * the agent try the same step a third time and then tell the owner the
   * page never opened. A refusal (stale page, owner looking), a stop and a
   * lost connection are not failures of this kind and are left as they are.
   */
  #chromeRepeat(key: string, error: unknown, ctx: ToolContext): { completed: false; dispatched: false; message: string } | undefined {
    if (!(error instanceof Error) || error instanceof BrowserPreconditionError || error instanceof ToolRefusal || ctx.signal?.aborted) return undefined;
    if (error.message.includes(NOT_CONNECTED.slice(0, 30))) return undefined;
    const said = error.message.trim();
    if (this.#chromeFailed.get(key) !== said) { this.#chromeFailed.set(key, said); return undefined; }
    this.#chromeFailed.delete(key);
    return { completed: false, dispatched: false,
      message: `Your Chrome failed the same way twice: ${said.replace(/\.$/, '')}. Don't try it again; tell the owner that in one sentence.` };
  }

  /**
   * A login wall or a human check on the page just returned. In buddi's own
   * browser a sign-in moves to the owner's Chrome when it is allowed and
   * connected (the site is remembered as one that needs his sign-in); a
   * stored login is pointed at; otherwise one Sign in card. A captcha is a
   * Human check card wherever it appears.
   */
  async #walls(result: unknown, route: RouteKind, choice: RouteChoice, ctx: ToolContext, unattended: boolean): Promise<{ result: unknown; route: RouteKind; choice: RouteChoice }> {
    const observation = (result as { observation?: Observation; needsOwner?: unknown } | undefined);
    if (!observation?.observation || observation.needsOwner) return { result, route, choice };
    const seenSite = siteOf(observation.observation.url);
    // A full login page, or a page that renders signed out where the task needs the owner's account.
    const wall = detectWall(observation.observation)
      ?? (detectSignedOut(observation.observation, { task: ctx.ownerRequest?.text, signInSite: this.#signInSite(seenSite) }) ? 'sign-in' as const : undefined);
    if (!wall) return { result, route, choice };
    const scope = { agentId: ctx.agentId!, conversationId: ctx.conversationId! };
    const child = this.#managers[route].child(scope);
    if (!child) return { result, route, choice };
    const url = observation.observation.url;
    const site = siteOf(url);
    if (wall === 'human') {
      this.telemetry.stop('human-check', { route, agent: ctx.agentId!, ...missionMark(ctx), ...(site ? { host: site } : {}) });
      const card = child.park('human');
      return { result: { ...observation, completed: false, needsOwner: card, message: `${site ?? 'This page'} asks for a human. Say so in one sentence and stop; the card asks the owner to take over.` }, route, choice };
    }
    this.#learn(site);
    const { allowed, available } = this.#usable();
    const chromeUsable = allowed.chrome && available.chrome && !unattended;
    // A pin to another route (the conversation's, the agent's, the default) holds here too:
    // the move to the owner's Chrome is then his choice on the card, never automatic.
    const pins = this.#pinFor(ctx);
    const pin = [pins.conversation, pins.agent, pins.global].find((value) => value !== undefined && value !== 'auto');
    if (route === 'own' && chromeUsable && (pin === undefined || pin === 'chrome')) {
      // The owner is signed in there: the same address, in a background tab of his Chrome.
      await this.#managers.own.release(ctx.conversationId!, ctx.agentId!);
      const key = this.#key(ctx.buddi!.owner.id, ctx.agentId!, ctx.conversationId!);
      this.#current.set(key, 'chrome');
      this.telemetry.record({ type: 'browser.route', chosen: 'chrome', reason: 'sign-in-fallback', fallbackFrom: 'own', agent: ctx.agentId!, ...missionMark(ctx), ...(site ? { host: site } : {}) });
      const moved = await this.#managers.chrome.execute({ action: 'navigate', url } as BrowserCommand, ctx);
      return this.#walls(moved, 'chrome', { route: 'chrome', reason: 'sign-in-fallback', fallbackFrom: 'own' }, ctx, unattended);
    }
    if (await this.#storedLogin(ctx, url)) {
      return { result: { ...observation, message: `${(observation as { message?: string }).message ?? ''} This is a sign-in page and the owner keeps a login for it: secret.list, then secret.fill (a TOTP secret answers a code).`.trim() }, route, choice };
    }
    // A mission's sign-in is one of the four moments too: the card parks the run until the owner answers (Take over, or a saved login).
    this.telemetry.stop('sign-in', { route, agent: ctx.agentId!, ...missionMark(ctx), ...(site ? { host: site } : {}) });
    const card = child.park(wall === 'code' ? 'code' : 'sign-in', { chrome: route === 'chrome' ? 'none' : chromeUsable ? 'usable' : allowed.chrome && !available.chrome ? 'offline' : 'none', storedLogin: false });
    return { result: { ...observation, completed: false, needsOwner: card, message: `${card.title}. Say that in one sentence and stop; the card has Take over. You continue when the owner gives the page back.` }, route, choice };
  }

  #annotate(result: unknown, route: RouteKind, choice: RouteChoice, ctx: ToolContext, appName?: string): unknown {
    if (!result || typeof result !== 'object') return result;
    const value = result as Record<string, unknown> & { observation?: Observation; needsOwner?: OwnerCard };
    const site = siteOf(value.observation?.url) ?? undefined;
    let note: string | undefined;
    const reason: RouteReason = choice.reason;
    if (route !== 'own' || choice.fallbackFrom) {
      const candidate = routeNote(route, reason, site, appName, choice.fallbackFrom === 'chrome' ? this.#chromeMiss() : undefined);
      const said = `${ctx.conversationId}|${route}|${site ?? appName ?? ''}`;
      if (candidate && !this.#noted.has(said) && reason !== 'continuing') { this.#noted.add(said); note = candidate; }
    }
    if (value.needsOwner) this.#ask(ctx, value.needsOwner);
    return { ...value, route, ...(note ? { routeNote: note } : {}) };
  }

  /** The secret tools act on the page the conversation is already on, whichever route it is. */
  async #secretRoute(ctx: ToolContext): Promise<BrowserManager> {
    if (!this.#enabled) throw new Error('Browser driving is available through buddi serve.');
    if (this.#activeStop()) throw new Error(browserStoppedMessage(ctx.surface));
    const found = ctx.agentId && ctx.conversationId ? this.#pageOf({ agentId: ctx.agentId, conversationId: ctx.conversationId }) : undefined;
    return found?.manager ?? this.#managers.own;
  }
  async secretFill(input: SecretFillInput, ctx: ToolContext): Promise<unknown> {
    const manager = await this.#secretRoute(ctx);
    const result = await manager.secretFill(input, ctx);
    const card = (result as { needsOwner?: OwnerCard } | undefined)?.needsOwner;
    if (card) this.#ask(ctx, card);
    return result;
  }
  async secretType(input: SecretTypeInput, ctx: ToolContext): Promise<unknown> {
    const manager = await this.#secretRoute(ctx);
    const result = await manager.secretType(input, ctx);
    const card = (result as { needsOwner?: OwnerCard } | undefined)?.needsOwner;
    if (card) this.#ask(ctx, card);
    return result;
  }

  /**
   * The owner spoke or tapped in a conversation. Every page there gets a
   * fresh budget and its card is answered: Look / Take over hands the page
   * over, Use my Chrome pins the conversation to it, Resume lifts the Stop.
   */
  async touch(input: BrowserTouch): Promise<{ answered?: string }> {
    const text = input.text ?? '';
    let answered: string | undefined;
    const stopCard = this.#stopCards.get(input.conversationId);
    if (stopCard) {
      const answer = cardAnswer(stopCard, text);
      if (answer) this.#stopCards.delete(input.conversationId);
      if (answer === 'resume') { await this.control('resume'); answered = 'resume'; }
    }
    for (const route of ROUTES) {
      for (const { child, card } of this.#managers[route].renew(input.conversationId, input.agentId)) {
        if (!card) continue;
        const answer = cardAnswer(card, text);
        if (answer === 'takeover') {
          const id = child.status().session?.id;
          if (id) { await this.control('takeover', id).catch(() => undefined); answered = 'takeover'; }
        } else if (answer === 'chrome') {
          this.#pins.set(input.conversationId, 'chrome'); this.#later(this.#savePins());
          const session = child.status().session;
          const last = child.lastUrl;
          if (session && route !== 'chrome') {
            await this.#managers[route].release(input.conversationId, session.agentId);
            for (const [key] of this.#current) if (key.endsWith(JSON.stringify(input.conversationId) + ']')) this.#current.delete(key);
            if (last) this.#managers.chrome.remember(session.agentId, input.conversationId, last);
          }
          answered = 'chrome';
        } else if (answer) answered = answer;
      }
    }
    return answered ? { answered } : {};
  }

  /** Writes nobody waits for, finished before shutdown so a closing process loses none. */
  #pending = new Set<Promise<unknown>>();
  #later(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => { this.#pending.delete(tracked); });
    this.#pending.add(tracked);
  }
  async #savePins(): Promise<void> { await this.#writeJson('pins.json', Object.fromEntries(this.#pins)).catch(() => undefined); }
  /** Pin a conversation to a route (`/use browser:chrome`), or clear it with `auto`. */
  async pin(conversationId: string, pin: string): Promise<BrowserStatus> {
    if (!(PIN_VALUES as readonly string[]).includes(pin)) throw new Error(`A pin is one of ${PIN_VALUES.join(', ')}.`);
    if (pin === 'auto') this.#pins.delete(conversationId); else this.#pins.set(conversationId, pin as RoutePin);
    await this.#savePins();
    return this.status({ conversationId });
  }

  async control(action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string, options: { forever?: boolean } = {}): Promise<BrowserStatus> {
    if (!this.#enabled) throw new Error('The host browser service is unavailable.');
    if (!sessionId && action === 'stop') {
      // Stop agents' browsing: every page closes, and it expires (an hour by default) unless "until I say".
      const minutes = options.forever ? 0 : this.#settings.stopExpiryMinutes;
      const at = this.#now();
      this.#stop = { at, ...(minutes > 0 ? { until: at + minutes * 60_000 } : {}) };
      await this.#writeJson('control.json', { stopped: true, at, until: this.#stop.until ?? null });
      await Promise.all(ROUTES.map((route) => this.#managers[route].control('stop')));
      this.#current.clear();
      return this.status();
    }
    if (!sessionId && action === 'resume') {
      this.#stop = undefined;
      this.#stopCards.clear();
      await this.#writeJson('control.json', { stopped: false });
      return this.status();
    }
    if (!sessionId) {
      const pages = ROUTES.flatMap((route) => this.#managers[route].pages());
      if (pages.length === 0 && action === 'release') return this.status();
      throw new Error('Select a page before using this control.');
    }
    const found = this.#pageOf({ sessionId });
    if (!found) throw new Error('That page changed. Refresh before controlling it.');
    if (action === 'takeover') {
      // One page in the owner's hands at a time.
      const held = ROUTES.flatMap((route) => this.#managers[route].pages()).find((page) => page.status().state === 'paused' && page.status().session?.id !== sessionId);
      if (held) throw new Error('You already have a page in your hands. Give it back first.');
    }
    const before = found.manager.status({ sessionId });
    await found.manager.control(action, sessionId);
    // Given back: the run that waited on the owner carries on (a parked mission, a held conversation).
    if (action === 'resume' && before.state === 'paused' && before.session) {
      const info: BrowserGiveBack = { sessionId, agentId: before.session.agentId, conversationId: before.session.conversationId };
      for (const listener of this.#giveBack) { try { listener(info); } catch { /* a listener never fails the give-back */ } }
    }
    // The page asked about, not whichever page changed last.
    return this.status({ sessionId });
  }

  /** Hear every give-back of a page the owner held. Returns the unsubscribe. */
  onGiveBack(listener: (info: BrowserGiveBack) => void): () => void {
    this.#giveBack.add(listener);
    return () => { this.#giveBack.delete(listener); };
  }

  /**
   * Change what agents may use. No lock: a page already open keeps working,
   * and turning a route off closes its pages.
   */
  async configure(input: unknown): Promise<BrowserStatus> {
    if (!this.#enabled) throw new Error('Host control is unavailable. Start buddi serve.');
    // Removing a sign-in site removes it wherever it is kept: the owner's list and the sites buddi learned.
    let change = input;
    if (change && typeof change === 'object' && !Array.isArray(change) && 'forgetSignInSite' in change) {
      const { forgetSignInSite, ...rest } = change as Record<string, unknown>;
      if (typeof forgetSignInSite !== 'string' || forgetSignInSite.trim() === '') throw new Error('forgetSignInSite is a site, like amazon.com.');
      const site = forgetSignInSite.trim().toLowerCase();
      if (this.#learned.delete(site)) await this.#saveLearned();
      const listed = Array.isArray(rest.signInSites) ? rest.signInSites as unknown[] : this.#settings.signInSites;
      change = { ...rest, signInSites: listed.filter((entry) => entry !== site) };
    }
    const next = applySettingsChange(this.#settings, change);
    if (next.yourApps !== 'off' && this.#settings.yourApps === 'off' && !this.#pluginApps() && !this.options.drivers?.apps) throw new Error('Your apps need the Computer plugin. Install it from Settings → Plugins first.');
    const chromeOff = this.#settings.yourChrome && !next.yourChrome;
    const appsOff = this.#settings.yourApps !== 'off' && next.yourApps === 'off';
    await this.#writeSettings(next);
    if (chromeOff) await this.#managers.chrome.control('stop');
    if (appsOff) await this.#managers.apps.control('stop');
    for (const [key, route] of this.#current) if ((chromeOff && route === 'chrome') || (appsOff && route === 'apps')) this.#current.delete(key);
    return this.status();
  }
  async shutdown(): Promise<void> {
    this.#enabled = false;
    if (this.#sweeper) { clearInterval(this.#sweeper); this.#sweeper = undefined; }
    this.logins.clear();
    await Promise.all(ROUTES.map((route) => this.#managers[route].shutdown()));
    await Promise.all([...this.#pending]);
  }
}

type RouteInputPins = { conversation?: RoutePin | undefined; agent?: RoutePin | undefined; global?: RoutePin | undefined };
