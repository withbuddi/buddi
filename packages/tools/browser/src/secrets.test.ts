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
import { checkSecretOrigin, canonicalOrigin, fieldDestination, FIELD_KIND, fieldOrigin, formDataDestination, FORM_KIND, nativeTypeDestination, NATIVE_KIND, fieldBoundTo, secretKindFor, secretsForAgent } from './secrets.js';
import { BrowserPreconditionError } from './types.js';
import { originMatchesPattern, parseOriginPattern } from './origin-pattern.js';
import { isPublicSuffix } from './public-suffixes.js';

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
    expect(names).toContain('secret.list');
    expect(registry.list().find((tool) => tool.name === 'secret.list')?.tier).toBe('auto');
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

describe('secret.list', () => {
  const listing = [{
    name: 'Wikipedia_Username', totp: false,
    bindings: [{ kind: FIELD_KIND, target: 'https://auth.wikimedia.org', rule: 'pre-approved' as const, firstApprovedAt: '2026-09-26T10:00:00Z', heldByPlugin: false }],
    lastUse: { at: '2026-09-26T10:00:00Z', kind: FIELD_KIND, target: 'https://auth.wikimedia.org', agentId: 'concierge', outcome: 'delivered' as const },
  }];

  it('answers names, the TOTP flag and each binding\'s kind and target, and nothing else', async () => {
    const tool = createBrowserManifest().tools.find((entry) => entry.name === 'secret.list')!;
    const ctx = { buddi: { secrets: { list: async () => listing } } } as never;
    const out = await tool.execute({}, ctx) as unknown[];
    expect(out).toEqual([{ name: 'Wikipedia_Username', totp: false, bindings: [{ kind: FIELD_KIND, target: 'https://auth.wikimedia.org' }] }]);
    for (const secret of out as Array<Record<string, unknown>>) {
      expect(Object.keys(secret).sort()).toEqual(['bindings', 'name', 'totp']);
      for (const binding of secret.bindings as Array<Record<string, unknown>>) expect(Object.keys(binding).sort()).toEqual(['kind', 'target']);
    }
    // Even a listing that somehow carried a value would not pass one on.
    expect(secretsForAgent([{ ...listing[0]!, value: 'hunter2' } as never])[0]).not.toHaveProperty('value');
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

  it('takes a visible field on the bound origin as a browser.field target, compared by origin alone, and names the field', () => {
    const username = { origin: 'https://auth.wikimedia.org', field: 'Username' };
    expect(check(fieldDestination)(username, 'https://auth.wikimedia.org')).toBe(true);
    expect(check(fieldDestination)({ ...username, origin: 'https://auth.wikimedia.org.evil.test' }, 'https://auth.wikimedia.org')).toBe(false);
    expect(check(fieldDestination)({ origin: 'https://auth.wikimedia.org' }, 'https://auth.wikimedia.org')).toBe(false);
    expect(check(fieldDestination)(username, username)).toBe(false);
    expect(fieldDestination.describe(username)).toBe('the Username field on https://auth.wikimedia.org');
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
    expect(secretKindFor(false, false, true)).toBe(FIELD_KIND);
  });

  it('counts a browser.field binding only on the field\'s own origin', () => {
    const bindings = [{ kind: FIELD_KIND, target: 'https://auth.wikimedia.org' }, { kind: FORM_KIND, target: { origin: 'https://gov.test', field: 'x' } }];
    expect(fieldBoundTo(bindings, 'https://auth.wikimedia.org')).toBe(true);
    expect(fieldBoundTo(bindings, 'https://en.wikipedia.org')).toBe(false);
    expect(fieldBoundTo(bindings, 'https://gov.test')).toBe(false);
    expect(fieldBoundTo([], 'https://auth.wikimedia.org')).toBe(false);
  });
});

describe('a wildcard origin', () => {
  it('parses to scheme, fixed suffix and port, and nothing looser', () => {
    expect(parseOriginPattern('https://*.wikimedia.org')).toEqual({ ok: true, value: { pattern: 'https://*.wikimedia.org', protocol: 'https:', suffix: 'wikimedia.org', port: '' } });
    expect(parseOriginPattern('HTTPS://*.WikiMedia.org/w/index.php')).toMatchObject({ ok: true, value: { pattern: 'https://*.wikimedia.org' } });
    expect(parseOriginPattern('https://*.wikimedia.org:443')).toMatchObject({ ok: true, value: { pattern: 'https://*.wikimedia.org' } });
    expect(parseOriginPattern('https://*.corp.test:8443')).toMatchObject({ ok: true, value: { pattern: 'https://*.corp.test:8443', port: '8443' } });
    expect(parseOriginPattern('http://*.corp.test')).toMatchObject({ ok: true, value: { protocol: 'http:' } });
  });

  it('refuses a * anywhere but the first label', () => {
    for (const text of ['https://*', 'https://auth.*.org', 'https://*wikimedia.org', 'https://*.*.wikimedia.org', 'https://wiki*.org', 'https://en.wikipedia.org/*', 'https://**.wikimedia.org']) {
      expect(parseOriginPattern(text)).toEqual({ ok: false, reason: 'placement' });
    }
    for (const text of ['ftp://*.wikimedia.org', '*.wikimedia.org', 'https://*.1.2.3', 'https://user@*.wikimedia.org']) {
      expect(parseOriginPattern(text).ok).toBe(false);
    }
  });

  it('refuses a public suffix, ICANN or private, and any single label', () => {
    for (const suffix of ['com', 'uk', 'co.uk', 'com.au', 'co.jp', 'github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'cloudfront.net', 'amazonaws.com', 'localhost', 'anything.ck']) {
      expect(isPublicSuffix(suffix)).toBe(true);
      expect(parseOriginPattern(`https://*.${suffix}`)).toEqual({ ok: false, reason: 'public-suffix' });
    }
    expect(isPublicSuffix('wikimedia.org')).toBe(false);
    expect(isPublicSuffix('bbc.co.uk')).toBe(false);
    expect(parseOriginPattern('https://*.bbc.co.uk').ok).toBe(true);
    expect(parseOriginPattern('https://*.owner.github.io').ok).toBe(true);
  });

  it('matches one or more labels before the suffix, on the same scheme and port', () => {
    expect(originMatchesPattern('https://auth.wikimedia.org', 'https://*.wikimedia.org')).toBe(true);
    expect(originMatchesPattern('https://a.b.wikimedia.org', 'https://*.wikimedia.org')).toBe(true);
    expect(originMatchesPattern('https://wikimedia.org', 'https://*.wikimedia.org')).toBe(false);
    expect(originMatchesPattern('https://auth.wikimedia.org.evil.test', 'https://*.wikimedia.org')).toBe(false);
    expect(originMatchesPattern('https://authwikimedia.org', 'https://*.wikimedia.org')).toBe(false);
    expect(originMatchesPattern('https://en.wikipedia.org', 'https://*.wikimedia.org')).toBe(false);
    expect(originMatchesPattern('http://auth.wikimedia.org', 'https://*.wikimedia.org')).toBe(false);
    expect(originMatchesPattern('https://auth.wikimedia.org:8443', 'https://*.wikimedia.org')).toBe(false);
    expect(originMatchesPattern('https://a.corp.test:8443', 'https://*.corp.test:8443')).toBe(true);
    expect(originMatchesPattern('https://a.corp.test', 'https://*.corp.test:8443')).toBe(false);
    expect(originMatchesPattern('https://x.com', 'https://*.com')).toBe(false);
  });

  it('binds browser.field and form data through the pattern, and the card names the real origin', () => {
    const pattern = 'https://*.wikimedia.org';
    expect(check(fieldDestination)('https://auth.wikimedia.org', pattern)).toBe(true);
    expect(check(fieldDestination)({ origin: 'https://auth.wikimedia.org', field: 'Username' }, pattern)).toBe(true);
    expect(check(fieldDestination)('https://auth.wikimedia.org.evil.test', pattern)).toBe(false);
    expect(check(fieldDestination)('https://x.com', 'https://*.com')).toBe(false);
    // The live side is never a pattern: a target holding a * matches nothing.
    expect(check(fieldDestination)(pattern, pattern)).toBe(false);
    expect(fieldBoundTo([{ kind: FIELD_KIND, target: pattern }], 'https://auth.wikimedia.org')).toBe(true);
    expect(fieldDestination.describe('https://auth.wikimedia.org')).toBe('the page at https://auth.wikimedia.org');
    expect(fieldDestination.describe({ origin: 'https://auth.wikimedia.org', field: 'Username' })).toBe('the Username field on https://auth.wikimedia.org');

    const bound = { origin: pattern, field: 'card number' };
    expect(check(formDataDestination)({ origin: 'https://pay.wikimedia.org', field: 'card number' }, bound)).toBe(true);
    expect(check(formDataDestination)({ origin: 'https://pay.wikimedia.org', field: 'tax number' }, bound)).toBe(false);
    expect(check(formDataDestination)(bound, bound)).toBe(false);
    expect(formDataDestination.describe({ origin: 'https://pay.wikimedia.org', field: 'card number' })).toBe('the field "card number" on https://pay.wikimedia.org');
    expect(canonicalOrigin(pattern)).toBeUndefined();
  });
});

/** Registration is process-wide module state; every suite here leaves it clean. */
afterEach(() => { resetSecretDestinations(); });