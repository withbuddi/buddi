/**
 * Cloudflare Access, "Set it up for me" (slate jxtBIbNaS-).
 *
 * With one scoped API token buddi makes, through Cloudflare's REST API, what
 * the five manual steps ask the owner to click: a tunnel named
 * `buddi-<host>`, its ingress (`<host>` → the ingress listener), a proxied
 * CNAME, a reusable Allow policy for the owner's email and a self-hosted
 * Access application for the hostname. It reads the application's AUD tag and
 * the team domain, fills in `access.cloudflare`, shows the one command buddi
 * never runs itself (`sudo cloudflared service install <token>`), waits for
 * the tunnel to report healthy and runs Test my setup.
 *
 * Idempotent: every object is found by its tag first (the tunnel's and the
 * application's name, the policy's name, the DNS record's comment) and reused,
 * so a second run after a failure picks up where the first stopped. Remove
 * deletes only what carries buddi's tag, whatever the record says, and keeps
 * going past a failure so one stuck object does not strand the others.
 *
 * The same engine runs behind the panel (server.ts) and `buddi access
 * cloudflare setup` (the CLI): only the token store and the progress sink
 * differ.
 */
import type { CloudflareApi, CfAccessApp, CfDnsRecord } from './cloudflare-api.js';
import { CloudflareApiError } from './cloudflare-api.js';
import { plausibleEmail, validateCloudflareInput, type CloudflareAccessSetting } from './cloudflare.js';

/** Where the record of what buddi made lives (a web setting). Ids only, never a token. */
export const CLOUDFLARE_SETUP_KEY = 'access.cloudflare.setup';
/** The owner secret holding the API token. */
export const CLOUDFLARE_TOKEN_SECRET = 'CLOUDFLARE_API_TOKEN';

export const tunnelNameFor = (host: string): string => `buddi-${host}`;
export const policyNameFor = (host: string): string => `buddi — ${host}`;
export const appNameFor = (host: string): string => `buddi (${host})`;
/** The DNS record's comment: buddi's tag on it. */
export const DNS_COMMENT = 'Made by buddi for Sign in from elsewhere. Remove it from buddi.';
const ownsRecord = (r: CfDnsRecord): boolean => (r.comment ?? '').startsWith('Made by buddi');

/** How often the tunnel's health is asked, and for how long. */
export const HEALTH_POLL_MS = 5_000;
export const HEALTH_WAIT_MS = 30 * 60_000;

export type SetupStepId = 'token' | 'tunnel' | 'route' | 'dns' | 'access' | 'save' | 'connector' | 'healthy' | 'test';
export type SetupStepState = 'next' | 'now' | 'done' | 'failed';

export interface SetupStep {
  id: SetupStepId;
  state: SetupStepState;
  /** The line the checklist shows. */
  text: string;
  /** Why it failed, in a sentence. */
  why?: string | undefined;
}

export interface SetupInstall {
  /** The one line to run. Holds the tunnel's connector token: shown to the owner, never logged. */
  command: string;
  /** What to say beside it: the brew path on a Mac, the package on Linux. */
  note: string;
}

export interface SetupProgress {
  state: 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'removing' | 'removed';
  host: string;
  email: string;
  steps: SetupStep[];
  install: SetupInstall | null;
  /** The sentence for a failure, a stop or a partial removal. */
  error: string | null;
  /** The address, once it is set up. */
  url: string | null;
  /** What Remove deleted, in words. */
  removed: string[];
  /** The line that removes the connector from this computer. */
  uninstall: string | null;
}

export interface SetupRecord {
  host: string;
  email: string;
  zone: { id: string; name: string };
  accountId: string;
  teamDomain: string;
  tunnelId?: string | undefined;
  aud?: string | undefined;
  at: string;
}

export interface SetupInput {
  host: string;
  email: string;
  zone?: string | undefined;
}

export interface SetupDeps {
  api: CloudflareApi;
  /** The ingress listener's port: what cloudflared points at. */
  ingressPort: number;
  platform: NodeJS.Platform;
  readSetting: () => Promise<CloudflareAccessSetting>;
  saveSetting: (value: CloudflareAccessSetting) => Promise<void>;
  readRecord: () => Promise<SetupRecord | null>;
  saveRecord: (record: SetupRecord | null) => Promise<void>;
  /** Test my setup: fetch the team's signing keys. */
  test: (teamDomain: string) => Promise<{ ok: boolean; keys: number; error?: string | undefined }>;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  pollMs?: number | undefined;
  waitMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** A hostname, lower case, or null. */
export function normalizeHost(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (value.length > 253 || !value.includes('.')) return null;
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? value : null;
}

/** The input checked: what is wrong with it, or null. */
export function checkSetupInput(input: SetupInput): string | null {
  if (normalizeHost(input.host) === null) return 'The hostname must be a name like buddi.example.com, on a domain in your Cloudflare account.';
  if (!plausibleEmail(input.email.trim())) return 'That is not an email address.';
  if (input.zone !== undefined && input.zone.trim() !== '' && normalizeHost(input.zone) === null) return 'The zone must be a domain like example.com.';
  return null;
}

/** The line to run, for this platform. */
export function installFor(token: string, platform: NodeJS.Platform): SetupInstall {
  if (platform === 'win32') {
    return { command: `cloudflared.exe service install ${token}`, note: 'Run it in a terminal opened as administrator, after installing cloudflared from Cloudflare’s downloads page.' };
  }
  if (platform === 'darwin') {
    return {
      command: `sudo cloudflared service install ${token}`,
      note: 'No cloudflared yet? brew install cloudflared first. If sudo can’t find it, use its full path: /opt/homebrew/bin/cloudflared (on an Intel Mac, /usr/local/bin/cloudflared).',
    };
  }
  return {
    command: `sudo cloudflared service install ${token}`,
    note: 'No cloudflared yet? Install it from Cloudflare’s .deb or its package repository first.',
  };
}

export function uninstallFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe service uninstall' : 'sudo cloudflared service uninstall';
}

const LABELS: Record<SetupStepId, string> = {
  token: 'Checking the token',
  tunnel: 'Creating the tunnel',
  route: 'Routing the hostname',
  dns: 'Adding the DNS record',
  access: 'Creating the Access application',
  save: 'Filling in buddi’s settings',
  connector: 'Install the connector',
  healthy: 'Waiting for the tunnel to connect',
  test: 'Testing the setup',
};
const ORDER: SetupStepId[] = ['token', 'tunnel', 'route', 'dns', 'access', 'save', 'connector', 'healthy', 'test'];

export function freshProgress(host = '', email = ''): SetupProgress {
  return {
    state: 'idle', host, email,
    steps: ORDER.map((id) => ({ id, state: 'next', text: LABELS[id] })),
    install: null, error: null, url: null, removed: [], uninstall: null,
  };
}

function sentence(error: unknown): string {
  if (error instanceof CloudflareApiError || error instanceof SetupError) return error.message;
  // Anything else is a defect, and its message may hold anything: say little.
  return 'Something went wrong talking to Cloudflare. Try again; nothing buddi made is lost.';
}

class SetupError extends Error {}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Run the setup. Never throws: the progress it ends on says how it went.
 * `onProgress` gets a copy at every change.
 */
export async function runCloudflareSetup(input: SetupInput, deps: SetupDeps, onProgress: (p: SetupProgress) => void = () => {}): Promise<SetupProgress> {
  const host = normalizeHost(input.host) ?? input.host.trim();
  const email = input.email.trim();
  const p = freshProgress(host, email);
  p.state = 'running';
  const emit = (): void => onProgress(structuredClone(p));
  const step = (id: SetupStepId) => p.steps.find((s) => s.id === id)!;
  const begin = (id: SetupStepId): void => { const s = step(id); s.state = 'now'; s.text = LABELS[id]; emit(); };
  const finish = (id: SetupStepId, text: string): void => { const s = step(id); s.state = 'done'; s.text = text; emit(); };
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => new Date());
  let current: SetupStepId = 'token';
  const at = (id: SetupStepId): void => { current = id; begin(id); };

  const invalid = checkSetupInput(input);
  if (invalid) {
    const s = step('token');
    s.state = 'failed';
    s.why = invalid;
    p.state = 'failed';
    p.error = invalid;
    emit();
    return p;
  }

  try {
    const { api } = deps;
    // 1. The token, and the zone and account it reaches.
    at('token');
    await api.verifyToken();
    const zones = await api.zones();
    const wanted = input.zone?.trim() ? normalizeHost(input.zone) : null;
    const candidates = zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`));
    const zone = wanted
      ? candidates.find((z) => z.name === wanted)
      : candidates.sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) {
      if (wanted && zones.some((z) => z.name === wanted)) throw new SetupError(`${host} is not a name on ${wanted}.`);
      if (zones.length === 0) throw new SetupError(`The token can’t see any domain. Give it ${'Zone · DNS · Edit'} on the zone of ${host}, then try again.`);
      throw new SetupError(`None of the domains this token can edit holds ${host}. It can edit ${zones.slice(0, 5).map((z) => z.name).join(', ')}${zones.length > 5 ? ', …' : ''}.`);
    }
    const accountId = zone.account.id;
    let teamDomain: string;
    try {
      teamDomain = await api.teamDomain(accountId);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) {
        throw new SetupError('Zero Trust isn’t set up on this Cloudflare account yet. Open Zero Trust in Cloudflare’s dashboard once and pick a team name, then try again.');
      }
      throw error;
    }
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
      throw new SetupError('Zero Trust isn’t set up on this Cloudflare account yet. Open Zero Trust in Cloudflare’s dashboard once and pick a team name, then try again.');
    }
    const record: SetupRecord = { host, email, zone: { id: zone.id, name: zone.name }, accountId, teamDomain, at: now().toISOString() };
    const previous = await deps.readRecord();
    if (previous && previous.host === host) Object.assign(record, { tunnelId: previous.tunnelId, aud: previous.aud });
    await deps.saveRecord(record);
    finish('token', `Token checked · ${zone.name} · team ${teamDomain}`);

    // 2. The tunnel.
    at('tunnel');
    const name = tunnelNameFor(host);
    let tunnel = await api.findTunnel(accountId, name);
    const reusedTunnel = tunnel !== null;
    tunnel ??= await api.createTunnel(accountId, name);
    record.tunnelId = tunnel.id;
    await deps.saveRecord(record);
    finish('tunnel', `Tunnel ${name} ${reusedTunnel ? 'found' : 'created'}`);

    // 3. Its ingress: the hostname to the ingress listener, nothing else.
    at('route');
    const service = `http://127.0.0.1:${deps.ingressPort}`;
    await api.putTunnelConfig(accountId, tunnel.id, host, service);
    finish('route', `${host} → ${service}`);

    // 4. DNS: a proxied CNAME to the tunnel.
    at('dns');
    const target = `${tunnel.id}.cfargotunnel.com`;
    const records = (await api.dnsRecords(zone.id, host)).filter((r) => r.name.toLowerCase() === host);
    let dnsWords = `DNS record ${host} added`;
    const mine = records.find((r) => r.type === 'CNAME' && r.content.toLowerCase() === target);
    if (mine) {
      dnsWords = `DNS record ${host} found`;
    } else {
      const foreign = records.find((r) => !ownsRecord(r));
      if (foreign) {
        throw new SetupError(`${host} already has a DNS record (${foreign.type} to ${foreign.content}). Pick another hostname, or delete that record in Cloudflare first.`);
      }
      // buddi's own record for an older tunnel goes; the new one replaces it.
      for (const old of records) await api.deleteDnsRecord(zone.id, old.id);
      await api.createCname(zone.id, host, target, DNS_COMMENT);
    }
    finish('dns', dnsWords);

    // 5. The Allow policy and the Access application.
    at('access');
    const policyName = policyNameFor(host);
    const existingPolicy = (await api.policies(accountId)).find((x) => x.name === policyName);
    const policy = existingPolicy
      ? await api.updatePolicy(accountId, existingPolicy.id, policyName, email)
      : await api.createPolicy(accountId, policyName, email);
    const appName = appNameFor(host);
    const apps = await api.apps(accountId);
    const sameHost = apps.filter((a) => (a.domain ?? '').toLowerCase().replace(/\/.*$/, '') === host);
    const foreignApp = sameHost.find((a) => a.name !== appName);
    if (foreignApp) {
      throw new SetupError(`There is already an Access application for ${host} (“${foreignApp.name}”). buddi won’t change it: delete it in Cloudflare, or use “I’ll do it myself” with its AUD tag.`);
    }
    const existingApp = sameHost.find((a) => a.name === appName);
    const app: CfAccessApp = existingApp
      ? await api.updateApp(accountId, existingApp.id, { name: appName, domain: host, policyId: policy.id })
      : await api.createApp(accountId, { name: appName, domain: host, policyId: policy.id });
    if (!app.aud) throw new SetupError('Cloudflare made the Access application but gave no AUD tag. Try again.');
    record.aud = app.aud;
    await deps.saveRecord(record);
    finish('access', `Access application · allows ${email} · 24 h sessions`);

    // 6. buddi's own setting: on, for this team, application and email.
    at('save');
    const checked = validateCloudflareInput({ enabled: true, teamDomain, aud: app.aud, email, publicOrigin: `https://${host}` });
    if (!checked.ok) throw new SetupError(checked.error);
    await deps.saveSetting(checked.value);
    finish('save', 'buddi’s settings filled in');

    // 7. The one command buddi does not run.
    at('connector');
    p.install = installFor(await api.tunnelToken(accountId, tunnel.id), deps.platform);
    p.state = 'waiting';
    emit();

    // 8. Wait for cloudflared to connect.
    const deadline = now().getTime() + (deps.waitMs ?? HEALTH_WAIT_MS);
    let healthy = false;
    let first = true;
    while (!deps.signal?.aborted) {
      const status = (await api.tunnel(accountId, tunnel.id)).status ?? '';
      if (status === 'healthy' || status === 'degraded') { healthy = true; break; }
      if (first) {
        first = false;
        step('healthy').state = 'now';
        emit();
      }
      if (now().getTime() >= deadline) break;
      await sleep(deps.pollMs ?? HEALTH_POLL_MS, deps.signal);
    }
    if (!healthy) {
      if (deps.signal?.aborted) {
        p.state = 'stopped';
        p.error = 'Stopped waiting. Everything buddi made stays; run the command, then Set it up again to finish.';
        emit();
        return p;
      }
      current = 'healthy';
      throw new SetupError('The tunnel hasn’t connected yet. Run the command above on this computer, then try again.');
    }
    finish('connector', 'Connector installed');
    finish('healthy', 'Tunnel connected');

    // 9. Test my setup.
    at('test');
    const tested = await deps.test(teamDomain);
    if (!tested.ok) throw new SetupError(tested.error ?? 'Cloudflare’s signing keys could not be fetched.');
    finish('test', `${teamDomain} answered with ${tested.keys} signing key${tested.keys === 1 ? '' : 's'}`);
    p.state = 'done';
    p.url = `https://${host}`;
    emit();
    return p;
  } catch (error) {
    const s = step(current);
    s.state = 'failed';
    s.why = sentence(error);
    p.state = 'failed';
    p.error = s.why;
    emit();
    return p;
  }
}

/**
 * Remove what buddi made: the Access application and policy, the DNS record
 * and the tunnel, each only when it carries buddi's tag. Turns signing in
 * through Cloudflare off when the setting is the one setup filled in, and
 * forgets the record. Never throws.
 */
export async function removeCloudflareSetup(
  deps: Pick<SetupDeps, 'api' | 'platform' | 'readSetting' | 'saveSetting' | 'readRecord' | 'saveRecord'> & { host?: string | undefined },
  onProgress: (p: SetupProgress) => void = () => {},
): Promise<SetupProgress> {
  const record = await deps.readRecord();
  const host = record?.host ?? (deps.host ? normalizeHost(deps.host) : null) ?? '';
  const p = freshProgress(host, record?.email ?? '');
  p.state = 'removing';
  p.steps = [];
  const emit = (): void => onProgress(structuredClone(p));
  emit();
  if (!host) {
    p.state = 'removed';
    p.error = 'buddi has made nothing in Cloudflare to remove.';
    emit();
    return p;
  }
  const { api } = deps;
  const failures: string[] = [];
  const attempt = async (what: string, run: () => Promise<boolean>): Promise<void> => {
    try {
      if (await run()) { p.removed.push(what); emit(); }
    } catch (error) {
      failures.push(`${what}: ${sentence(error)}`);
    }
  };

  let zoneId = record?.zone.id;
  let accountId = record?.accountId;
  if (!zoneId || !accountId) {
    try {
      const zone = (await api.zones()).filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      zoneId = zone?.id;
      accountId = zone?.account.id;
    } catch (error) {
      failures.push(sentence(error));
    }
  }
  if (accountId) {
    const account = accountId;
    await attempt('the Access application', async () => {
      const apps = (await api.apps(account)).filter((a) => a.name === appNameFor(host));
      for (const app of apps) await api.deleteApp(account, app.id);
      return apps.length > 0;
    });
    await attempt('its policy', async () => {
      const policies = (await api.policies(account)).filter((x) => x.name === policyNameFor(host));
      for (const policy of policies) await api.deletePolicy(account, policy.id);
      return policies.length > 0;
    });
  }
  if (zoneId) {
    const zone = zoneId;
    await attempt('the DNS record', async () => {
      const records = (await api.dnsRecords(zone, host)).filter((r) => r.name.toLowerCase() === host && ownsRecord(r));
      for (const r of records) await api.deleteDnsRecord(zone, r.id);
      return records.length > 0;
    });
  }
  if (accountId) {
    const account = accountId;
    await attempt('the tunnel', async () => {
      const tunnel = await api.findTunnel(account, tunnelNameFor(host));
      if (!tunnel) return false;
      await api.deleteTunnel(account, tunnel.id);
      return true;
    });
  }

  // buddi's setting goes off when it is the one setup filled in.
  try {
    const setting = await deps.readSetting();
    if (setting.enabled && (!record?.aud || setting.aud === record.aud) && setting.publicOrigin === `https://${host}`) {
      await deps.saveSetting({ ...setting, enabled: false, aud: '', teamDomain: '', publicOrigin: '' });
    }
  } catch {
    failures.push('buddi’s own setting could not be turned off; turn it off by hand.');
  }
  if (failures.length === 0) await deps.saveRecord(null).catch(() => undefined);
  p.state = 'removed';
  p.uninstall = uninstallFor(deps.platform);
  p.error = failures.length ? `Some of it is still there. ${failures.join(' ')} Try Remove again.` : null;
  emit();
  return p;
}

/** "a, b and c". */
export function removedInWords(items: string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
