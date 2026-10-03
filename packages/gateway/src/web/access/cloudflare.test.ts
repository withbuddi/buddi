/**
 * Cloudflare Access's JWT, verified by buddi itself (specs/trusted-access.md
 * §5.1): signature against the team's keys, issuer, audience, time with
 * skew, the allowed email — and never a header alone.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUD, OWNER_EMAIL, TEAM, fakeTeam } from '../../__fixtures__/access-jwt.js';
import { markSocketArrival } from './arrival.js';
import {
  JWKS_CACHE_MS,
  cloudflareProvider,
  createJwks,
  toCloudflareSetting,
  validateCloudflareInput,
  verifyAccessJwt,
  type CloudflareAccessSetting,
} from './cloudflare.js';

const T0 = new Date('2026-10-03T12:00:00Z');
const SETTING = { teamDomain: TEAM, aud: AUD, email: OWNER_EMAIL };

function setup(now = () => T0) {
  const team = fakeTeam({ now });
  const jwks = createJwks({ transport: team.transport, now });
  return { team, jwks, verify: (token: string, at = now()) => verifyAccessJwt(token, SETTING, { jwks, now: at }) };
}

describe('verifying an Access assertion', () => {
  it('accepts a valid assertion and says whose it is and when it ends', async () => {
    const { team, verify } = setup();
    const result = await verify(team.sign());
    expect(result).toEqual({ ok: true, assertion: { email: OWNER_EMAIL, expiresAt: new Date(T0.getTime() + 24 * 3600_000), issuedAt: T0 } });
  });

  it('refuses an expired assertion, allowing a minute of skew', async () => {
    const { team, verify } = setup();
    const at = Math.floor(T0.getTime() / 1000);
    expect(await verify(team.sign({ exp: at - 30 }))).toMatchObject({ ok: true });
    expect(await verify(team.sign({ exp: at - 61 }))).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses one that is not valid yet, past the skew', async () => {
    const { team, verify } = setup();
    const at = Math.floor(T0.getTime() / 1000);
    expect(await verify(team.sign({ nbf: at + 30 }))).toMatchObject({ ok: true });
    expect(await verify(team.sign({ nbf: at + 120 }))).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('refuses the wrong audience and the wrong issuer', async () => {
    const { team, verify } = setup();
    expect(await verify(team.sign({ aud: ['another-application-aud-0000000000'] }))).toEqual({ ok: false, reason: 'wrong-audience' });
    expect(await verify(team.sign({ aud: AUD }))).toMatchObject({ ok: true });
    expect(await verify(team.sign({ iss: 'https://evil.cloudflareaccess.com' }))).toEqual({ ok: false, reason: 'wrong-issuer' });
  });

  it('refuses a bad signature, a key the team does not publish, and any algorithm but RS256', async () => {
    const { team, verify } = setup();
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await verify(team.sign({}, {}, stranger))).toEqual({ ok: false, reason: 'bad-signature' });
    // A valid token with its payload swapped: the signature no longer covers it.
    const [h, , s] = team.sign().split('.');
    const forged = Buffer.from(JSON.stringify({ email: OWNER_EMAIL, aud: [AUD], iss: `https://${TEAM}`, exp: 9_999_999_999 })).toString('base64url');
    expect(await verify(`${h}.${forged}.${s}`)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await verify(team.sign({}, { kid: 'kid-unknown' }))).toEqual({ ok: false, reason: 'unknown-key' });
    expect(await verify(team.sign({}, { alg: 'HS256' }))).toEqual({ ok: false, reason: 'wrong-algorithm' });
    expect(await verify(team.sign({}, { alg: 'none' }))).toEqual({ ok: false, reason: 'wrong-algorithm' });
    expect(await verify('not.a.jwt!')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a service token and an email that is not the allowed one, whatever its case', async () => {
    const { team, verify } = setup();
    expect(await verify(team.sign({ email: undefined, common_name: 'abc.access' }))).toEqual({ ok: false, reason: 'service-token' });
    expect(await verify(team.sign({ email: 'someone@else.example' }))).toEqual({ ok: false, reason: 'email-not-allowed' });
    expect(await verify(team.sign({ email: 'Owner@Example.com' }))).toMatchObject({ ok: true });
  });

  it('refuses an assertion that claims to live longer than seven days', async () => {
    const { team, verify } = setup();
    const at = Math.floor(T0.getTime() / 1000);
    expect(await verify(team.sign({ exp: at + 8 * 24 * 3600 }))).toEqual({ ok: false, reason: 'too-long-lived' });
  });
});

describe("the team's keys", () => {
  it('fetches once for many assertions, and again after an hour', async () => {
    let now = T0;
    const { team, verify } = setup(() => now);
    for (let i = 0; i < 5; i++) expect(await verify(team.sign())).toMatchObject({ ok: true });
    expect(team.fetches()).toBe(1);
    now = new Date(T0.getTime() + JWKS_CACHE_MS + 1);
    expect(await verify(team.sign(), now)).toMatchObject({ ok: true });
    expect(team.fetches()).toBe(2);
  });

  it('follows a rotation on an unknown kid, but asks at most once a minute', async () => {
    let now = T0;
    const { team, verify } = setup(() => now);
    expect(await verify(team.sign())).toMatchObject({ ok: true });
    team.rotate();
    // Inside the minute: an unknown kid waits rather than hammering Cloudflare.
    now = new Date(T0.getTime() + 10_000);
    expect(await verify(team.sign(), now)).toEqual({ ok: false, reason: 'unknown-key' });
    expect(await verify(team.sign({}, { kid: 'kid-made-up' }), now)).toEqual({ ok: false, reason: 'unknown-key' });
    expect(team.fetches()).toBe(1);
    now = new Date(T0.getTime() + 61_000);
    expect(await verify(team.sign(), now)).toMatchObject({ ok: true });
    expect(team.fetches()).toBe(2);
  });

  it('says "could not ask" when the keys cannot be fetched, and never caches that as an answer', async () => {
    let now = T0;
    const { team, jwks, verify } = setup(() => now);
    team.fail('network');
    expect(await verify(team.sign())).toEqual({ ok: false, reason: 'keys-unreachable' });
    expect(jwks.failing(TEAM)).toBe(true);
    team.fail(null);
    now = new Date(T0.getTime() + 61_000);
    expect(await verify(team.sign(), now)).toMatchObject({ ok: true });
    expect(jwks.failing(TEAM)).toBe(false);
  });

  it('says what came back when the owner tests the setup', async () => {
    const { team, jwks } = setup();
    expect(await jwks.refresh(TEAM)).toEqual({ ok: true, keys: 1 });
    team.fail(404);
    const failed = await jwks.refresh(TEAM);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/didn’t answer with signing keys \(404\)/);
  });
});

describe('the provider', () => {
  const enabled: CloudflareAccessSetting = { enabled: true, ...SETTING, publicOrigin: 'https://buddi.example.com' };
  const req = (headers: Record<string, string | string[]>, ingress: boolean) => {
    const socket = { remoteAddress: '127.0.0.1' };
    if (ingress) markSocketArrival(socket, 'ingress');
    return { headers, socket } as never;
  };

  it('signs in only through the tunnel: the same valid assertion on the main listener is a replay and earns nothing', async () => {
    const { team, jwks } = setup();
    const lines: string[] = [];
    const provider = cloudflareProvider({ jwks, log: (l) => lines.push(l) });
    const token = team.sign();
    const through = await provider.identify(req({ 'cf-access-jwt-assertion': token, 'cf-connecting-ip': '203.0.113.9' }, true), enabled, T0);
    expect(through).toMatchObject({ ok: true, identity: { provider: 'cloudflare-access', subject: OWNER_EMAIL, bucket: 'cf:203.0.113.9' } });
    const replayed = await provider.identify(req({ 'cf-access-jwt-assertion': token }, false), enabled, T0);
    expect(replayed).toMatchObject({ ok: false, refusal: 'not-through-the-tunnel' });
    expect(provider.matches(req({ 'cf-access-jwt-assertion': token }, false))).toBe(false);
    // The log names the reason, never the token or a supplied value.
    expect(lines.join('\n')).not.toContain(token.slice(0, 20));
  });

  it('never takes a plain header for an identity', async () => {
    const { jwks } = setup();
    const provider = cloudflareProvider({ jwks, log: () => {} });
    const plain = await provider.identify(req({ 'cf-access-authenticated-user-email': OWNER_EMAIL, 'cf-connecting-ip': '203.0.113.9' }, true), enabled, T0);
    expect(plain).toMatchObject({ ok: false, refusal: 'no-assertion', kind: 'other' });
    const twice = await provider.identify(req({ 'cf-access-jwt-assertion': ['a', 'b'] }, true), enabled, T0);
    expect(twice).toMatchObject({ ok: false, refusal: 'malformed' });
    expect(provider.clientKey(req({ 'cf-connecting-ip': '203.0.113.9' }, true))).toBe('cf:unverified');
  });

  it('keeps a session through a stray request without the header, ends it for another email or the setting going off', async () => {
    const { team, jwks } = setup();
    const provider = cloudflareProvider({ jwks, log: () => {} });
    const session = { provider: 'cloudflare-access' as const, providerSubject: OWNER_EMAIL };
    expect(await provider.confirm(session, req({ 'cf-access-jwt-assertion': team.sign() }, true), enabled, T0)).toEqual({ answer: 'keep' });
    expect((await provider.confirm(session, req({}, true), enabled, T0)).answer).toBe('refuse');
    expect((await provider.confirm(session, req({ 'cf-access-jwt-assertion': team.sign({ email: 'other@example.com' }) }, true), enabled, T0)).answer).toBe('end');
    expect((await provider.confirm(session, req({ 'cf-access-jwt-assertion': team.sign() }, true), { ...enabled, enabled: false }, T0)).answer).toBe('end');
    expect((await provider.confirm(session, req({ 'cf-access-jwt-assertion': team.sign() }, true), { ...enabled, email: 'new@example.com' }, T0)).answer).toBe('end');
    team.fail('network');
    const unreachable = cloudflareProvider({ jwks: createJwks({ transport: team.transport, now: () => T0 }), log: () => {} });
    expect((await unreachable.confirm(session, req({ 'cf-access-jwt-assertion': team.sign() }, true), enabled, T0)).answer).toBe('unanswered');
  });

  it('says where it stands in one line', async () => {
    const { team, jwks } = setup();
    let problem: string | null = null;
    const provider = cloudflareProvider({ jwks, log: () => {}, ingressProblem: () => problem });
    const ctx = { dashboardPort: () => 4317, ingressPort: () => 4319, publicOrigin: () => undefined };
    expect((await provider.status(toCloudflareSetting(null), ctx)).state).toBe('off');
    expect(await provider.status(toCloudflareSetting({ teamDomain: TEAM }), ctx)).toEqual({ state: 'needs-setup', sentence: 'Off. Needs the AUD tag and your email.' });
    expect(await provider.status(enabled, ctx)).toEqual({ state: 'waiting', sentence: 'Waiting for a first visit through Cloudflare.' });
    problem = 'Port 4319 is taken.';
    expect((await provider.status(enabled, ctx)).state).toBe('needs-setup');
    problem = null;
    await provider.identify(req({ 'cf-access-jwt-assertion': team.sign() }, true), enabled, T0);
    expect(await provider.status(enabled, ctx)).toEqual({ state: 'ready', sentence: `Ready at buddi.example.com, for ${OWNER_EMAIL}` });
    // The setup copy prints the real ingress port, never the dashboard's.
    const steps = provider.setup(enabled, ctx).steps.map((s) => s.command).filter(Boolean);
    expect(steps).toContain('http://127.0.0.1:4319');
    expect(steps).not.toContain('http://127.0.0.1:4317');
  });
});

describe('the setting', () => {
  it('reads anything unexpected as off, and turns on only when complete', () => {
    expect(toCloudflareSetting({ enabled: true, teamDomain: TEAM }).enabled).toBe(false);
    expect(toCloudflareSetting({ enabled: true, ...SETTING }).enabled).toBe(true);
    expect(toCloudflareSetting({ enabled: true, ...SETTING, teamDomain: 'buddi-test' }).teamDomain).toBe(TEAM);
    expect(toCloudflareSetting('nonsense').enabled).toBe(false);
  });

  it('validates what the owner typed, in sentences', () => {
    expect(validateCloudflareInput({ enabled: true, ...SETTING, publicOrigin: 'buddi.example.com' })).toEqual({
      ok: true,
      value: { enabled: true, ...SETTING, publicOrigin: 'https://buddi.example.com' },
    });
    expect(validateCloudflareInput({ enabled: true, teamDomain: TEAM, aud: '', email: '' })).toMatchObject({ ok: false, error: 'To turn this on, fill in the AUD tag and your email.' });
    expect(validateCloudflareInput({ enabled: false, teamDomain: 'example.com' })).toMatchObject({ ok: false, error: expect.stringMatching(/team domain/) });
    expect(validateCloudflareInput({ enabled: false, aud: 'short' })).toMatchObject({ ok: false, error: expect.stringMatching(/AUD tag/) });
    expect(validateCloudflareInput({ enabled: false, publicOrigin: 'http://buddi.example.com' })).toMatchObject({ ok: false, error: expect.stringMatching(/https:\/\//) });
    expect(validateCloudflareInput({ enabled: false, publicOrigin: 'https://buddi.example.com/path' })).toMatchObject({ ok: false });
    expect(validateCloudflareInput({ teamDomain: TEAM })).toMatchObject({ ok: false, error: '`enabled` must be true or false' });
  });
});
