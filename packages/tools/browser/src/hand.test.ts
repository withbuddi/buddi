/**
 * The remote hand, as the three drivers implement it.
 *
 * Fakes on both sides: a bridge standing in for the owner's Chrome, and a page
 * standing in for Playwright's. What is being checked is the mapping — which
 * command goes out for a click, which CDP call starts and acks a screencast,
 * and that a provided route (the Computer plugin's apps) says so in one
 * sentence rather than pretending.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExtensionDriver, type ExtensionBridge, type ExtensionCommand } from './extension.js';
import { PlaywrightDriver, selectedTextSource } from './driver.js';
import { RouteProviderDriver } from './routes.js';
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
    // An extension from before the live picture has nothing to go back to: the screencast stops.
    expect(sent[2]).toMatchObject({ name: 'screencast.stop' });
    push({ jpeg: Buffer.from('too-late'), metadata });
    expect(frames).toHaveLength(1);
    // The subscription is the driver's, for its life; closing the page lets it go.
    expect(listening()).toBe(true);
    await driver.close();
    expect(listening()).toBe(false);
  });
});

/*
 * A live extension (it says `live` in its hello): the Canvas's picture is
 * painted while the agent works, Take over is the remote hand, and Bring the
 * tab to the front is its own action.
 */
describe('the extension driver with a live extension', () => {
  function live(answers: Partial<Record<string, Record<string, unknown>>> = {}) {
    const made = bridge();
    made.fake.supports = (feature) => feature === 'live';
    made.fake.send = async (command) => { made.sent.push(command); return answers[command.name] ?? {}; };
    return made;
  }

  it('paints the page for the Canvas once a navigation opened it, and the newest frame is the Page tab’s picture', async () => {
    const { fake, sent, push } = live();
    const driver = new ExtensionDriver(fake);
    expect(driver.livePicture()).toBeUndefined();
    await driver.perform({ action: 'navigate', url: 'https://example.com/' } as never);
    expect(sent.map((command) => command.name)).toEqual(['navigate', 'screencast.start']);
    expect(sent[1]!.args).toMatchObject({ watch: true, interval: 500, maxWidth: 960, maxHeight: 600 });
    push({ jpeg: Buffer.from('first'), metadata });
    push({ jpeg: Buffer.from('newest'), metadata });
    expect(driver.livePicture()?.toString()).toBe('newest');
    // Take over holds nothing in place: no `hold`, the hand is theirs from wherever they are.
    await driver.takeover();
    expect(driver.holdsInPlace).toBeUndefined();
    expect(sent.some((command) => command.name === 'hold')).toBe(false);
  });

  it('starts the hand on the last picture, and goes back to watching when the owner gives it back', async () => {
    const { fake, sent, push } = live();
    const driver = new ExtensionDriver(fake);
    await driver.perform({ action: 'navigate', url: 'https://example.com/' } as never);
    push({ jpeg: Buffer.from('canvas'), metadata });
    const frames: string[] = [];
    await driver.hand.start((frame) => frames.push(frame.jpeg.toString()));
    expect(frames).toEqual(['canvas']);
    expect(sent.at(-1)).toMatchObject({ name: 'screencast.start', args: { maxWidth: 960 } });
    expect(sent.at(-1)!.args['watch']).toBeUndefined();
    push({ jpeg: Buffer.from('hand'), metadata });
    expect(frames).toEqual(['canvas', 'hand']);
    await driver.hand.stop();
    expect(sent.at(-1)).toMatchObject({ name: 'screencast.start', args: { watch: true } });
    push({ jpeg: Buffer.from('after'), metadata });
    expect(frames).toEqual(['canvas', 'hand']);
  });

  it('sends the window’s buttons down as input, an address only through the allowed-sites check', async () => {
    const { fake, sent } = live();
    const driver = new ExtensionDriver(fake, ['example.com']);
    await driver.hand.input({ kind: 'nav', action: 'back' });
    expect(sent.at(-1)).toMatchObject({ name: 'input', owner: true, args: { kind: 'nav', action: 'back' } });
    await driver.hand.input({ kind: 'nav', action: 'navigate', url: 'https://example.com/orders' });
    expect(sent.at(-1)).toMatchObject({ args: { kind: 'nav', action: 'navigate', url: 'https://example.com/orders' } });
    await expect(driver.hand.input({ kind: 'nav', action: 'navigate', url: 'https://elsewhere.test/' })).rejects.toThrow(/outside the configured browser hosts/);
  });

  it('copies the selection, and captures a PNG with the page’s title and address', async () => {
    const { fake, sent } = live({ copy: { observation: { copied: 'order 1234' } }, capture: { screenshot: Buffer.from('png').toString('base64'), observation: { url: 'https://example.com/o', title: 'Your orders' } } });
    const driver = new ExtensionDriver(fake);
    expect(await driver.hand.copy!()).toBe('order 1234');
    const shot = await driver.capture();
    expect(shot).toEqual({ png: Buffer.from('png'), title: 'Your orders', url: 'https://example.com/o' });
    expect(sent.find((command) => command.name === 'capture')).toMatchObject({ owner: true });
  });

  it('brings the tab to the front only when asked, and then holds it there', async () => {
    const { fake, sent } = live();
    const driver = new ExtensionDriver(fake);
    await driver.bringToFront();
    expect(sent.at(-1)).toMatchObject({ name: 'hold', owner: true });
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

  it('drives the window buttons on the held page, through the same address check, and says where each frame is', async () => {
    const { page, cdp } = fakePage();
    const calls: string[] = [];
    Object.assign(page, {
      goto: vi.fn(async (to: string) => { calls.push(`goto ${to}`); page.here = to; }),
      goBack: vi.fn(async () => { calls.push('back'); page.here = 'https://example.com/before'; }),
      goForward: vi.fn(async () => { calls.push('forward'); }),
      reload: vi.fn(async () => { calls.push('reload'); }),
    });
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    const frames: HandFrame[] = [];
    await driver.hand.start((frame) => frames.push(frame));
    cdp.listeners.get('Page.screencastFrame')!({ data: Buffer.from('x').toString('base64'), sessionId: 1, metadata });
    expect(frames[0]!.metadata.url).toBe('https://example.com/');

    await driver.hand.input({ kind: 'nav', action: 'back' });
    await driver.hand.input({ kind: 'nav', action: 'forward' });
    await driver.hand.input({ kind: 'nav', action: 'reload' });
    await driver.hand.input({ kind: 'nav', action: 'navigate', url: 'https://example.com/orders' });
    expect(calls).toEqual(['back', 'forward', 'reload', 'goto https://example.com/orders']);

    // An address the tool may not visit is refused before anything loads.
    await expect(driver.hand.input({ kind: 'nav', action: 'navigate', url: 'https://elsewhere.invalid/' })).rejects.toThrow(/outside/);
    expect(calls).toHaveLength(4);
    await driver.hand.stop();
  });

  it('leaves the owner’s Chrome to its own buttons', async () => {
    const { fake, sent } = bridge();
    const driver = new ExtensionDriver(fake);
    await driver.hand.start(() => {});
    await expect(driver.hand.input({ kind: 'nav', action: 'reload' })).rejects.toThrow(/Chrome’s own buttons/);
    expect(sent.some((command) => command.name === 'input')).toBe(false);
  });

  it('types "ame" once, not "aammee", and pastes in one piece', async () => {
    const { page, keyboard } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    await driver.hand.start(() => {});

    // What the dashboard now sends for three keystrokes: one `char` each, and
    // no key of their own. `keyboard.down('a')` types an "a" all by itself, so
    // a key *and* its character is how the page saw every letter twice.
    for (const character of 'ame') {
      await driver.hand.input({ kind: 'key', type: 'char', key: character, code: `Key${character.toUpperCase()}`, text: character, modifiers: 0 });
    }
    expect(keyboard.insertText.mock.calls.flat()).toEqual(['a', 'm', 'e']);
    expect(keyboard.down).not.toHaveBeenCalled();

    // An older dashboard's printable keyDown inserts nothing at all here,
    // rather than a second copy of the character.
    await driver.hand.input({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0 });
    await driver.hand.input({ kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 });
    expect(keyboard.down).not.toHaveBeenCalled();
    expect(keyboard.up).not.toHaveBeenCalled();
    expect(keyboard.insertText).toHaveBeenCalledTimes(3);

    // A shortcut is still a press: Cmd+A selects, and Playwright leaves the
    // text off a key held under a real modifier.
    await driver.hand.input({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
    expect(keyboard.down).toHaveBeenCalledWith('a');

    // And a paste is one insertion, however many characters the owner had.
    await driver.hand.input({ kind: 'text', text: 'hunter2\nsecond line' });
    expect(keyboard.insertText).toHaveBeenCalledWith('hunter2\nsecond line');
    expect(keyboard.insertText).toHaveBeenCalledTimes(4);

    await driver.hand.stop();
  });

  it('copies what is selected on the held page: the main frame first, then a frame, never more than a paste', async () => {
    const { page, frame } = fakePage();
    const child = { url: () => page.here, evaluate: vi.fn(async () => 'from the iframe') };
    Object.assign(frame, { evaluate: vi.fn(async () => '') });
    Object.assign(page, { frames: () => [frame, child] });
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    await driver.hand.start(() => {});
    await expect(driver.hand.copy!()).resolves.toBe('from the iframe');
    (frame as unknown as { evaluate: ReturnType<typeof vi.fn> }).evaluate.mockResolvedValue('x'.repeat(5_000));
    await expect(driver.hand.copy!()).resolves.toHaveLength(4_000);
    // The ask itself types nothing.
    await driver.hand.input({ kind: 'copy' });
    await driver.hand.stop();
    await expect(driver.hand.copy!()).rejects.toThrow('gone');
  });

  it('reads the selection the way the page shows it: the document’s, or the focused field’s, never a password', () => {
    const field = { tagName: 'INPUT', type: 'text', value: 'sam@example.com', selectionStart: 0, selectionEnd: 3 };
    let selection = '';
    vi.stubGlobal('window', { getSelection: () => ({ toString: () => selection }) });
    vi.stubGlobal('document', { activeElement: field });
    try {
      expect(selectedTextSource(4_000)).toBe('sam');
      selection = 'Order #112-334';
      expect(selectedTextSource(4_000)).toBe('Order #112-334');
      expect(selectedTextSource(5)).toBe('Order');
      selection = '';
      field.type = 'password';
      expect(selectedTextSource(4_000)).toBe('');
    } finally { vi.unstubAllGlobals(); }
  });

  it('captures the viewport as a PNG at full resolution, password fields masked', async () => {
    const { page, frame } = fakePage();
    const screenshot = vi.fn(async (_options: Record<string, unknown>) => Buffer.from('png-bytes'));
    Object.assign(frame, { locator: (selector: string) => ({ selector }) });
    Object.assign(page, { screenshot, title: async () => 'Your account', frames: () => [frame] });
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, fakeHost(page));
    await driver.start();
    await expect(driver.capture()).resolves.toEqual({ png: Buffer.from('png-bytes'), title: 'Your account', url: page.here });
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ type: 'png', mask: [{ selector: 'input[type=password]' }] });
    expect(screenshot.mock.calls[0]![0].fullPage).toBeUndefined();
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

describe('a provided route', () => {
  it('has no hand, and says where to take over instead', () => {
    const provider = { kind: 'apps' as const, label: 'your apps', health: () => ({ ok: true }), do: async () => {}, look: async () => { throw new Error('unused'); } };
    const driver = new RouteProviderDriver(provider, 's');
    expect(driver.supportsHand).toBe(false);
    expect(new BrowserService(driver).hand()).toEqual({ supported: false, message: 'Take over at the computer for your apps.' });
    expect(new BrowserService(new RouteProviderDriver({ ...provider, handMessage: 'Take over at the Mac.' }, 's')).hand()).toEqual({ supported: false, message: 'Take over at the Mac.' });
  });

  it('offers a hand only while the owner holds the screen', async () => {
    const { fake } = bridge();
    const driver = new ExtensionDriver(fake);
    const service = new BrowserService(driver);
    await service.enable();
    // Nobody is driving: supported, but there is nothing to take over.
    expect(service.hand()).toEqual({ supported: true, message: 'No agent is looking at this page.' });
  });
});
