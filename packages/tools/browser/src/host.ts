import { mkdir, chmod } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { checkUrl, DEFAULT_POLICY, type AddressPolicy } from '@buddi/core/plugin';
import { startProxy, type GuardedLookup } from './proxy.js';

export interface DriverOptions {
  profileDir: string;
  /** Test-only. Production is headed. */
  headless?: boolean;
  channel?: 'chrome' | 'chromium';
  policy?: AddressPolicy;
  allowedHosts?: readonly string[];
  /** Core's `guardedLookup`, for the SOCKS guard. Without it Playwright mode does not launch. */
  lookup?: GuardedLookup;
}
export interface TabOwner { adopt(page: Page): void }

/** One profile; page capabilities belong to separate conversations. Unknown
 * manual tabs never silently become an agent's capability. */
export class PlaywrightHost {
  #context?: BrowserContext;
  #proxy?: Awaited<ReturnType<typeof startProxy>>;
  #owners = new Map<Page, TabOwner>();
  #leases = new Set<TabOwner>();
  #tail: Promise<unknown> = Promise.resolve();
  #manual?: TabOwner;
  #manualPage?: Page;
  #generation = 0;
  constructor(readonly options: DriverOptions) {}
  check(raw: string, navigation = false): void {
    const { url } = checkUrl(raw, this.options.policy ?? DEFAULT_POLICY);
    if (navigation && this.options.allowedHosts?.length && !this.options.allowedHosts.includes(url.hostname)) throw new Error(`Site ${url.hostname} is outside the owner's configured browser hosts.`);
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run); this.#tail = next.catch(() => {}); return next;
  }
  async #launch(): Promise<BrowserContext> {
    if (this.#context) return this.#context;
    const generation = this.#generation;
    await this.#proxy?.close();
    await mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
    await chmod(this.options.profileDir, 0o700);
    const proxy = await startProxy({ policy: this.options.policy, lookup: this.options.lookup }); this.#proxy = proxy;
    try {
      const context = await chromium.launchPersistentContext(this.options.profileDir, {
        headless: this.options.headless ?? false,
        ...(this.options.channel === 'chrome' ? { channel: 'chrome' } : {}),
        viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block', chromiumSandbox: true,
        proxy: { server: proxy.url, bypass: '<-loopback>' },
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], timeout: 20_000,
      });
      if (generation !== this.#generation) { await context.close(); throw new Error('Browser launch cancelled.'); }
      this.#context = context;
      context.setDefaultTimeout(8_000); context.setDefaultNavigationTimeout(20_000);
      await context.route('**/*', async (route) => {
        try { this.check(route.request().url(), route.request().isNavigationRequest()); await route.continue(); }
        catch { await route.abort('blockedbyclient').catch(() => {}); }
      });
      context.on('page', (page) => {
        page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
        page.on('download', (download) => { void download.cancel().catch(() => {}); });
        page.on('filechooser', () => {});
        page.on('close', () => this.#owners.delete(page));
        void page.opener().then(async (opener) => {
          if (!opener) return;
          const owner = this.#owners.get(opener);
          if (!owner || !this.#leases.has(owner)) { await page.close().catch(() => {}); return; }
          this.#adopt(owner, page);
        }).catch(() => {});
      });
      context.on('close', () => {
        if (this.#context === context) { this.#context = undefined; this.#owners.clear(); this.#leases.clear(); this.#manual = undefined; this.#manualPage = undefined; }
      });
      const restored = context.pages();
      await context.newPage(); // Keep the context alive while removing restored task tabs.
      for (const old of restored) await old.close();
      return context;
    } catch (error) {
      await this.#close();
      throw new Error(`Could not open the host browser. Install Chromium, ensure a desktop session is available, and close any other Buddi process using this profile. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  #adopt(owner: TabOwner, page: Page): void {
    if (this.#owners.has(page)) return;
    this.#owners.set(page, owner); owner.adopt(page);
  }
  open(owner: TabOwner, stillWanted: () => boolean): Promise<Page> {
    return this.#serial(async () => {
      if (!stillWanted()) throw new Error('Browser launch cancelled.');
      const context = await this.#launch();
      if (!stillWanted()) throw new Error('Browser launch cancelled.');
      this.#leases.add(owner);
      const page = await context.newPage();
      if (!stillWanted()) { this.#leases.delete(owner); await page.close(); throw new Error('Browser launch cancelled.'); }
      this.#adopt(owner, page);
      // A new background task must not take focus from the owner's handoff tab.
      if (this.#manual && this.#manual !== owner) {
        const manualPage = this.#manualPage;
        await manualPage?.bringToFront().catch(() => {});
      }
      if (this.#leases.size === 1) for (const tab of context.pages()) {
        if (tab !== page && !this.#owners.has(tab) && tab.url() === 'about:blank') await tab.close();
      }
      return page;
    });
  }
  release(owner: TabOwner): Promise<void> {
    this.#leases.delete(owner);
    if (this.#manual === owner) { this.#manual = undefined; this.#manualPage = undefined; }
    return this.#serial(async () => {
      const pages = [...this.#owners].filter(([, value]) => value === owner).map(([page]) => page);
      for (const page of pages) this.#owners.delete(page);
      await Promise.all(pages.map((page) => page.close().catch(() => {})));
      if (this.#leases.size === 0) await this.#close();
    });
  }
  async foreground(owner: TabOwner, page: Page, manual = false): Promise<void> {
    if (manual) { this.#manual = owner; this.#manualPage = page; }
    if (!this.#manual || this.#manual === owner) await page.bringToFront();
  }
  resume(owner: TabOwner): void { if (this.#manual === owner) { this.#manual = undefined; this.#manualPage = undefined; } }
  async #close(): Promise<void> {
    ++this.#generation;
    const context = this.#context; this.#context = undefined;
    this.#leases.clear(); this.#owners.clear(); this.#manual = undefined; this.#manualPage = undefined;
    const proxy = this.#proxy; this.#proxy = undefined;
    await proxy?.close(); await context?.close().catch(() => {});
  }
  async close(): Promise<void> { ++this.#generation; return this.#serial(() => this.#close()); }
}
