import { describe, expect, it, vi } from 'vitest';
import { ComputerDriver, computerEnvironment, settingsSchema, type ComputerBridge } from './computer.js';
import { BrowserPreconditionError, commandSchema } from './types.js';

const node = { path: [0, 1], role: 'AXButton', name: 'Continue', value: '', secure: false, enabled: true, bounds: { x: 10, y: 20, width: 100, height: 30 } };
const snapshot = { identity: 'window-1', title: 'Fixture', nodes: [node], width: 800, height: 600, imageHash: 'pixels', jpeg: Buffer.from('fixture').toString('base64') };
function setup() {
  const run = vi.fn(async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (input.operation === 'permissions') return { accessibility: true, screenRecording: true, supported: true };
    if (input.operation === 'observe') return snapshot;
    return { completed: true };
  });
  const bridge: ComputerBridge = { run, cancel: vi.fn() };
  return { driver: new ComputerDriver(settingsSchema.parse({}), bridge), bridge, run };
}
const open = commandSchema.parse({ action: 'open', appId: 'com.google.Chrome' });
describe('native computer driver', () => {
  it('does not pass application credentials or loader overrides to the helper', () => {
    expect(computerEnvironment({ HOME: '/owner', PATH: '/bin', BUDDI_VAULT_KEY: 'secret', DATABASE_URL: 'secret', ANTHROPIC_API_KEY: 'secret', DYLD_INSERT_LIBRARIES: 'unsafe' })).toEqual({ HOME: '/owner', PATH: '/bin' });
  });
  it('defaults to OS control and requires a permitted browser', () => {
    expect(settingsSchema.parse({}).mode).toBe('computer');
    expect(settingsSchema.safeParse({ browserApp: 'com.google.Chrome', allowedApps: ['com.apple.TextEdit'] }).success).toBe(false);
    expect(settingsSchema.safeParse({ mode: 'stealth' }).success).toBe(false);
  });
  it('checks permissions without prompting or opening anything', async () => {
    const { driver, run } = setup(); await driver.start();
    expect(run.mock.calls).toEqual([[{ operation: 'permissions', prompt: false }]]);
    run.mockResolvedValue({ accessibility: false, screenRecording: true });
    await expect(driver.start()).rejects.toThrow('No browser debugging fallback');
  });
  it('opens normal apps and exposes OS refs and selected-window screenshots', async () => {
    const { driver, run } = setup(); await driver.perform(open);
    const observation = await driver.observe();
    expect(run).toHaveBeenCalledWith({ operation: 'open', appId: 'com.google.Chrome' });
    expect(observation).toMatchObject({ appId: 'com.google.Chrome', screenshotSize: { width: 800, height: 600 }, targets: [{ ref: 'ax0', role: 'button', name: 'Continue' }] });
    expect(await driver.screenshot()).toEqual(Buffer.from('fixture'));
  });
  it('refuses apps outside owner settings and unsafe URL schemes before any native call', async () => {
    const { driver, run } = setup();
    await expect(driver.perform(commandSchema.parse({ action: 'open', appId: 'com.apple.Terminal' }))).rejects.toThrow('not owner-allowed');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1/']) await expect(driver.perform(commandSchema.parse({ action: 'navigate', url }))).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('navigates using only native open/act, never a debugging endpoint', async () => {
    const { driver, run } = setup();
    await driver.perform(commandSchema.parse({ action: 'navigate', url: 'https://example.com/' }));
    expect(run.mock.calls).toEqual([[{ operation: 'open', appId: 'com.google.Chrome' }], [{ operation: 'act', action: 'navigate', appId: 'com.google.Chrome', url: 'https://example.com/' }]]);
  });
  it('binds a click to both the window identity and exact observed accessibility node', async () => {
    const { driver, run } = setup(); await driver.perform(open); const observation = await driver.observe();
    const click = commandSchema.parse({ action: 'click', observation: observation.id, target: { ref: 'ax0' } });
    await driver.perform(click);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'act', identity: 'window-1', target: node, action: 'click' }));
    await expect(driver.perform(click)).rejects.toBeInstanceOf(BrowserPreconditionError);
  });
  it('requires fresh bounded screenshot coordinates and passes the image hash for native revalidation', async () => {
    const { driver, run } = setup(); await driver.perform(open); const observation = await driver.observe();
    await expect(driver.perform(commandSchema.parse({ action: 'click', observation: observation.id, target: { x: 900, y: 10 } }))).rejects.toThrow('inside');
    await driver.perform(commandSchema.parse({ action: 'click', observation: observation.id, target: { x: 25, y: 35 } }));
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ imageHash: 'pixels', x: 25, y: 35 }));
    expect(commandSchema.safeParse({ action: 'click', observation: 'id', target: { x: 10 } }).success).toBe(false);
    expect(commandSchema.safeParse({ action: 'click', observation: 'id', target: { ref: 'ax1', x: 10, y: 20 } }).success).toBe(false);
  });
  it('does not export secure fields as targets or accept them as guessed refs', async () => {
    const { driver, run } = setup(); await driver.perform(open);
    run.mockResolvedValue({ ...snapshot, nodes: [{ ...node, secure: true, name: 'Password' }] });
    const observation = await driver.observe();
    expect(observation.targets).toEqual([]); expect(observation.tree).toBe('');
    await expect(driver.perform(commandSchema.parse({ action: 'fill', observation: observation.id, target: { ref: 'ax0' }, value: 'secret' }))).rejects.toThrow('secure');
  });
  it('release/takeover cancels input and invalidates evidence without quitting user apps', async () => {
    const { driver, bridge, run } = setup(); await driver.perform(open); const observation = await driver.observe();
    await driver.takeover(); driver.resume();
    await expect(driver.perform(commandSchema.parse({ action: 'click', observation: observation.id, target: { ref: 'ax0' } }))).rejects.toThrow('Stale');
    await driver.close();
    expect(bridge.cancel).toHaveBeenCalledTimes(2); expect(await driver.screenshot()).toBeUndefined();
    expect(run.mock.calls.map(([input]) => input.operation)).toEqual(['open', 'observe']);
  });
  it('does not navigate after release interrupts the app launch', async () => {
    const { driver, run } = setup(); let finish!: (result: Record<string, unknown>) => void;
    run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const task = driver.perform(commandSchema.parse({ action: 'navigate', url: 'https://example.com' }));
    await driver.close(); finish({ opened: true });
    await expect(task).rejects.toThrow('cancelled'); expect(run).toHaveBeenCalledTimes(1);
  });
});
