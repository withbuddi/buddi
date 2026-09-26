/**
 * The owner's secret tools, end to end without a browser or a database: the
 * route the use takes, the target that reaches it (always what the fake driver
 * reports, never an agent's claim), and what comes back — filled, typed, a
 * pending card, or the refusal. The delivered value is a real one here, so the
 * tests can prove it never appears in any result or error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuddiHost, SecretListing, SecretUseResult, SecretsArea, ToolContext } from '@buddi/core/plugin';
import { registerSecretDestination, resetSecretDestinations } from '@buddi/core/testing';
import { commandSchema, BrowserPreconditionError, type BrowserDriver, type Observation } from './types.js';
import { BrowserManager } from './manager.js';
import { BrowserService } from './service.js';
import { FIELD_KIND, FORM_KIND, NATIVE_KIND, fieldDestination, formDataDestination, nativeTypeDestination } from './secrets.js';

const observation: Observation = { id: 'o1', url: 'https://bank.test/', title: 'Fixture', tree: '- textbox "Card number"', tabs: [], capturedAt: new Date().toISOString() };
const VALUE = 'correct-horse-battery-staple';

/** A secrets area that answers like core would: the binding checked, the vault read, `deliver` called. */
function fakeSecrets(listing: SecretListing[], outcome: SecretUseResult): { area: SecretsArea; calls: Array<{ name: string; kind: string; target: unknown }> } {
  const calls: Array<{ name: string; kind: string; target: unknown }> = [];
  const area = {
    list: async () => listing,
    use: async (name: string, kind: string, target: unknown) => {
      calls.push({ name, kind, target });
      if (!('done' in outcome)) return outcome;
      // Core reads the vault and hands the value to `deliver` alone; here the
      // test plays the vault, through this plugin's own registered destination.
      (kind === FIELD_KIND ? fieldDestination : kind === NATIVE_KIND ? nativeTypeDestination : formDataDestination)
        .deliver(VALUE, target, { use: outcome.use, buddi: host() });
      return outcome;
    },
  } as unknown as SecretsArea;
  return { area, calls };
}

const host = () => ({ owner: { id: 'owner' } }) as unknown as BuddiHost;
const ctx = (secrets: SecretsArea): ToolContext => ({
  buddi: { owner: { id: 'owner' }, secrets },
  ownerRequest: { id: 'r1', text: 'Sign in to the bank', expiresAt: Date.now() + 60_000 },
  agentId: 'concierge',
  conversationId: 'c1',
} as ToolContext);

const listing = (totp: boolean): SecretListing[] => [{ name: 'PNC password', totp, bindings: [], lastUse: null }];

function driver(over: Partial<BrowserDriver> = {}): BrowserDriver {
  const base: BrowserDriver = {
    start: vi.fn(async () => {}),
    perform: vi.fn(async () => {}),
    observe: vi.fn(async () => observation),
    screenshot: vi.fn(async () => undefined),
    close: vi.fn(async () => {}),
    secretFieldInfo: vi.fn(async () => ({ origin: 'https://bank.test', password: false, name: 'Card number' })),
    secretFillField: vi.fn(async () => {}),
    focusedBundleId: vi.fn(async () => 'com.apple.keynote'),
    nativeType: vi.fn(async () => {}),
  };
  return Object.assign(base, over);
}

const services: BrowserService[] = [];
const managers: BrowserManager[] = [];

beforeEach(() => {
  // The fake's use() delivers through this plugin's own destinations, so they
  // must be the registered ones — the same table core builds at load.
  registerSecretDestination('browser', fieldDestination);
  registerSecretDestination('browser', formDataDestination);
  registerSecretDestination('browser', nativeTypeDestination);
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  resetSecretDestinations();
});

async function setup(options: { listing?: SecretListing[]; outcome?: SecretUseResult; driver?: BrowserDriver } = {}) {
  const { area, calls } = fakeSecrets(options.listing ?? listing(false), options.outcome ?? { done: true, use: 'u1' });
  const fake = options.driver ?? driver();
  const service = new BrowserService(fake);
  services.push(service);
  await service.enable();
  await service.execute(commandSchema.parse({ action: 'navigate', url: 'https://bank.test/' }), ctx(area) as never);
  return { driver: fake, service, calls, secrets: area };
}

describe('secret.fill', () => {
  it('sends the backend-reported origin and field to use(), fills, and answers filled', async () => {
    const { service, driver, calls, secrets } = await setup();
    const result = await service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(secrets) as never);
    expect(result).toEqual({ filled: true });
    expect(calls).toEqual([{ name: 'PNC password', kind: FORM_KIND, target: { origin: 'https://bank.test', field: 'Card number' } }]);
    expect(driver.secretFillField).toHaveBeenCalledWith('o1', 'e7', VALUE, 'https://bank.test');
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it('routes a password field to browser.field, and a TOTP secret into any field', async () => {
    const password = await setup({
      driver: driver({ secretFieldInfo: vi.fn(async () => ({ origin: 'https://bank.test', password: true, name: 'Password' })) }),
    });
    await expect(password.service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(password.secrets) as never)).resolves.toEqual({ filled: true });
    expect(password.calls[0]).toMatchObject({ kind: FIELD_KIND, target: 'https://bank.test' });

    const otp = await setup({ listing: listing(true) });
    await otp.service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(otp.secrets) as never);
    expect(otp.calls[0]).toMatchObject({ kind: FIELD_KIND, target: 'https://bank.test' });
  });

  it('fills a visible field as browser.field when the owner bound the secret to that origin, naming the field', async () => {
    const bound: SecretListing[] = [{ name: 'Wikipedia_Username', totp: false, lastUse: null,
      bindings: [{ kind: FIELD_KIND, target: 'https://auth.wikimedia.org', rule: 'pre-approved', firstApprovedAt: null, heldByPlugin: false }] }];
    const username = () => driver({ secretFieldInfo: vi.fn(async () => ({ origin: 'https://auth.wikimedia.org', password: false, name: 'Username' })) });
    const visible = await setup({ listing: bound, driver: username() });
    await expect(visible.service.secretFill({ name: 'Wikipedia_Username', ref: 'e3', observation: 'o1' }, ctx(visible.secrets) as never)).resolves.toEqual({ filled: true });
    expect(visible.calls).toEqual([{ name: 'Wikipedia_Username', kind: FIELD_KIND, target: { origin: 'https://auth.wikimedia.org', field: 'Username' } }]);
    expect(visible.driver.secretFillField).toHaveBeenCalledWith('o1', 'e3', VALUE, 'https://auth.wikimedia.org');
    expect(fieldDestination.describe(visible.calls[0]!.target)).toBe('the Username field on https://auth.wikimedia.org');

    // Bound elsewhere: the field binding does not cover it, so it stays form data.
    const elsewhere = await setup({ listing: bound, driver: driver({ secretFieldInfo: vi.fn(async () => ({ origin: 'https://evil.test', password: false, name: 'Username' })) }) });
    await elsewhere.service.secretFill({ name: 'Wikipedia_Username', ref: 'e3', observation: 'o1' }, ctx(elsewhere.secrets) as never);
    expect(elsewhere.calls[0]).toMatchObject({ kind: FORM_KIND, target: { origin: 'https://evil.test', field: 'Username' } });

    // No field binding at all: form data, as before.
    const unbound = await setup({ listing: [{ name: 'Wikipedia_Username', totp: false, lastUse: null, bindings: [] }], driver: username() });
    await unbound.service.secretFill({ name: 'Wikipedia_Username', ref: 'e3', observation: 'o1' }, ctx(unbound.secrets) as never);
    expect(unbound.calls[0]).toMatchObject({ kind: FORM_KIND });

    // A password field keeps its plain origin target.
    const password = await setup({ listing: bound, driver: driver({ secretFieldInfo: vi.fn(async () => ({ origin: 'https://auth.wikimedia.org', password: true, name: 'Password' })) }) });
    await password.service.secretFill({ name: 'Wikipedia_Username', ref: 'e4', observation: 'o1' }, ctx(password.secrets) as never);
    expect(password.calls[0]).toEqual({ name: 'Wikipedia_Username', kind: FIELD_KIND, target: 'https://auth.wikimedia.org' });
  });

  it('passes a pending card through without dispatching anything, and the refusal as a refusal', async () => {
    const pending = await setup({ outcome: { pending: 'action-9' } });
    const result = await pending.service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(pending.secrets) as never);
    expect(result).toMatchObject({ pending: true, actionId: 'action-9' });
    expect(pending.driver.secretFillField).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(VALUE);

    const refused = await setup({ outcome: { refused: '"PNC password" is not bound to the page at https://bank.test.' } });
    const error = await refused.service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(refused.secrets) as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserPreconditionError);
    expect(JSON.parse((error as Error).message)).toMatchObject({ dispatched: false, error: expect.stringContaining('not bound to') });
    expect(refused.driver.secretFillField).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(VALUE);
  });

  it('refuses a stale observation like browser.act does, with nothing dispatched and no card drawn', async () => {
    const stale = await setup({
      driver: driver({ secretFieldInfo: vi.fn(async () => { throw new BrowserPreconditionError('Stale page observation. Use the latest observation.id and target ref.'); }) }),
    });
    const error = await stale.service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'old' }, ctx(stale.secrets) as never).catch((e: unknown) => e);
    expect(JSON.parse((error as Error).message)).toMatchObject({ dispatched: false });
    expect(stale.calls).toEqual([]);
    expect(stale.driver.secretFillField).not.toHaveBeenCalled();
  });

  it('refuses a secret the browser destinations have never heard of, before any card', async () => {
    const unknown = await setup({ listing: [] });
    const error = await unknown.service.secretFill({ name: 'Other secret', ref: 'e7', observation: 'o1' }, ctx(unknown.secrets) as never).catch((e: unknown) => e);
    expect(JSON.parse((error as Error).message)).toMatchObject({ dispatched: false, error: expect.stringContaining('There is no secret named "Other secret"') });
    expect(unknown.calls).toEqual([]);
  });

  it('refuses a mode with no page fields, naming what is needed', async () => {
    const bare = await setup({ driver: driver({ secretFieldInfo: undefined, secretFillField: undefined }) });
    await expect(bare.service.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(bare.secrets) as never))
      .rejects.toThrow(/Playwright browser automation or in the buddi extension mode/);
    expect(bare.calls).toEqual([]);
  });
});

describe('secret.type', () => {
  it('targets the bundle id the backend reported, types on approval, and answers typed', async () => {
    const { service, driver, calls, secrets } = await setup();
    const result = await service.secretType({ name: 'PNC password' }, ctx(secrets) as never);
    expect(result).toEqual({ typed: true });
    expect(calls).toEqual([{ name: 'PNC password', kind: NATIVE_KIND, target: 'com.apple.keynote' }]);
    expect(driver.nativeType).toHaveBeenCalledWith(VALUE);
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it('answers a pending card and never types, and refuses with the reason', async () => {
    const pending = await setup({ outcome: { pending: 'action-4' } });
    const result = await pending.service.secretType({ name: 'PNC password' }, ctx(pending.secrets) as never);
    expect(result).toMatchObject({ pending: true, actionId: 'action-4' });
    expect(pending.driver.nativeType).not.toHaveBeenCalled();

    const refused = await setup({ outcome: { refused: '"PNC password" is not bound to the app com.apple.keynote.' } });
    await expect(refused.service.secretType({ name: 'PNC password' }, ctx(refused.secrets) as never)).rejects.toThrow('not bound to the app');
    expect(refused.driver.nativeType).not.toHaveBeenCalled();
  });

  it('refuses when nothing is focused, and when the mode cannot type at all', async () => {
    const unfocused = await setup({ driver: driver({ focusedBundleId: vi.fn(async () => undefined) }) });
    await expect(unfocused.service.secretType({ name: 'PNC password' }, ctx(unfocused.secrets) as never)).rejects.toThrow(/no focused application/);
    const bare = await setup({ driver: driver({ focusedBundleId: undefined, nativeType: undefined }) });
    await expect(bare.service.secretType({ name: 'PNC password' }, ctx(bare.secrets) as never)).rejects.toThrow(/Computer mode/);
  });
});

describe('the route through the manager', () => {
  it('runs a secret use on the conversation that owns the screen, and refuses a conversation with none', async () => {
    const manager = new BrowserManager(() => driver(), {});
    managers.push(manager);
    await manager.enable();
    const { area } = fakeSecrets(listing(false), { done: true, use: 'u1' });
    await manager.execute(commandSchema.parse({ action: 'navigate', url: 'https://bank.test/' }), ctx(area) as never);
    await expect(manager.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, ctx(area) as never))
      .resolves.toEqual({ filled: true });
    const other = { ...ctx(area), agentId: 'other', ownerRequest: { id: 'r2', text: 'Sign in to the bank', expiresAt: Date.now() + 60_000 } } as never;
    await expect(manager.secretFill({ name: 'PNC password', ref: 'e7', observation: 'o1' }, other)).rejects.toThrow('Start with navigate');
  });
});