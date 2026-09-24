/**
 * The three destinations, the manifest that carries them, and the pure
 * decisions underneath: what an origin is, when two bind, and which
 * destination one field takes. No database — the registry registration is the
 * pure piece core runs at load, and the look-alike refusals are the unit form
 * of owner-secrets.md §9's acceptance 2.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BuddiHost, SecretDestination } from '@buddi/core/plugin';
import { resetSecretDestinations, secretDestination, secretDestinations, ToolRegistry } from '@buddi/core/testing';
import { createBrowserManifest } from './index.js';
import { checkSecretOrigin, canonicalOrigin, fieldDestination, FIELD_KIND, fieldOrigin, formDataDestination, FORM_KIND, nativeTypeDestination, NATIVE_KIND, secretKindFor } from './secrets.js';
import { BrowserPreconditionError } from './types.js';

describe('the manifest', () => {
  it('declares the secrets use, the two secret tools and the three destinations, and registers them all', () => {
    const manifest = createBrowserManifest();
    expect(manifest.uses).toContain('secrets');
    expect(manifest.destinations?.map((d) => [d.kind, d.maxRule])).toEqual([
      ['browser.field', 'pre-approved'],
      ['browser.form.data', 'every-time'],
      ['browser.native.type', 'every-time'],
    ]);
    const registry = new ToolRegistry();
    registry.register(manifest);
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain('secret.fill');
    expect(names).toContain('secret.type');
    expect(names).toContain('browser.act');
    expect(registry.list().find((tool) => tool.name === 'secret.fill')?.inputSchema.type).toBe('object');
    // The registration is core's own: each kind lands in the table under this plugin's name.
    for (const kind of [FIELD_KIND, FORM_KIND, NATIVE_KIND]) {
      expect(secretDestination(kind)).toMatchObject({ plugin: 'browser' });
      expect(secretDestination(kind)?.deliver).toBeTypeOf('function');
      expect(secretDestination(kind)?.checkTarget).toBeTypeOf('function');
    }
    expect(secretDestinations().filter((d) => d.plugin === 'browser')).toHaveLength(3);
  });
});

describe('what an origin is', () => {
  it('compares scheme, lower-cased host and port, and nothing looser', () => {
    expect(canonicalOrigin('https://WWW.PNC.com/')).toBe('https://www.pnc.com');
    expect(canonicalOrigin('http://example.test:443/x')).toBe('http://example.test:443');
    expect(canonicalOrigin('https://example.test')).toBe('https://example.test');
    expect(canonicalOrigin('http://example.test:8443')).toBe('http://example.test:8443');
    expect(canonicalOrigin('about:blank')).toBeUndefined();
    expect(canonicalOrigin('file:///tmp/x')).toBeUndefined();
    expect(canonicalOrigin('chrome://settings')).toBeUndefined();
    expect(canonicalOrigin('null')).toBeUndefined();
    expect(canonicalOrigin('not a url')).toBeUndefined();
    expect(canonicalOrigin('')).toBeUndefined();
    expect(canonicalOrigin(undefined)).toBeUndefined();
  });

  it('refuses a field whose frame has no origin buddi can bind', () => {
    expect(fieldOrigin('https://bank.test/login')).toBe('https://bank.test');
    expect(() => fieldOrigin('about:blank')).toThrow(BrowserPreconditionError);
    expect(() => fieldOrigin('file:///etc/passwd')).toThrow(/no web origin/);
    expect(() => fieldOrigin(undefined)).toThrow(BrowserPreconditionError);
  });

  it('refuses the fill when the frame no longer reports the origin the use was delivered for', () => {
    expect(checkSecretOrigin('https://bank.test/now', 'https://bank.test')).toBe('https://bank.test');
    expect(() => checkSecretOrigin('https://elsewhere.test', 'https://bank.test')).toThrow(/nothing was entered/);
    expect(() => checkSecretOrigin('about:blank', 'https://bank.test')).toThrow(/nothing was entered/);
    expect(() => checkSecretOrigin(undefined, 'https://bank.test')).toThrow(/nothing was entered/);
  });
});

/** `checkTarget` takes the host a destination would be handed; these tests never reach it. */
const check = (destination: SecretDestination) => (target: unknown, bound: unknown) => destination.checkTarget(target, bound, undefined as unknown as BuddiHost);

describe('the destinations check the backend-reported target, never a looser one', () => {
  it('binds browser.field to one exact origin and refuses a look-alike, a punycode host and a frame on the wrong site', () => {
    expect(check(fieldDestination)('https://www.pnc.com', 'https://www.pnc.com')).toBe(true);
    expect(check(fieldDestination)('https://WWW.PNC.com/', 'https://www.pnc.com')).toBe(true);
    expect(check(fieldDestination)('https://www.pnc.com:443', 'https://www.pnc.com')).toBe(true);
    expect(check(fieldDestination)('https://www.pnc.com.evil.test', 'https://www.pnc.com')).toBe(false);
    expect(check(fieldDestination)('https://www.xn--pnc-3ve.com', 'https://www.pnc.com')).toBe(false);
    expect(check(fieldDestination)('http://www.pnc.com', 'https://www.pnc.com')).toBe(false);
    expect(check(fieldDestination)('https://www.pnc.com', { origin: 'https://www.pnc.com' })).toBe(false);
    expect(check(fieldDestination)(42, 'https://www.pnc.com')).toBe(false);
    expect(fieldDestination.describe('https://www.pnc.com')).toContain('https://www.pnc.com');
  });

  it('binds browser.form.data to origin and field name, and to nothing else', () => {
    const target = { origin: 'https://gov.test', field: 'card number' };
    expect(check(formDataDestination)({ ...target }, target)).toBe(true);
    expect(check(formDataDestination)({ ...target, origin: 'https://gov.test:443' }, target)).toBe(true);
    expect(check(formDataDestination)({ ...target, field: 'card number ' }, target)).toBe(false);
    expect(check(formDataDestination)({ ...target, field: 'tax number' }, target)).toBe(false);
    expect(check(formDataDestination)({ ...target, origin: 'https://gov.test.evil.test' }, target)).toBe(false);
    expect(check(formDataDestination)({ origin: 'https://gov.test' }, target)).toBe(false);
    expect(check(formDataDestination)('https://gov.test', target)).toBe(false);
    expect(formDataDestination.describe(target)).toContain('"card number"');
    expect(formDataDestination.describe('nonsense')).toBe('a form field');
  });

  it('binds browser.native.type to the bundle id the backend reported', () => {
    expect(check(nativeTypeDestination)('com.apple.keynote', 'com.apple.keynote')).toBe(true);
    expect(check(nativeTypeDestination)('com.apple.notes', 'com.apple.keynote')).toBe(false);
    expect(check(nativeTypeDestination)('com.apple.keynote ', 'com.apple.keynote')).toBe(false);
    expect(check(nativeTypeDestination)('', 'com.apple.keynote')).toBe(false);
    expect(nativeTypeDestination.describe('com.apple.keynote')).toContain('com.apple.keynote');
  });

  it('routes a field by what it is: a TOTP code or a password into browser.field, everything else into form data', () => {
    expect(secretKindFor(false, true)).toBe(FIELD_KIND);
    expect(secretKindFor(true, false)).toBe(FIELD_KIND);
    expect(secretKindFor(true, true)).toBe(FIELD_KIND);
    expect(secretKindFor(false, false)).toBe(FORM_KIND);
  });
});

/** Registration is process-wide module state; every suite here leaves it clean. */
afterEach(() => { resetSecretDestinations(); });