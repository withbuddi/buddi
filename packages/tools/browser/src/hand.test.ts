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
    expect(sent[0]).toMatchObject({ name: 'screencast.start', session: driver.session, args: { maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } });
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
function fakePage() {
  const cdp = {
    sent: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    listeners: new Map<string, (event: unknown) => void>(),
    on(event: string, handler: (event: unknown) => void) { this.listeners.set(event, handler); },
    send(method: string, params?: Record<string, unknown>) { this.sent.push({ method, ...(params ? { params } : {}) }); return Promise.resolve({}); },
    detach: vi.fn(async () => {}),
  };
  const mouse = { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}), wheel: vi.fn(async () => {}) };
  const keyboard = { down: vi.fn(async () => {}), up: vi.fn(async () => {}), insertText: vi.fn(async () => {}) };
  const page = { isClosed: () => false, mouse, keyboard, context: () => ({ newCDPSession: async () => cdp }) };
  return { page, cdp, mouse, keyboard };
}

describe('the Playwright driver’s hand', () => {
  it('screencasts over CDP, acks every frame, and drives the real mouse and keyboard', async () => {
    const { page, cdp, mouse, keyboard } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, { open: async () => page } as never);
    await driver.start();
    const frames: HandFrame[] = [];
    await driver.hand.start((frame) => frames.push(frame));
    expect(cdp.sent[0]).toMatchObject({ method: 'Page.startScreencast', params: { format: 'jpeg', quality: 60 } });

    cdp.listeners.get('Page.screencastFrame')!({ data: Buffer.from('jpeg-bytes').toString('base64'), sessionId: 7, metadata: { ...metadata, offsetTop: 12 } });
    expect(frames[0]!.jpeg.toString()).toBe('jpeg-bytes');
    expect(frames[0]!.metadata.offsetTop).toBe(12);
    // An unacked screencast stops after a frame or two, so this is the wire.
    await Promise.resolve();
    expect(cdp.sent.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 7)).toBe(true);

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
