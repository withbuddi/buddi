import { randomUUID, createHash } from 'node:crypto';
import type { Page, Locator, ElementHandle } from 'playwright';
import { PlaywrightHost, type DriverOptions, type TabOwner } from './host.js';
import type { BrowserCommand, BrowserDriver, Observation, ObservedTarget } from './types.js';
import { BrowserPreconditionError } from './types.js';
export type { DriverOptions } from './host.js';

/** Trusted driver code, never a model-supplied script. */
function describeElement(el: Element) {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase() ?? '';
  const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
  const labels = 'labels' in el ? Array.from((el as HTMLInputElement).labels ?? []).map((label) => label.textContent).join(' ') : '';
  const name = (el.getAttribute('aria-label') || labelled || labels || el.getAttribute('placeholder') ||
    (tag === 'input' && ['submit', 'button'].includes(type) ? el.getAttribute('value') : '') ||
    (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.textContent) || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const role = el.getAttribute('role') || ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', input: ['checkbox', 'radio'].includes(type) ? type : 'textbox' } as Record<string, string>)[tag] || tag;
  const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;
  const visible = el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
  const form = (el as HTMLInputElement).form;
  return { tag, type, role, name, href, visible, disabled, connected: el.isConnected,
    formAction: form?.action, formMethod: form?.method };
}
type ElementDescription = ReturnType<typeof describeElement>;

export class PlaywrightDriver implements BrowserDriver, TabOwner {
  readonly host: PlaywrightHost;
  #page?: Page;
  #tabs = new Map<string, Page>();
  #evidence?: { id: string; hash: string; url: string };
  #refs = new Map<string, { element: ElementHandle<Element>; description: ElementDescription }>();
  #generation = 0;
  #picture?: Buffer;
  #starting?: Promise<void>;
  constructor(readonly options: DriverOptions, host?: PlaywrightHost) { this.host = host ?? new PlaywrightHost(options); }
  adopt(page: Page): void {
    if ([...this.#tabs.values()].includes(page)) return;
    this.#tabs.set(`tab-${randomUUID().slice(0, 12)}`, page);
    page.on('close', () => {
      for (const [id, tab] of this.#tabs) if (tab === page) this.#tabs.delete(id);
      if (this.#page === page) { this.#page = [...this.#tabs.values()][0]; this.#invalidate(); }
    });
  }
  async start(): Promise<void> {
    if (this.#page && !this.#page.isClosed()) return;
    if (this.#starting) return this.#starting;
    const generation = this.#generation;
    const pending = this.host.open(this, () => generation === this.#generation).then((page) => {
      if (generation !== this.#generation) throw new Error('Browser launch cancelled.');
      this.#page = page;
    });
    this.#starting = pending;
    try { await pending; } finally { if (this.#starting === pending) this.#starting = undefined; }
  }
  #active(): Page {
    if (!this.#page || this.#page.isClosed()) throw new Error('The browser tab is closed. Navigate to open a new session.');
    return this.#page;
  }
  #invalidate(): void {
    this.#evidence = undefined;
    for (const { element } of this.#refs.values()) void element.dispose().catch(() => {});
    this.#refs.clear();
  }
  async #tree(page: Page): Promise<string> {
    const parts: string[] = [];
    for (const [index, frame] of page.frames().slice(0, 11).entries()) {
      const text = await frame.locator('body').ariaSnapshot({ timeout: 3_000 }).catch(() => '[frame not readable]');
      parts.push(`Frame ${index} (${frame.url()}):\n${text.slice(0, index === 0 ? 20_000 : 3_000)}`);
    }
    return parts.join('\n\n').slice(0, 32_000);
  }
  #hash(page: Page, tree: string): string { return createHash('sha256').update(page.url()).update(tree).digest('hex'); }
  async #targets(page: Page): Promise<ObservedTarget[]> {
    const targets: ObservedTarget[] = [];
    for (const [frameIndex, frame] of page.frames().slice(0, 11).entries()) {
      const candidates = frame.locator('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]');
      const ordered = await candidates.evaluateAll((elements) => elements.map((element, index) => ({ index, main: !!element.closest('main,[role="main"]'), visible: element.getClientRects().length > 0 })).filter((item) => item.visible).sort((a, b) => Number(b.main) - Number(a.main))).catch(() => []);
      for (const { index } of ordered.slice(0, 240 - targets.length)) {
        const element = await candidates.nth(index).elementHandle().catch(() => null);
        if (!element) continue;
        const description = await element.evaluate(describeElement).catch(() => null);
        if (!description?.visible || description.disabled) { await element.dispose(); continue; }
        const ref = `e${targets.length + 1}`;
        this.#refs.set(ref, { element, description });
        targets.push({ ref, frame: frameIndex, role: description.role, name: description.name,
          ...(description.href ? { href: description.href.slice(0, 2048) } : {}) });
      }
      if (targets.length >= 240) break;
    }
    return targets;
  }
  #target(page: Page, target: NonNullable<BrowserCommand['target']>): Locator {
    const frame = page.frames()[target.frame];
    if (!frame) throw new BrowserPreconditionError('Frame no longer exists.');
    switch (target.by) {
      case 'label': return frame.getByLabel(target.name!, { exact: true });
      case 'placeholder': return frame.getByPlaceholder(target.name!, { exact: true });
      case 'text': return frame.getByText(target.name!, { exact: true });
      case 'role': return frame.getByRole(target.role!, { name: target.name!, exact: true });
      case 'link': return frame.getByRole('link', { name: target.name!, exact: true });
    }
  }
  async perform(command: BrowserCommand): Promise<void> {
    if (command.action === 'open' || command.target?.x !== undefined) throw new BrowserPreconditionError('Native apps and coordinate targets require Computer mode.');
    if (command.action === 'close') { await this.close(); return; }
    const page = this.#active();
    if (command.action === 'navigate') {
      this.host.check(command.url!, true); this.#invalidate();
      await page.goto(command.url!, { waitUntil: 'domcontentloaded' });
      this.host.check(page.url(), true); await this.host.foreground(this, page); return;
    }
    if (command.action === 'observe') return;
    if (command.action === 'tab') {
      const tab = this.#tabs.get(command.tabId!);
      if (!tab || tab.isClosed()) throw new BrowserPreconditionError('No such tab in this conversation.');
      this.host.check(tab.url(), true); this.#page = tab; this.#invalidate();
      await this.host.foreground(this, tab); return;
    }
    this.host.check(page.url(), true);
    if (!this.#evidence || command.observation !== this.#evidence.id || page.url() !== this.#evidence.url) throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.');
    let locator: Locator | ElementHandle<Element> | undefined;
    if (command.target?.ref) {
      const saved = this.#refs.get(command.target.ref);
      const current = await saved?.element.evaluate(describeElement).catch(() => null);
      if (!saved || !current || JSON.stringify(current) !== JSON.stringify(saved.description)) throw new BrowserPreconditionError('The referenced element changed or disappeared.');
      locator = saved.element;
    } else {
      if (this.#hash(page, await this.#tree(page)) !== this.#evidence.hash) throw new BrowserPreconditionError('Stale page observation. Prefer a ref from the fresh targets list.');
      if (command.target) {
        const semantic = this.#target(page, command.target);
        const count = await semantic.count();
        if (count !== 1) throw new BrowserPreconditionError(`Target is missing or ambiguous (${count} matches). Choose a specific ref from observation.targets instead of repeating the same label.`);
        locator = semantic;
      }
    }
    if (command.action === 'fill' && (await locator?.getAttribute('type'))?.toLowerCase() === 'password') throw new BrowserPreconditionError('Use human takeover to enter passwords on the host, not chat.');
    this.#evidence = undefined; // Only consume when dispatching, not on a precondition refusal.
    if (command.action === 'scroll') { await page.mouse.wheel(0, command.direction === 'up' ? -600 : 600); return; }
    switch (command.action) {
      case 'click': await locator!.click(); break;
      case 'fill': await locator!.fill(command.value!); break;
      case 'select': await locator!.selectOption({ label: command.value! }); break;
      case 'press': await locator!.press(command.key!); break;
    }
  }
  async observe(): Promise<Observation> {
    const page = this.#active();
    if (page.url() !== 'about:blank') this.host.check(page.url(), true);
    this.#invalidate();
    const tree = await this.#tree(page);
    const targets = await this.#targets(page);
    const id = randomUUID(); this.#evidence = { id, hash: this.#hash(page, tree), url: page.url() };
    this.#picture = await page.screenshot({ type: 'jpeg', quality: 65,
      mask: page.frames().map((frame) => frame.locator('input[type=password]')), timeout: 3_000 }).catch(() => undefined);
    return { id, url: page.url(), title: await page.title(), tree, targets,
      tabs: await Promise.all([...this.#tabs].map(async ([id, tab]) => ({ id, url: tab.url(), title: await tab.title().catch(() => '') }))), capturedAt: new Date().toISOString() };
  }
  async screenshot(): Promise<Buffer | undefined> { return this.#picture; }
  async takeover(): Promise<void> { this.#invalidate(); if (this.#page && !this.#page.isClosed()) await this.host.foreground(this, this.#page, true); }
  resume(): void { this.#invalidate(); this.host.resume(this); }
  async close(): Promise<void> {
    ++this.#generation; this.#invalidate(); this.#picture = undefined; this.#page = undefined;
    await this.host.release(this); this.#tabs.clear();
  }
}
