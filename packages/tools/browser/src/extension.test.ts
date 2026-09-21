import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@buddi/core';
import { HostController } from './controller.js';
import { ExtensionDriver, NOT_CONNECTED, type ExtensionBridge, type ExtensionCommand } from './extension.js';
import { BrowserPreconditionError, commandSchema } from './types.js';

/** A bridge that records what was asked of it and answers from a script. */
function bridge(answers: Partial<Record<string, unknown>> = {}, connected = true) {
  const sent: ExtensionCommand[] = [];
  const fake: ExtensionBridge = {
    connected: () => connected,
    send: async (command) => {
      sent.push(command);
      const answer = answers[command.name];
      if (answer instanceof Error) throw answer;
      return (answer as { observation?: unknown; screenshot?: string | null } | undefined) ?? {};
    },
    close: () => {},
  };
  return { fake, sent };
}

const page = { observation: { url: 'https://example.com/', title: 'Example', tree: 'Frame 0\n  link "Next"', targets: [{ ref: 'e1', frame: 0, role: 'link', name: 'Next', href: 'https://example.com/next' }], tabs: [{ id: 'tab-1', url: 'https://example.com/', title: 'Example' }] } };
const shot = { screenshot: Buffer.from('png').toString('base64') };
const command = (input: Record<string, unknown>) => commandSchema.parse(input);
const ctx = (id = 'a'): ToolContext => ({ ownerId: 'owner', db: {} as never, now: () => new Date(), timezone: 'UTC', agentId: id, conversationId: id,
  ownerRequest: { id: `request-${id}`, text: 'Open the website', expiresAt: Date.now() + 60_000 } });

const dirs: string[] = [];
const controllers: HostController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the extension driver', () => {
  it('refuses to start, and to act, while no browser is connected', async () => {
    const { fake } = bridge({}, false);
    const driver = new ExtensionDriver(fake);
    await expect(driver.start()).rejects.toThrow(NOT_CONNECTED);
    await expect(driver.observe()).rejects.toThrow(NOT_CONNECTED);
    // Closing an absent browser is a no-op, never an error on release.
    await expect(driver.close()).resolves.toBeUndefined();
  });

  it('maps every command to a frame, scoped to this conversation session', async () => {
    const { fake, sent } = bridge({ observe: page, screenshot: shot });
    const driver = new ExtensionDriver(fake);
    await driver.start();
    await driver.perform(command({ action: 'navigate', url: 'https://example.com/' }));
    const observation = await driver.observe();
    expect(observation.targets?.[0]).toMatchObject({ ref: 'e1', role: 'link', name: 'Next' });
    expect(observation.tabs).toEqual([{ id: 'tab-1', url: 'https://example.com/', title: 'Example' }]);
    expect(await driver.screenshot()).toEqual(Buffer.from('png'));

    await driver.perform(command({ action: 'click', observation: observation.id, target: { ref: 'e1' } }));
    const fresh = await driver.observe();
    await driver.perform(command({ action: 'fill', observation: fresh.id, target: { ref: 'e1' }, value: 'hello' }));
    await driver.observe();
    await driver.perform(command({ action: 'tab', tabId: 'tab-1' }));
    await driver.perform(command({ action: 'close' }));
    expect(sent.map((c) => c.name)).toEqual(['navigate', 'observe', 'screenshot', 'click', 'observe', 'fill', 'observe', 'tab', 'close']);
    expect(new Set(sent.map((c) => c.session)).size).toBe(1);
    expect(sent[0]).toMatchObject({ args: { url: 'https://example.com/' } });
    expect(sent[5]).toMatchObject({ args: { target: { ref: 'e1' }, value: 'hello' } });
  });

  it('refuses native apps, coordinates, stale evidence and hosts outside the allow list', async () => {
    const { fake, sent } = bridge({ observe: page, screenshot: shot });
    const driver = new ExtensionDriver(fake, ['example.com']);
    await expect(driver.perform(command({ action: 'open', appId: 'com.apple.Safari' }))).rejects.toThrow(BrowserPreconditionError);
    await expect(driver.perform(command({ action: 'click', observation: 'o1', target: { x: 10, y: 10 } }))).rejects.toThrow(BrowserPreconditionError);
    await expect(driver.perform(command({ action: 'navigate', url: 'https://elsewhere.example/' }))).rejects.toThrow('outside the configured browser hosts');
    await expect(driver.perform(command({ action: 'click', observation: 'o1', target: { ref: 'e1' } }))).rejects.toThrow('Stale page observation');
    // A dispatched action spends its evidence: the same id cannot act twice.
    const observation = await driver.observe();
    await driver.perform(command({ action: 'click', observation: observation.id, target: { ref: 'e1' } }));
    await expect(driver.perform(command({ action: 'click', observation: observation.id, target: { ref: 'e1' } }))).rejects.toThrow('Stale page observation');
    expect(sent.map((c) => c.name)).toEqual(['observe', 'click']);
  });
});

describe('the mode choice', () => {
  it('drives the owner’s Chrome only once the owner has chosen "Your browser"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-mode-'));
    dirs.push(dir);
    const { fake, sent } = bridge({ observe: page, screenshot: shot });
    const controller = new HostController(dir, { extensionBridge: () => fake });
    controllers.push(controller);
    await controller.enable();
    expect(controller.status().mode).toBe('computer');

    const settings = { ...controller.status().settings!, mode: 'extension' as const };
    expect((await controller.configure(settings)).mode).toBe('extension');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).mode).toBe('extension');
    // The two things this mode refuses, exactly as Playwright mode does.
    await expect(controller.execute(command({ action: 'open', appId: 'com.apple.Safari' }), ctx())).rejects.toThrow('require Computer mode');

    await expect(controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx())).resolves.toMatchObject({ completed: true });
    expect(sent.map((c) => c.name)).toEqual(['navigate', 'observe', 'screenshot']);
  });
});
