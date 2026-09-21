/**
 * The remote hand, as the three drivers implement it.
 *
 * Fakes on both sides: a bridge standing in for the owner's Chrome, and a page
 * standing in for Playwright's. What is being checked is the mapping — which
 * command goes out for a click, which CDP call starts and acks a screencast,
 * and that computer mode says so in one sentence rather than pretending.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExtensionDriver, type ExtensionBridge, type ExtensionCommand } from './extension.js';
import { PlaywrightDriver } from './driver.js';
import { ComputerDriver, settingsSchema } from './computer.js';
import { BrowserService } from './service.js';
import type { HandFrame } from './types.js';

function bridge() {
  const sent: ExtensionCommand[] = [];
  let listener: ((frame: HandFrame) => void) | undefined;
  const fake: ExtensionBridge = {
    connected: () => true,
    send: async (command) => { sent.push(command); return {}; },
    close: () => {},
    frames: (_session, onFrame) => { listener = onFrame; return () => { listener = undefined; }; },
  };
  return { fake, sent, push: (frame: HandFrame) => listener?.(frame), listening: () => !!listener };
}

const metadata = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };

describe('the extension driver’s hand', () => {
  it('starts a screencast, relays its frames, and marks input as the owner’s own', async () => {
    const { fake, sent, push, listening } = bridge();
    const driver = new ExtensionDriver(fake);
    const frames: HandFrame[] = [];
    await driver.hand.start((frame) => frames.push(frame));
    expect(sent[0]).toMatchObject({ name: 'screencast.start', session: driver.session, args: { maxWidth: 960, maxHeight: 600, quality: 50, everyNthFrame: 1 } });
    expect(sent[0]!.owner).toBeUndefined();

    push({ jpeg: Buffer.from('a-picture'), metadata });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.metadata.deviceWidth).toBe(1280);

    await driver.hand.input({ kind: 'mouse', type: 'mousePressed', x: 40, y: 12, button: 'left', clickCount: 1, modifiers: 0 });
    // The extension refuses input into a tab the owner is watching; this is
    // the owner, so the flag is what lets their own click through.
    expect(sent[1]).toMatchObject({ name: 'input', owner: true, args: { kind: 'mouse', type: 'mousePressed', x: 40, y: 12 } });

    await driver.hand.stop();
    expect(sent[2]).toMatchObject({ name: 'screencast.stop' });
    expect(listening()).toBe(false);
    push({ jpeg: Buffer.from('too-late'), metadata });
    expect(frames).toHaveLength(1);
  });
});

/** Just enough Playwright to see which CDP calls and gestures come out. */
function fakePage(url = 'https://example.com/') {
  const cdp = {
    sent: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    listeners: new Map<string, (event: unknown) => void>(),
    fail: false,
    on(event: string, handler: (event: unknown) => void) { this.listeners.set(event, handler); },
    send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, ...(params ? { params } : {}) });
      return this.fail ? Promise.reject(new Error('detached')) : Promise.resolve({});
    },
    detach: vi.fn(async () => {}),
  };
  const mouse = { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}), wheel: vi.fn(async () => {}) };
  const keyboard = { down: vi.fn(async () => {}), up: vi.fn(async () => {}), insertText: vi.fn(async () => {}) };
  const events = new Map<string, Set<(value: unknown) => void>>();
  const frame = { url: () => page.here };
  const page = {
    here: url,
    closed: false,
    mainFrame: () => frame,
    url: () => page.here,
    isClosed: () => page.closed,
    mouse, keyboard,
    context: () => ({ newCDPSession: async () => cdp }),
    on(event: string, handler: (value: unknown) => void) { (events.get(event) ?? events.set(event, new Set()).get(event)!).add(handler); },
    off(event: string, handler: (value: unknown) => void) { events.get(event)?.delete(handler); },
    once(event: string, handler: (value: unknown) => void) { page.on(event, handler); },
    emit(event: string, value?: unknown) { for (const handler of [...(events.get(event) ?? [])]) handler(value); },
    /** The page went somewhere else, and said so the way Playwright does. */
    navigate(to: string) { page.here = to; page.emit('framenavigated', frame); },
    close() { page.closed = true; page.emit('close'); },
  };
  return { page, cdp, mouse, keyboard, frame };
}

/** A host that allows one website, the way the real one is configured to. */
function fakeHost(page: unknown, allowed = 'example.com') {
  return {
    open: async () => page,
    check: (url: string) => { if (new URL(url).hostname !== allowed) throw new Error('This website is outside the configured browser hosts.'); },
    foreground: async () => {}, resume: () => {}, release: async () => {},
  } as never;
}

describe('the Playwright driver’s hand', () => {
  it('screencasts over CDP, acks every frame, and drives the real mouse and keyboard', async () => {
    const { page, cdp, mouse, keyboard } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    const frames: HandFrame[] = [];
    await driver.hand.start((frame) => frames.push(frame));
    expect(cdp.sent[0]).toMatchObject({ method: 'Page.startScreencast', params: { format: 'jpeg', quality: 50, maxWidth: 960, maxHeight: 600 } });

    cdp.listeners.get('Page.screencastFrame')!({ data: Buffer.from('jpeg-bytes').toString('base64'), sessionId: 7, metadata: { ...metadata, offsetTop: 12 } });
    expect(frames[0]!.jpeg.toString()).toBe('jpeg-bytes');
    expect(frames[0]!.metadata.offsetTop).toBe(12);
    // An unacked screencast stops after a frame or two, and Chrome paints
    // nothing more until it has one — so the ack goes out before the frame is
    // decoded or relayed, not after.
    expect(cdp.sent[1]).toMatchObject({ method: 'Page.screencastFrameAck', params: { sessionId: 7 } });

    // A link that cannot carry that picture gets a smaller one, on the same
    // session, without losing the frame handler.
    await driver.hand.tune!({ maxWidth: 640, maxHeight: 400, quality: 40 });
    expect(cdp.sent.at(-2)).toMatchObject({ method: 'Page.stopScreencast' });
    expect(cdp.sent.at(-1)).toMatchObject({ method: 'Page.startScreencast', params: { quality: 40, maxWidth: 640 } });
    cdp.listeners.get('Page.screencastFrame')!({ data: Buffer.from('smaller').toString('base64'), sessionId: 8, metadata });
    expect(frames[1]!.jpeg.toString()).toBe('smaller');

    await driver.hand.input({ kind: 'mouse', type: 'mousePressed', x: 30, y: 40, button: 'left', clickCount: 2, modifiers: 0 });
    expect(mouse.move).toHaveBeenCalledWith(30, 40);
    expect(mouse.down).toHaveBeenCalledWith({ button: 'left', clickCount: 2 });
    await driver.hand.input({ kind: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 120 });
    expect(mouse.wheel).toHaveBeenCalledWith(0, 120);
    await driver.hand.input({ kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
    expect(keyboard.insertText).toHaveBeenCalledWith('a');
    await driver.hand.input({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
    expect(keyboard.down).toHaveBeenCalledWith('Enter');

    await driver.hand.stop();
    expect(cdp.sent.at(-1)).toMatchObject({ method: 'Page.stopScreencast' });
    expect(cdp.detach).toHaveBeenCalled();
  });

  it('ends rather than typing into the tab that replaced the one being shown', async () => {
    const { page, keyboard } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    await driver.hand.start(() => {});
    // The login page the owner was looking at closes; the driver falls back to
    // another owned tab for its own work, but the hand must not follow it.
    page.close();
    await Promise.resolve();
    await expect(driver.hand.input({ kind: 'key', type: 'char', key: 'p', code: 'KeyP', text: 'p', modifiers: 0 }))
      .rejects.toThrow(/Take over again/);
    expect(keyboard.insertText).not.toHaveBeenCalled();
  });

  it('ends when the page it holds navigates outside the allowed websites', async () => {
    const { page, cdp, mouse } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    await driver.hand.start(() => {});
    page.navigate('https://elsewhere.invalid/collect');
    await Promise.resolve();
    expect(cdp.sent.some((call) => call.method === 'Page.stopScreencast')).toBe(true);
    await expect(driver.hand.input({ kind: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 }))
      .rejects.toThrow(/Take over again/);
    expect(mouse.down).not.toHaveBeenCalled();
  });

  it('ends when the CDP session behind it goes away', async () => {
    const { page, cdp } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    await driver.hand.start(() => {});
    cdp.fail = true;
    cdp.listeners.get('Page.screencastFrame')!({ data: '', sessionId: 1, metadata });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(driver.hand.input({ kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 }))
      .rejects.toThrow(/Take over again/);
  });
});

describe('computer mode', () => {
  it('has no hand, and says where to take over instead', () => {
    const driver = new ComputerDriver(settingsSchema.parse({}), { run: async () => ({}), cancel: () => {} });
    expect(driver.supportsHand).toBe(false);
    const service = new BrowserService(driver);
    expect(service.hand()).toEqual({ supported: false, message: 'Take over at the computer for this mode.' });
  });

  it('offers a hand only while the owner holds the screen', async () => {
    const { fake } = bridge();
    const driver = new ExtensionDriver(fake);
    const service = new BrowserService(driver);
    await service.enable();
    // Nobody is driving: supported, but there is nothing to take over.
    expect(service.hand()).toEqual({ supported: true, message: 'No agent is driving this screen.' });
  });
});
