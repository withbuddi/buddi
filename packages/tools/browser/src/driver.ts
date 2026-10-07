import { randomUUID, createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { Page, Locator, ElementHandle, CDPSession, Download } from 'playwright';
import { watchTransfer, type PendingDownload } from './downloads.js';
import { PlaywrightHost, type DriverOptions, type TabOwner } from './host.js';
import { checkSecretOrigin, fieldOrigin } from './secrets.js';
import { LOGIN_BINDING, LOGIN_WORLD, loginWatchSource, readLoginPayload } from './logins.js';
import { HAND_QUALITY, MAX_HAND_COPY, type BrowserCommand, type BrowserDriver, type BrowserHand, type HandFrame, type HandInput, type HandQuality, type Observation, type ObservedTarget, type SeenLoginReport } from './types.js';
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

/**
 * Where Chromium writes a Playwright download: `<artifacts>/<guid>`, with
 * `.crdownload` on it while the transfer runs. Playwright keeps the path on
 * the download's artifact and does not publish it, so this reads it
 * defensively: without it only the timeout and the store's own cap hold.
 */
export function downloadLocalPath(download: Download): string | undefined {
  const local = (download as unknown as { _artifact?: { _initializer?: { absolutePath?: unknown } } })._artifact?._initializer?.absolutePath;
  return typeof local === 'string' && local !== '' ? local : undefined;
}

/** Bytes Chromium holds for a download so far, partial or finished. */
async function bytesSoFar(local: string | undefined): Promise<number | undefined> {
  if (!local) return undefined;
  const sizes = await Promise.all([`${local}.crdownload`, local].map((file) => stat(file).then((info) => info.size, () => 0)));
  return Math.max(...sizes);
}

/** One character the page would have typed, as opposed to a named key. */
function printableKey(key: string): boolean {
  return [...key].length === 1 && key.codePointAt(0)! >= 0x20 && key.codePointAt(0)! !== 0x7f;
}

/** Control, Alt or Meta, as CDP packs them — Shift is part of typing. */
const SHORTCUT_MODIFIERS = 1 | 2 | 4;

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
  #downloads: PendingDownload[] = [];
  /**
   * A file one of this conversation's tabs started: read once it finishes,
   * when the service asks. Watched while it runs, and stopped past the
   * per-file cap or the timeout; Chromium's copy is deleted once the service
   * took it or refused it.
   */
  download(download: Download): void {
    if (this.#downloads.length >= 20) { void download.cancel().catch(() => {}); return; }
    const local = downloadLocalPath(download);
    const outcome = watchTransfer({ done: download.failure(), size: () => bytesSoFar(local), cancel: () => download.cancel() });
    this.#downloads.push({
      filename: download.suggestedFilename(), url: download.url(),
      read: { stream: () => download.createReadStream() },
      failure: () => outcome,
      cancel: () => download.cancel(),
      // A cancelled transfer has no copy left to delete; Playwright says so with an error.
      cleanup: () => download.delete().catch(() => undefined),
    });
  }
  takeDownloads(): PendingDownload[] { return this.#downloads.splice(0); }
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
  async #savedElement(observation: string, ref: string): Promise<{ element: ElementHandle<Element>; description: ElementDescription }> {
    const page = this.#active();
    this.host.check(page.url(), true);
    // The same evidence a click or a fill resolves against: a ref from an
    // observation that is no longer the latest one is a ref to nowhere.
    if (!this.#evidence || observation !== this.#evidence.id || page.url() !== this.#evidence.url) throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.');
    const saved = this.#refs.get(ref);
    const current = await saved?.element.evaluate(describeElement).catch(() => null);
    if (!saved || !current || JSON.stringify(current) !== JSON.stringify(saved.description)) throw new BrowserPreconditionError('The referenced element changed or disappeared.');
    return saved;
  }

  /**
   * The field a secret is aimed at, as the live page reports it.
   *
   * The origin is the frame that holds the element's — an iframe's login form
   * is the iframe's origin, not the page the top bar shows — and the password
   * mark is the page's own type attribute, not the agent's guess about either.
   */
  async secretFieldInfo(observation: string, ref: string): Promise<{ origin: string; password: boolean; name: string; kind?: string }> {
    const { element, description } = await this.#savedElement(observation, ref);
    const frame = await element.ownerFrame();
    const origin = fieldOrigin(frame?.url());
    const kind = description.tag === 'input' ? String(description.type || 'text').toLowerCase() : String(description.tag ?? '').toLowerCase();
    return { origin, password: description.tag === 'input' && description.type === 'password', name: description.name, ...(kind ? { kind } : {}) };
  }

  /**
   * One owner secret into one field, through Playwright's own fill.
   *
   * The re-check first: between `secretFieldInfo` and this call the owner may
   * have approved a card, and the page may have used that time to navigate. The
   * frame's origin is read again, and unless it is still the one the use was
   * delivered for nothing is entered.
   */
  async secretFillField(observation: string, ref: string, value: string, expectedOrigin: string): Promise<void> {
    const { element } = await this.#savedElement(observation, ref);
    const frame = await element.ownerFrame();
    checkSecretOrigin(frame?.url(), expectedOrigin);
    this.#evidence = undefined; // Only consume when dispatching, not on a precondition refusal.
    await element.fill(value);
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
  async capture(): Promise<{ png: Buffer; title: string; url: string }> {
    const page = this.#active();
    const png = await page.screenshot({ type: 'png', mask: page.frames().map((frame) => frame.locator('input[type=password]')), timeout: 10_000 });
    return { png, title: await page.title().catch(() => ''), url: page.url() };
  }
  async takeover(): Promise<void> { this.#invalidate(); if (this.#page && !this.#page.isClosed()) await this.host.foreground(this, this.#page, true); }
  /**
   * Abandon the command in flight without abandoning the tab.
   *
   * Playwright has no cancel, so this stops the two things that keep a page
   * busy: a load that has not finished, which `Page.stopLoading` ends at once
   * rather than at its twenty-second timeout, and the evidence the agent was
   * about to act on, which is void the moment somebody else has the mouse. The
   * action's own promise still rejects on its way out — `BrowserService` has
   * already aborted the controller that decides what that rejection means — but
   * the page, its context and its cookies are all still there for the owner.
   */
  async interrupt(): Promise<void> {
    const page = this.#page;
    if (!page || page.isClosed()) throw new BrowserPreconditionError('The browser tab is closed.');
    this.#invalidate();
    const cdp = await page.context().newCDPSession(page).catch(() => null);
    if (cdp) {
      await cdp.send('Page.stopLoading').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    await this.host.foreground(this, page, true);
  }
  resume(): void { this.#invalidate(); this.host.resume(this); }
  /**
   * The remote hand, over one CDP session on one held page.
   *
   * The screencast is CDP's because Playwright has no streaming capture, and
   * every frame is acked as it leaves: an unacked screencast simply stops
   * after a frame or two. The input side is Playwright's own mouse and
   * keyboard rather than `Input.dispatch*`, which keeps this driver's one
   * notion of where the pointer is.
   */
  readonly supportsHand = true;
  /** A tab that is open is a tab that can be painted; a closed one cannot. */
  handReady(): boolean { return !!this.#page && !this.#page.isClosed(); }
  #cdp?: CDPSession;
  /**
   * The exact page the hand is on.
   *
   * Not `#active()`: that one moves. A popup, or the screencast page closing,
   * would otherwise leave the owner looking at a login form while their next
   * keystroke went to whatever tab took its place — which is how a password
   * ends up typed into a page nobody chose. The hand holds one page, and when
   * that page is gone so is the hand.
   */
  #handPage?: Page;
  #handWatch?: { page: Page; closed: () => void; navigated: (frame: { url(): string }) => void };
  /** What the relay last asked for, so a re-tune restarts on the same page. */
  #handQuality: HandQuality = HAND_QUALITY;
  #handFrames?: (frame: HandFrame) => void;
  readonly hand: BrowserHand = {
    start: async (onFrame: (frame: HandFrame) => void, quality: HandQuality = HAND_QUALITY) => {
      await this.hand.stop();
      this.#handQuality = quality;
      this.#handFrames = onFrame;
      const page = this.#active();
      if (page.url() !== 'about:blank') this.host.check(page.url(), true);
      this.#invalidate();
      const cdp = await page.context().newCDPSession(page);
      this.#cdp = cdp;
      this.#handPage = page;
      const end = (): void => { if (this.#handPage === page) void this.hand.stop().catch(() => {}); };
      const closed = end;
      // A page that navigates somewhere this browser is not allowed to be is
      // not a page the owner may keep driving, whoever sent it there.
      const navigated = (frame: { url(): string }): void => {
        if (frame !== page.mainFrame() || this.#handPage !== page) return;
        try { if (frame.url() !== 'about:blank') this.host.check(frame.url(), true); }
        catch { end(); }
      };
      page.on('close', closed);
      page.on('framenavigated', navigated as never);
      this.#handWatch = { page, closed, navigated };
      cdp.on('Page.screencastFrame', (event: { data: string; sessionId: number; metadata: HandFrame['metadata'] }) => {
        if (this.#cdp !== cdp) return;
        // The ack first, and before anything this frame costs. Chrome paints
        // nothing more until it has one, so every millisecond spent decoding,
        // relaying or queueing before the ack is a millisecond the *next*
        // frame is late by. A send that fails is a CDP session that is gone,
        // which is a hand that is over rather than a picture that stopped.
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => end());
        const { deviceWidth, deviceHeight, pageScaleFactor, offsetTop, scrollOffsetX, scrollOffsetY } = event.metadata;
        this.#handFrames?.({ jpeg: Buffer.from(event.data, 'base64'), metadata: { deviceWidth, deviceHeight, pageScaleFactor, offsetTop, scrollOffsetX, scrollOffsetY, url: page.url() } });
      });
      try {
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: quality.quality, maxWidth: quality.maxWidth, maxHeight: quality.maxHeight, everyNthFrame: 1 });
      } catch (error) { await this.hand.stop(); throw error; }
      await this.#watchLogins(cdp);
    },
    /**
     * The same page, painted smaller.
     *
     * CDP has no way to change a running screencast's bounds, so it is stopped
     * and started again on the session already attached — which keeps the page,
     * the watchers and the frame handler exactly as they were.
     */
    tune: async (quality: HandQuality) => {
      const cdp = this.#cdp;
      if (!cdp || !this.#handPage) return;
      this.#handQuality = quality;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: quality.quality, maxWidth: quality.maxWidth, maxHeight: quality.maxHeight, everyNthFrame: 1 })
        .catch(() => {});
    },
    input: async (event: HandInput) => {
      const page = this.#handPage;
      if (!page || page.isClosed() || !this.#cdp) throw new BrowserPreconditionError('The screen you were driving is gone. Take over again.');
      if (page.url() !== 'about:blank') {
        try { this.host.check(page.url(), true); }
        catch (error) { await this.hand.stop(); throw error; }
      }
      if (event.kind === 'nav') { await this.#handNav(page, event); return; }
      if (event.kind === 'copy') return;
      if (event.kind === 'wheel') { await page.mouse.move(event.x, event.y); await page.mouse.wheel(event.deltaX, event.deltaY); return; }
      if (event.kind === 'mouse') {
        await page.mouse.move(event.x, event.y);
        if (event.type === 'mouseMoved') return;
        const button = event.button === 'none' ? 'left' : event.button;
        const options = { button, clickCount: Math.max(1, event.clickCount) } as const;
        if (event.type === 'mousePressed') await page.mouse.down(options); else await page.mouse.up(options);
        return;
      }
      // A paste: one insertion, however long the owner's clipboard was.
      if (event.kind === 'text') { await page.keyboard.insertText(event.text); return; }
      // A typed character is inserted as text; a named key is pressed as one.
      if (event.type === 'char') { if (event.text) await page.keyboard.insertText(event.text); return; }
      // And a printable key is *only* ever its `char`. `keyboard.down('a')`
      // types an "a" all by itself, so pressing the key and then inserting the
      // character it stands for is how "ame" came out as "aammee". A shortcut
      // still goes down and up — Cmd+A is a key press, not a typed character,
      // and Playwright omits the text once a real modifier is held.
      if (printableKey(event.key) && (event.modifiers & SHORTCUT_MODIFIERS) === 0) return;
      if (event.type === 'keyDown') await page.keyboard.down(event.key); else await page.keyboard.up(event.key);
    },
    copy: async () => {
      const page = this.#handPage;
      if (!page || page.isClosed()) throw new BrowserPreconditionError('The screen you were driving is gone. Take over again.');
      // The main frame first, then any frame the owner may have selected in (a sign-in form in an iframe).
      for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
        const text = await frame.evaluate(selectedTextSource, MAX_HAND_COPY).catch(() => '');
        if (typeof text === 'string' && text !== '') return text.slice(0, MAX_HAND_COPY);
      }
      return '';
    },
    stop: async () => {
      const cdp = this.#cdp;
      const watch = this.#handWatch;
      this.#handFrames = undefined;
      this.#cdp = undefined;
      this.#handPage = undefined;
      this.#handWatch = undefined;
      if (watch) {
        watch.page.off('close', watch.closed);
        watch.page.off('framenavigated', watch.navigated as never);
      }
      if (!cdp) return;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
  #loginSeen?: (login: SeenLoginReport) => void;
  /** A sign-in the owner made while holding the page (docs/browser.md, "Saving a sign-in"). */
  onLoginSeen(listener: (login: SeenLoginReport) => void): void { this.#loginSeen = listener; }
  /**
   * Watch the held page for a sign-in going out, on the hand's own CDP session.
   *
   * The watcher runs in an isolated world: it shares the page's DOM, so it sees
   * the form and the field, and the page's scripts cannot see it or the binding
   * it reports through (the binding is exposed to that world alone). Every new
   * document in the page gets it again; the one already loaded gets it now. When
   * the hand stops its session detaches, and the script and the binding go with
   * it. What the binding carries goes to the listener and nowhere else — not a
   * log line, not an error.
   */
  async #watchLogins(cdp: CDPSession): Promise<void> {
    if (!this.#loginSeen) return;
    cdp.on('Runtime.bindingCalled', (event: { name?: string; payload?: unknown }) => {
      if (this.#cdp !== cdp || event.name !== LOGIN_BINDING) return;
      const login = readLoginPayload(event.payload);
      if (!login) return;
      try { this.#loginSeen?.(login); } catch { /* the keeper decides; a failure there is not the page's */ }
    });
    try {
      await cdp.send('Runtime.enable');
      await cdp.send('Runtime.addBinding', { name: LOGIN_BINDING, executionContextName: LOGIN_WORLD });
      const source = loginWatchSource();
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: LOGIN_WORLD });
      const tree = await cdp.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } } | undefined;
      const frameId = tree?.frameTree?.frame?.id;
      if (!frameId) return;
      const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: LOGIN_WORLD }) as { executionContextId?: number } | undefined;
      if (typeof world?.executionContextId === 'number') await cdp.send('Runtime.evaluate', { expression: source, contextId: world.executionContextId });
    } catch { /* a page that will not take the watch is a page where buddi does not offer to save */ }
  }
  /**
   * The window's buttons on the held page: back, forward, reload, an address.
   *
   * The same page, never a new tab, and the same check an agent's navigate
   * goes through — before for a typed address, after for history (a back
   * button can land anywhere the page has been). A disallowed landing ends
   * the hand, exactly as a link that went there would.
   */
  async #handNav(page: Page, event: Extract<HandInput, { kind: 'nav' }>): Promise<void> {
    const options = { waitUntil: 'commit' as const, timeout: 15_000 };
    if (event.action === 'navigate') {
      if (!event.url) throw new BrowserPreconditionError('Type an address first.');
      this.host.check(event.url, true);
      await page.goto(event.url, options);
    } else if (event.action === 'back') await page.goBack(options);
    else if (event.action === 'forward') await page.goForward(options);
    else await page.reload(options);
    if (page.url() !== 'about:blank') {
      try { this.host.check(page.url(), true); }
      catch (error) { await this.hand.stop(); throw error; }
    }
  }
  async close(): Promise<void> {
    ++this.#generation; this.#invalidate(); this.#picture = undefined; this.#page = undefined;
    // Downloads nobody collected: stopped, and Chromium's copies removed.
    for (const pending of this.#downloads.splice(0)) { void pending.cancel?.().catch(() => {}); void pending.cleanup?.().catch(() => {}); }
    await this.hand.stop();
    await this.host.release(this); this.#tabs.clear();
  }
}

/**
 * Runs in the held page: what the owner has selected there. The document's
 * selection first; a field's selection does not show in it, so then the
 * focused input or textarea's selected part. A password field copies nothing.
 */
export function selectedTextSource(limit: number): string {
  const selection = typeof window.getSelection === 'function' ? String(window.getSelection() ?? '') : '';
  if (selection !== '') return selection.slice(0, limit);
  const active = document.activeElement as (HTMLInputElement | HTMLTextAreaElement | null);
  if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) return '';
  if (active.tagName === 'INPUT' && (active as HTMLInputElement).type === 'password') return '';
  const start = active.selectionStart, end = active.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return '';
  return String(active.value).slice(start, end).slice(0, limit);
}
