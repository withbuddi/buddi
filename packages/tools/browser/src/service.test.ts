import { afterEach, describe, expect, it, vi } from 'vitest';
import { TELEGRAM_SURFACE, ToolRegistry, WEB_SURFACE, createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';
import { browserStoppedMessage, BrowserService, MAX_TARGETING_FAILURES, OWNER_WATCHING_MESSAGE, RETRY_DELAYS_MS, type BrowserServiceOptions } from './service.js';
import { BROWSER_ACT_DESCRIPTION, createBrowserManifest } from './index.js';
import { BrowserPreconditionError, commandSchema, MAILED_CODE, OBSERVE_AGAIN, UNTRUSTED, type BrowserDriver, type Observation } from './types.js';
import { BrowserTelemetry } from './telemetry.js';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });

const observation: Observation = { id: 'o1', url: 'https://example.com/', title: 'Fixture', tree: '- button "Book"', tabs: [], capturedAt: new Date().toISOString() };
const navigate = commandSchema.parse({ action: 'navigate', url: 'https://example.com/' });
const observe = commandSchema.parse({ action: 'observe' });
const click = (observation?: string) => commandSchema.parse({ action: 'click', target: { ref: 'e1' }, ...(observation ? { observation } : {}) });
const contexts = (request = 'request1'): CoreToolContext => hosted({ db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC',
  agentId: 'concierge', conversationId: 'c1', sessionTools: ['browser.act'],
  ownerRequest: { id: request, text: 'Book the appointment', expiresAt: Date.now() + 60_000 } });
function fake(): BrowserDriver {
  return { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), observe: vi.fn(async () => observation),
    screenshot: vi.fn(async () => Buffer.from('image')), close: vi.fn(async () => {}) };
}
const services: BrowserService[] = [];
/** Backoff that does not wait, recording the delays it was asked for. */
function setupOptions(options: BrowserServiceOptions = {}) {
  const slept: number[] = [];
  const telemetry = new BrowserTelemetry();
  return { slept, telemetry, options: { sleep: async (ms: number) => { slept.push(ms); }, telemetry, ...options } };
}
async function setup(options: BrowserServiceOptions = {}) {
  const driver = fake();
  const { slept, telemetry, options: full } = setupOptions(options);
  const service = new BrowserService(driver, full);
  services.push(service);
  await service.enable();
  return { driver, service, ctx: contexts(), slept, telemetry };
}
const causes = (telemetry: BrowserTelemetry) => telemetry.events.filter((event) => event.type === 'browser.stop').map((event) => (event as { cause: string }).cause);
afterEach(async () => { await Promise.all(services.splice(0).map((s) => s.shutdown())); });

describe('the page and its lifecycle', () => {
  it('returns the page after every action, stamped with when it was seen', async () => {
    let now = Date.parse('2026-09-26T12:04:35.250Z');
    const { service, ctx } = await setup({ now: () => now });
    const first = await service.execute(navigate, ctx) as { observation: Observation; message: string; notice: string };
    expect(first.observation.observedAt).toBe('2026-09-26T12:04:35.250Z');
    expect(first.message).toBe('Observed 12:04:35 UTC.');
    expect(first.notice).toBe(UNTRUSTED);
    now += 7_000;
    const second = await service.execute(click(), ctx) as { completed: boolean; observation: Observation };
    expect(second).toMatchObject({ completed: true, observation: { observedAt: '2026-09-26T12:04:42.250Z' } });
  });
  it('fills a missing observation with the latest page, so the agent never copies ids', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    await service.execute(click(), ctx);
    expect(driver.perform).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'click', observation: 'o1' }));
    expect(commandSchema.safeParse({ action: 'click', target: { ref: 'e1' } }).success).toBe(true);
  });
  it('status never launches a browser, and a separate process is unavailable', async () => {
    const driver = fake();
    const service = new BrowserService(driver);
    expect(service.status()).toMatchObject({ state: 'unavailable', enabled: false });
    await expect(service.execute(navigate, contexts())).rejects.toThrow('buddi serve');
    expect(driver.start).not.toHaveBeenCalled();
  });
  it('executes a granted session tool without per-action approval, and core still guards the grant', async () => {
    const { service, ctx } = await setup();
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(service));
    await expect(registry.invoke('browser.act', navigate, ctx)).resolves.toMatchObject({ ok: true });
    expect(service.status()).toMatchObject({ state: 'running', session: { agentId: 'concierge', steps: 1 } });
    await expect(registry.invoke('browser.act', navigate, { ...ctx, sessionTools: [] })).resolves.toMatchObject({ reason: 'session-not-authorized' });
  });
  it('refuses another conversation on the same page without touching the driver', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    for (const other of [{ agentId: 'other' }, { conversationId: 'other' }, { ownerId: 'other' }]) {
      await expect(service.execute(observe, hosted({ ...ctx, ...other }))).rejects.toThrow('Another conversation');
    }
    expect(driver.perform).toHaveBeenCalledTimes(1);
  });
  it('queues a second action behind the first instead of refusing it (busy is gone)', async () => {
    const { service, driver, ctx } = await setup();
    let finish!: () => void;
    vi.mocked(driver.perform).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = service.execute(navigate, ctx);
    await vi.waitFor(() => expect(driver.perform).toHaveBeenCalledTimes(1));
    const second = service.execute(observe, ctx);
    finish();
    await expect(first).resolves.toMatchObject({ completed: true });
    await expect(second).resolves.toMatchObject({ completed: true });
  });
  it('a cancelled run lets the page go without stopping anyone\'s browsing', async () => {
    const { service, driver, ctx } = await setup();
    const controller = new AbortController();
    vi.mocked(driver.perform).mockImplementation(async () => { controller.abort(new Error('cancelled')); });
    await expect(service.execute(navigate, { ...ctx, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(service.status().state).toBe('idle');
    expect(driver.close).toHaveBeenCalled();
  });
  it('keeps the page when the owner takes over mid-action, and offers a hand on it', async () => {
    const driver = fake();
    let release = () => {};
    driver.perform = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    driver.interrupt = vi.fn(async () => {});
    driver.handReady = () => true;
    driver.hand = { start: async () => {}, input: async () => {}, stop: async () => {} };
    const service = new BrowserService(driver);
    services.push(service);
    await service.enable();
    const working = service.execute(navigate, contexts()).catch((error: Error) => error);
    await vi.waitFor(() => expect(service.status().busy).toBe(true));
    await service.control('takeover');
    expect(driver.interrupt).toHaveBeenCalled();
    expect(driver.close).not.toHaveBeenCalled();
    expect(service.status().state).toBe('paused');
    expect(service.hand().hand).toBe(driver.hand);
    release();
    await working;
    expect(service.status().state).toBe('paused');
  });
  it('Give it back while the interrupted action is still settling waits for it, then gives back — never a refusal', async () => {
    const driver = fake();
    let fail: (error: Error) => void = () => {};
    driver.perform = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    // The first interrupt (the take-over) leaves the action hanging; the next one ends it.
    let interrupts = 0;
    driver.interrupt = vi.fn(async () => { if (++interrupts > 1) fail(new Error('aborted')); });
    driver.takeover = vi.fn(async () => {});
    driver.resume = vi.fn();
    (driver as { holdsInPlace?: 'chrome' }).holdsInPlace = 'chrome';
    const service = new BrowserService(driver);
    services.push(service);
    await service.enable();
    const working = service.execute(navigate, contexts()).catch((error: Error) => error);
    await vi.waitFor(() => expect(service.status().busy).toBe(true));
    await service.control('takeover');
    expect(service.status()).toMatchObject({ state: 'paused', busy: true });
    await expect(service.control('resume')).resolves.toMatchObject({ state: 'running', busy: false });
    expect(driver.resume).toHaveBeenCalled();
    expect(interrupts).toBe(2);
    await working;
  });
  it('take-over is the one pause: the agent waits, and giving it back renews the budget and returns the page', async () => {
    const { service, driver, ctx } = await setup({ maxSteps: 3 });
    await service.execute(navigate, ctx);
    await service.execute(observe, ctx);
    await service.control('takeover');
    await expect(service.execute(observe, ctx)).rejects.toThrow('give it back');
    await service.control('resume');
    expect(service.status().session!.steps).toBe(0);
    await expect(service.execute(click('o1'), ctx)).resolves.toMatchObject({ completed: true });
    expect(driver.close).not.toHaveBeenCalled();
  });
  it('your Chrome, live: the Page tab shows the newest frame, Take over offers the hand, and Bring the tab to the front holds it there', async () => {
    const driver = fake();
    let live: Buffer | undefined = Buffer.from('live-frame');
    driver.livePicture = () => live;
    driver.supportsHand = true;
    driver.hand = { start: vi.fn(async () => {}), input: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    driver.takeover = vi.fn(async () => {});
    driver.bringToFront = vi.fn(async () => {});
    driver.resume = vi.fn();
    const service = new BrowserService(driver, { route: 'chrome' });
    services.push(service);
    await service.enable();
    // Nothing open: no picture, live or not.
    expect(service.screenshot()).toBeUndefined();
    await service.execute(navigate, contexts());
    expect(service.status().hasScreenshot).toBe(true);
    expect(service.screenshot()?.toString()).toBe('live-frame');
    live = undefined;
    // The picture stopped (the owner cancelled Chrome's bar): back to the observation's.
    expect(service.screenshot()?.toString()).toBe('image');

    await expect(service.front()).rejects.toThrow('Take over first');
    await service.control('takeover');
    expect(driver.bringToFront).not.toHaveBeenCalled();
    expect(service.status().held).toBeUndefined();
    expect(service.hand().hand).toBe(driver.hand);

    await expect(service.front()).resolves.toMatchObject({ state: 'paused', held: { by: 'owner', where: 'chrome' } });
    expect(driver.bringToFront).toHaveBeenCalledOnce();
    expect(service.hand()).toMatchObject({ supported: false, message: 'The page is in front of you in your Chrome.' });
    // Asked twice, held once.
    await service.front();
    expect(driver.bringToFront).toHaveBeenCalledOnce();
    await expect(service.control('resume')).resolves.toMatchObject({ state: 'running' });
    expect(service.status().held).toBeUndefined();
  });
  it('the bar\'s Take over in the page asks the controller, which decides', async () => {
    const driver = fake();
    let pressed: () => void = () => {};
    driver.onOwnerTakeover = (listener) => { pressed = listener; };
    const requestTakeover = vi.fn();
    const service = new BrowserService(driver, { requestTakeover });
    services.push(service);
    await service.enable();
    await service.execute(navigate, contexts());
    pressed();
    expect(requestTakeover).toHaveBeenCalledWith(service.status().session!.id);
  });
  it('refuses stale canvas controls, including controls queued behind a release', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    const id = service.status().session!.id;
    await expect(service.control('stop', 'another-session')).rejects.toThrow('page changed');
    expect(driver.close).not.toHaveBeenCalled();
    const release = service.control('release', id);
    const staleStop = service.control('stop', id);
    await release;
    await expect(staleStop).rejects.toThrow('page changed');
  });
});

describe('the paths that disappear', () => {
  it('start-with-navigate: an action with no page says what to do, without an error', async () => {
    const { service, telemetry, ctx } = await setup();
    await expect(service.execute(click(), ctx)).resolves.toMatchObject({ completed: false, message: expect.stringContaining('Navigate to the website first') });
    expect(causes(telemetry)).toContain('start-with-navigate');
  });
  it('request-ended: after a close or a new request, the next action re-opens the page where it was', async () => {
    const { service, driver, telemetry, ctx } = await setup();
    await service.execute(navigate, ctx);
    await service.execute(commandSchema.parse({ action: 'close' }), ctx);
    const result = await service.execute(click('o1'), contexts('request2')) as { completed: boolean; dispatched: boolean; observation: Observation; message: string };
    expect(result).toMatchObject({ completed: false, dispatched: false, observation: { url: 'https://example.com/' } });
    expect(result.message).toContain('opened example.com again');
    expect(driver.perform).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'navigate', url: 'https://example.com/' }));
    expect(causes(telemetry)).toContain('request-ended');
  });
  it('a new owner message continues the same page with a fresh budget, and an older request still works', async () => {
    const { service, ctx } = await setup({ maxSteps: 2 });
    await service.execute(navigate, ctx);
    const id = service.status().session!.id;
    await service.execute(observe, contexts('request2'));
    expect(service.status().session).toMatchObject({ id, steps: 1, requestId: 'request2' });
    await expect(service.execute(observe, ctx)).resolves.toMatchObject({ completed: true });
  });
  it('owner-watching: the tab the owner is looking at is not a stop; the agent is told the bar asks them', async () => {
    const { service, driver, telemetry, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValueOnce(new BrowserPreconditionError('You are looking at this tab. buddi waited and asked in the tab; nothing was done.'));
    const error = await service.execute(click(), ctx).catch((e: unknown) => e) as Error;
    expect(JSON.parse(error.message)).toEqual({ error: OWNER_WATCHING_MESSAGE, dispatched: false });
    expect(service.status().state).toBe('running');
    expect(service.card).toBeUndefined();
    await expect(service.execute(click(), ctx)).resolves.toMatchObject({ completed: true });
    expect(causes(telemetry)).toContain('owner-watching');
  });
});

describe('the paths retried inside the tool', () => {
  it('page-not-answered: re-reads at 0.5, 1, 2, 4 and 8 seconds and answers with the page', async () => {
    const { service, driver, slept, telemetry, ctx } = await setup();
    vi.mocked(driver.observe)
      .mockRejectedValueOnce(new Error('The page has not answered yet. observe again.'))
      .mockRejectedValueOnce(new Error('Timeout 8000ms exceeded'))
      .mockRejectedValueOnce(new Error('Timeout 8000ms exceeded'))
      .mockResolvedValue(observation);
    await expect(service.execute(navigate, ctx)).resolves.toMatchObject({ completed: true, observation: { id: 'o1' } });
    expect(slept).toEqual([500, 1_000, 2_000]);
    expect(causes(telemetry)).toEqual(['page-not-answered']);
  });
  it('observation-failures: six reads, then exactly one card (Look?), never a pause', async () => {
    const { service, driver, slept, telemetry, ctx } = await setup();
    vi.mocked(driver.observe).mockRejectedValue(new Error('Timeout 8000ms exceeded'));
    const result = await service.execute(navigate, ctx) as { needsOwner: { kind: string; question: string } };
    expect(driver.observe).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(slept).toEqual([...RETRY_DELAYS_MS]);
    expect(result.needsOwner).toMatchObject({ kind: 'uncertain', title: 'I\u2019m not sure that went through. Look?' });
    expect(service.status().state).toBe('running');
    expect(causes(telemetry)).toEqual(['page-not-answered', 'observation-failures']);
  });
  it.each([
    ['stale-observation', 'Stale page observation. Use the latest observation.id and target ref.'],
    ['redirect', 'This page has changed since that observation. Observe again.'],
    ['stale-ref', 'That ref no longer matches an element on the page.'],
  ])('%s: re-observes and answers with the fresh page, nothing dispatched, no pause', async (cause, sentence) => {
    const { service, driver, telemetry, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValueOnce(new BrowserPreconditionError(sentence));
    vi.mocked(driver.observe).mockResolvedValue({ ...observation, id: 'fresh' });
    const error = await service.execute(click('old'), ctx).catch((e: unknown) => e) as Error;
    const answer = JSON.parse(error.message);
    expect(answer).toMatchObject({ dispatched: false, observation: { id: 'fresh' } });
    expect(answer.message).toContain('The page changed; here it is now.');
    expect(service.status().state).toBe('running');
    expect(causes(telemetry)).toContain(cause);
  });
  it('targeting failures no longer pause at three; at eight the task asks Keep going?', async () => {
    const { service, driver, telemetry, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValue(new BrowserPreconditionError('That ref no longer matches an element on the page.'));
    for (let i = 1; i < MAX_TARGETING_FAILURES; i++) await expect(service.execute(click(), ctx)).rejects.toThrow('dispatched');
    expect(service.status().state).toBe('running');
    await expect(service.execute(click(), ctx)).resolves.toMatchObject({ needsOwner: { kind: 'budget' } });
    expect(causes(telemetry)).toContain('targeting-cap');
  });
  it('screen-gone: a closed tab is opened again at its last address once, silently', async () => {
    const { service, driver, telemetry, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.observe).mockRejectedValueOnce(new Error('Target page, context or browser has been closed')).mockResolvedValue(observation);
    await expect(service.execute(observe, ctx)).resolves.toMatchObject({ completed: true });
    expect(driver.perform).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'navigate', url: 'https://example.com/' }));
    expect(causes(telemetry)).toContain('screen-gone');
  });
  it('an app behind the owner\'s window says open it again, at once, without waiting or counting', async () => {
    const behind = 'Vocito is no longer in front (Google Chrome is). Call open with the same app to bring it forward, then observe again. No input was sent.';
    const { service, driver, slept, ctx } = await setup({ allowOpen: true });
    await service.execute(commandSchema.parse({ action: 'open', appId: 'co.applex.vocito' }), ctx);
    vi.mocked(driver.perform).mockRejectedValueOnce(new BrowserPreconditionError(behind));
    const error = await service.execute(click(), ctx).catch((e: unknown) => e) as Error;
    expect(JSON.parse(error.message)).toMatchObject({ error: behind, dispatched: false, recovery: expect.stringContaining('open with the same app') });
    expect(slept).toEqual([]);
    expect(service.status().state).toBe('running');
  });
});

describe('the four owner cards', () => {
  it('uncertain-input: a click that failed part-way is one card, Look / Carry on; the page stays parked', async () => {
    const { service, driver, telemetry, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValueOnce(new Error('Element detached mid-click'));
    const result = await service.execute(click(), ctx) as { completed: boolean; dispatched: boolean; needsOwner: { kind: string; options: Array<{ label: string }> } };
    expect(result).toMatchObject({ completed: false, dispatched: true, needsOwner: { kind: 'uncertain' } });
    expect(result.needsOwner.options.map((option) => option.label)).toEqual(['Look', 'Carry on']);
    // Parked: the next call answers the same card and does nothing.
    vi.mocked(driver.perform).mockClear();
    await expect(service.execute(click(), ctx)).resolves.toMatchObject({ needsOwner: { kind: 'uncertain' }, dispatched: false });
    expect(driver.perform).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ state: 'running', needsOwner: { kind: 'uncertain' } });
    // The owner's answer (a touch) clears it; the agent carries on.
    expect(service.renew()?.kind).toBe('uncertain');
    await expect(service.execute(observe, ctx)).resolves.toMatchObject({ completed: true });
    expect(causes(telemetry)).toContain('uncertain-input');
  });
  it('budget: 200 actions by default; the ceiling is Keep going?, and an owner touch renews 200 and an hour', async () => {
    const { service, ctx, telemetry } = await setup();
    await service.execute(navigate, ctx);
    expect(service.status().session!.maxSteps).toBe(200);
    const small = await setup({ maxSteps: 2 });
    await small.service.execute(navigate, small.ctx);
    await small.service.execute(observe, small.ctx);
    const result = await small.service.execute(observe, small.ctx) as { needsOwner: { kind: string; question: string; options: Array<{ label: string }> } };
    expect(result.needsOwner).toMatchObject({ kind: 'budget', title: 'Keep going?' });
    expect(result.needsOwner.options.map((option) => option.label)).toEqual(['Keep going', 'Stop here']);
    small.service.renew();
    expect(small.service.status().session!.steps).toBe(0);
    await expect(small.service.execute(observe, small.ctx)).resolves.toMatchObject({ completed: true });
    expect(causes(small.telemetry)).toContain('budget');
    expect(causes(telemetry)).not.toContain('budget');
  });
  it('budget: an hour of wall clock is the other ceiling, renewed by the owner, never a released page', async () => {
    let now = 0;
    const { service, driver, ctx } = await setup({ now: () => now });
    await service.execute(navigate, ctx);
    now += 60 * 60_000 + 1;
    await expect(service.execute(observe, ctx)).resolves.toMatchObject({ needsOwner: { kind: 'budget' } });
    expect(driver.close).not.toHaveBeenCalled();
    service.renew();
    await expect(service.execute(observe, ctx)).resolves.toMatchObject({ completed: true });
  });
  it('a parked page waits at least an hour for the owner before it is let go', async () => {
    vi.useFakeTimers();
    try {
      const driver = fake();
      const service = new BrowserService(driver, { maxSteps: 1, sleep: async () => {} });
      services.push(service);
      await service.enable();
      await service.execute(navigate, contexts());
      await service.execute(observe, contexts());
      expect(service.card?.kind).toBe('budget');
      await vi.advanceTimersByTimeAsync(119 * 60_000);
      expect(service.status().session).toBeDefined();
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
      expect(service.status().session).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('what the model reads', () => {
  it('browser.act is the owner\'s model: look at or act on a page, the route underneath, what to do on a card', () => {
    const act = createBrowserManifest().tools.find((tool) => tool.name === 'browser.act')!;
    expect(act.description).toBe(BROWSER_ACT_DESCRIPTION);
    expect(act.description).toContain('buddi chooses where it opens');
    expect(act.description).toContain('needsOwner');
    expect(act.description).toContain('routeNote');
    expect(act.description).not.toMatch(/browser\.status first|never switch modes|PLAYWRIGHT mode|COMPUTER mode|EXTENSION mode/);
    expect(UNTRUSTED).toContain(OBSERVE_AGAIN);
    expect(act.description).toContain(MAILED_CODE);
    expect(act.description).toContain('downloads');
    expect(act.description).toContain('import tool');
  });
  it('a result with needsOwner leaves the decision with the owner; browser turns do not spend maxTurns', () => {
    const act = createBrowserManifest().tools.find((tool) => tool.name === 'browser.act')!;
    const waits = act.waitsForOwner as (output: unknown) => boolean;
    expect(waits({ needsOwner: { kind: 'budget' } })).toBe(true);
    expect(waits({ completed: true })).toBe(false);
    expect(act.ownBudget).toBe(true);
  });
  it('the Stop sentence names the Resume card, and /browser resume on Telegram', () => {
    expect(browserStoppedMessage(TELEGRAM_SURFACE)).toContain('/browser resume');
    expect(browserStoppedMessage(WEB_SURFACE)).toContain('Tap Resume on the card');
  });
});
