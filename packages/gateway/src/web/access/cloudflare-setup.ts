/**
 * Cloudflare Access, "Set it up for me" (slate jxtBIbNaS-).
 *
 * With one scoped API token buddi makes, through Cloudflare's REST API, what
 * the five manual steps ask the owner to click: a tunnel named
 * `buddi-<host>`, its ingress (`<host>` → the ingress listener), a proxied
 * CNAME, a reusable Allow policy for the owner's email and a self-hosted
 * Access application for the hostname. It reads the application's AUD tag and
 * the team domain, fills in `access.cloudflare`, keeps the tunnel's connector
 * token as an owner secret and asks the supervisor to run cloudflared itself
 * (install's cloudflared.ts; no command to copy), waits for the tunnel to
 * report healthy and runs Test my setup. A system service from an earlier
 * setup (`sudo cloudflared service install`) is named, with the one line that
 * removes it, or used instead when the owner says so. Without a supervisor (a
 * checkout's `buddi serve`) the step falls back to the line to run by hand.
 *
 * Idempotent: the ids of what buddi made are kept in the setup record, so a
 * second run after a failure picks up where the first stopped. An object of
 * buddi's name that the record doesn't hold (someone else's, or a lost
 * record's) is never taken silently: the run stops with `adoptable` and the
 * owner may say "Use it anyway" (`adopt: true`, `--adopt`). Remove deletes
 * only the ids the record holds, and keeps going past a failure so one stuck
 * object does not strand the others.
 *
 * One operation at a time in a process (`claimSetupOperation`): a setup, its
 * stop and a removal never overlap, from the panel or the CLI.
 *
 * The same engine runs behind the panel (server.ts) and `buddi access
 * cloudflare setup` (the CLI): only the token store and the progress sink
 * differ.
 */
import type { CloudflareApi, CfAccessApp, CfDnsRecord } from './cloudflare-api.js';
import { CloudflareApiError, CONNECTOR_TOKEN } from './cloudflare-api.js';
import { plausibleEmail, validateCloudflareInput, type CloudflareAccessSetting } from './cloudflare.js';
import type { ConnectorControl, ConnectorState, ConnectorView } from './cloudflare-connector.js';

/** Where the record of what buddi made lives (a web setting). Ids only, never a token. */
export const CLOUDFLARE_SETUP_KEY = 'access.cloudflare.setup';
/** The owner secret holding the API token. */
export const CLOUDFLARE_TOKEN_SECRET = 'CLOUDFLARE_API_TOKEN';

export const tunnelNameFor = (host: string): string => `buddi-${host}`;
export const policyNameFor = (host: string): string => `buddi — ${host}`;
export const appNameFor = (host: string): string => `buddi (${host})`;
/** The DNS record's comment: buddi's tag on it. */
/** After the Done line: a new Access application takes a minute or two to reach Cloudflare's sign-in page. */
export const SETUP_PROPAGATION = 'Cloudflare needs a minute or two before the first sign-in works; if its page says it can’t find the application, reload.';
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

/** The connector the supervisor runs, as the step shows it. */
export interface SetupConnector {
  state: ConnectorState;
  mode: 'buddi' | 'system';
  detail?: string | undefined;
  /** The Homebrew line, when cloudflared is missing on a Mac with brew. */
  brew?: string | undefined;
  /** Cloudflare's system service is installed: the line that removes it, and why. */
  systemDaemon?: { file: string; command: string; why: string } | undefined;
  /** Where cloudflared's lines go. */
  log?: string | undefined;
}

/** Why a system service and buddi's own connector can't both run. */
export const SYSTEM_DAEMON_WHY = 'Cloudflare’s system service from an earlier setup is installed on this computer. Two connectors for one tunnel fight over its connections, so buddi doesn’t start its own while it is there. Remove it with this line, or use it instead.';

export function connectorOf(view: ConnectorView, platform: NodeJS.Platform): SetupConnector {
  return {
    state: view.state,
    mode: view.mode,
    ...(view.detail ? { detail: view.detail } : {}),
    ...(view.brew ? { brew: view.brew } : {}),
    ...(view.systemDaemon ? { systemDaemon: { file: view.systemDaemon, command: uninstallFor(platform), why: SYSTEM_DAEMON_WHY } } : {}),
    log: view.log,
  };
}

export interface SetupProgress {
  state: 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'removing' | 'removed';
  host: string;
  email: string;
  steps: SetupStep[];
  install: SetupInstall | null;
  /** The connector buddi runs (or the system service it uses), when a supervisor runs buddi. */
  connector: SetupConnector | null;
  /** The sentence for a failure, a stop or a partial removal. */
  error: string | null;
  /** The address, once it is set up. */
  url: string | null;
  /** What Remove deleted, in words. */
  removed: string[];
  /** The line that removes the connector from this computer. */
  uninstall: string | null;
  /** It stopped at an object of buddi's name that buddi didn't make: "Use it anyway" runs again with adopt. */
  adoptable: boolean;
}

export interface SetupRecord {
  host: string;
  email: string;
  zone: { id: string; name: string };
  accountId: string;
  teamDomain: string;
  /** The ids of what buddi made (or was told to use anyway). Remove deletes these and nothing else. */
  tunnelId?: string | undefined;
  dnsRecordId?: string | undefined;
  policyId?: string | undefined;
  appId?: string | undefined;
  aud?: string | undefined;
  /** Who runs the connector: buddi's supervisor (the default) or Cloudflare's system service. */
  connector?: 'buddi' | 'system' | undefined;
  at: string;
}

export interface SetupInput {
  host: string;
  email: string;
  zone?: string | undefined;
  /** "Use it anyway": take over an object of buddi's name that buddi didn't make. */
  adopt?: boolean | undefined;
  /** "Use Cloudflare’s system service instead": buddi starts no connector of its own. */
  useSystemDaemon?: boolean | undefined;
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
  /**
   * The operation lock the caller already holds (the server claims it before
   * its first await). Without one, the run claims its own and lets it go.
   */
  lease?: SetupLease | undefined;
  /**
   * The supervisor's connector. Absent (a checkout's `buddi serve`, a CLI
   * with no supervisor answering), the step shows the line to run by hand.
   */
  connector?: ConnectorControl | undefined;
}

export type SetupOperation = 'setup' | 'remove';
export interface SetupLease { readonly kind: SetupOperation; release(): void }

/** In this process, the one setup or removal going, or null. */
let operation: { kind: SetupOperation } | null = null;

/** Claim the one operation slot, synchronously; null when another holds it. */
export function claimSetupOperation(kind: SetupOperation): SetupLease | null {
  if (operation) return null;
  const mine = { kind };
  operation = mine;
  return { kind, release: () => { if (operation === mine) operation = null; } };
}

/** What holds the slot, or null. */
export const setupOperation = (): SetupOperation | null => operation?.kind ?? null;

/** The sentence for a second caller, by what is going. */
export function setupBusySentence(kind: SetupOperation | null): string {
  return kind === 'remove'
    ? 'buddi is removing what it made in Cloudflare. Wait for it to finish, then try again.'
    : 'A Cloudflare setup is already running. Wait for it, or stop it, then try again.';
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
  // The line goes into an owner's sudo: never anything but a token in it.
  if (!CONNECTOR_TOKEN.test(token)) throw new CloudflareApiError('Cloudflare answered without the tunnel’s connector token.', 200, []);
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
  connector: 'Starting the connector…',
  healthy: 'Waiting for the tunnel to connect',
  test: 'Testing the setup',
};
const ORDER: SetupStepId[] = ['token', 'tunnel', 'route', 'dns', 'access', 'save', 'connector', 'healthy', 'test'];

export function freshProgress(host = '', email = ''): SetupProgress {
  return {
    state: 'idle', host, email,
    steps: ORDER.map((id) => ({ id, state: 'next', text: LABELS[id] })),
    install: null, connector: null, error: null, url: null, removed: [], uninstall: null, adoptable: false,
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
  const lease = deps.lease ?? claimSetupOperation('setup');
  if (!lease) {
    const p = freshProgress(input.host.trim(), input.email.trim());
    p.state = 'failed';
    p.error = setupBusySentence(setupOperation());
    onProgress(structuredClone(p));
    return p;
  }
  try {
    return await setupRun(input, deps, onProgress);
  } finally {
    if (!deps.lease) lease.release();
  }
}

async function setupRun(input: SetupInput, deps: SetupDeps, onProgress: (p: SetupProgress) => void): Promise<SetupProgress> {
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
    // A record for another hostname is never overwritten: its ids are the
    // only way Remove finds what buddi made there.
    const earlier = await deps.readRecord();
    if (earlier && earlier.host !== host && (earlier.tunnelId || earlier.dnsRecordId || earlier.policyId || earlier.appId)) {
      throw new SetupError(`buddi already set up ${earlier.host}. Remove what it made first, or set up the same hostname again.`);
    }
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
    if (previous && previous.host === host) {
      Object.assign(record, { tunnelId: previous.tunnelId, dnsRecordId: previous.dnsRecordId, policyId: previous.policyId, appId: previous.appId, aud: previous.aud });
    }
    await deps.saveRecord(record);
    const adopt = input.adopt === true;
    /** Stop at an object buddi didn't make, offering "Use it anyway". */
    const notOurs = (what: string): never => {
      p.adoptable = true;
      throw new SetupError(`${what} buddi didn’t make it. Use it anyway to let buddi take it over, or delete it in Cloudflare first.`);
    };
    finish('token', `Token checked · ${zone.name} · team ${teamDomain}`);

    // 2. The tunnel.
    at('tunnel');
    const name = tunnelNameFor(host);
    let tunnel = await api.findTunnel(accountId, name);
    if (tunnel && tunnel.id !== record.tunnelId && !adopt) notOurs(`There is already a tunnel named ${name} in this Cloudflare account, and`);
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
    const pointing = records.find((r) => r.type === 'CNAME' && r.content.toLowerCase() === target);
    if (pointing) {
      if (pointing.id !== record.dnsRecordId && !adopt) notOurs(`${host} already has a DNS record to this tunnel, and`);
      record.dnsRecordId = pointing.id;
      dnsWords = `DNS record ${host} found`;
    } else {
      const others = records.filter((r) => r.id !== record.dnsRecordId);
      const foreign = others.find((r) => !ownsRecord(r));
      if (foreign) {
        throw new SetupError(`${host} already has a DNS record (${foreign.type} to ${foreign.content}). Pick another hostname, or delete that record in Cloudflare first.`);
      }
      if (others.length > 0 && !adopt) notOurs(`${host} already has a DNS record tagged as buddi’s, but`);
      // buddi's own record for an older tunnel goes; the new one replaces it.
      for (const old of records) await api.deleteDnsRecord(zone.id, old.id);
      record.dnsRecordId = (await api.createCname(zone.id, host, target, DNS_COMMENT)).id;
    }
    await deps.saveRecord(record);
    finish('dns', dnsWords);

    // 5. The Allow policy and the Access application.
    at('access');
    const policyName = policyNameFor(host);
    const allPolicies = await api.policies(accountId);
    const namedPolicy = allPolicies.find((x) => x.name === policyName);
    const ourPolicy = allPolicies.find((x) => x.id === record.policyId);
    if (namedPolicy && !ourPolicy && !adopt) notOurs(`There is already an Access policy named “${policyName}”, and`);
    const existingPolicy = ourPolicy ?? namedPolicy;
    const policy = existingPolicy
      ? await api.updatePolicy(accountId, existingPolicy.id, policyName, email)
      : await api.createPolicy(accountId, policyName, email);
    record.policyId = policy.id;
    await deps.saveRecord(record);
    const appName = appNameFor(host);
    const apps = await api.apps(accountId);
    const sameHost = apps.filter((a) => (a.domain ?? '').toLowerCase().replace(/\/.*$/, '') === host);
    const foreignApp = sameHost.find((a) => a.name !== appName && a.id !== record.appId);
    if (foreignApp) {
      throw new SetupError(`There is already an Access application for ${host} (“${foreignApp.name}”). buddi won’t change it: delete it in Cloudflare, or use “I’ll do it myself” with its AUD tag.`);
    }
    const existingApp = sameHost.find((a) => a.id === record.appId) ?? sameHost.find((a) => a.name === appName);
    if (existingApp && existingApp.id !== record.appId && !adopt) notOurs(`There is already an Access application named “${appName}” for ${host}, and`);
    const app: CfAccessApp = existingApp
      ? await api.updateApp(accountId, existingApp.id, { name: appName, domain: host, policyId: policy.id })
      : await api.createApp(accountId, { name: appName, domain: host, policyId: policy.id });
    record.appId = app.id;
    if (!app.aud) {
      await deps.saveRecord(record);
      throw new SetupError('Cloudflare made the Access application but gave no AUD tag. Try again.');
    }
    record.aud = app.aud;
    await deps.saveRecord(record);
    finish('access', `Access application · allows ${email} · 24 h sessions`);

    // 6. buddi's own setting: on, for this team, application and email.
    at('save');
    const checked = validateCloudflareInput({ enabled: true, teamDomain, aud: app.aud, email, publicOrigin: `https://${host}` });
    if (!checked.ok) throw new SetupError(checked.error);
    await deps.saveSetting(checked.value);
    finish('save', 'buddi’s settings filled in');

    // 7. The connector: the supervisor runs it, or (no supervisor) the owner does.
    at('connector');
    const connectorToken = await api.tunnelToken(accountId, tunnel.id);
    if (!CONNECTOR_TOKEN.test(connectorToken)) throw new CloudflareApiError('Cloudflare answered without the tunnel’s connector token.', 200, []);
    const control = deps.connector;
    const systemMode = input.useSystemDaemon === true;
    let view: ConnectorView | null = null;
    const look = async (): Promise<void> => {
      if (!control) return;
      try {
        view = await control.sync();
      } catch {
        view = null;
      }
      p.connector = view ? connectorOf(view, deps.platform) : null;
      const s = step('connector');
      if (s.state === 'done') return;
      const v = view as ConnectorView | null;
      s.text = !v ? 'Starting the connector… (buddi’s supervisor isn’t answering)'
        : v.mode === 'system' ? 'Using Cloudflare’s system service'
        : v.state === 'running' ? 'Connector running'
        : v.state === 'missing-binary' ? 'cloudflared isn’t on this computer'
        : v.state === 'system-daemon' ? 'Cloudflare’s system service is in the way'
        : 'Starting the connector…';
      if (v?.state === 'running' && v.mode === 'buddi') finish('connector', 'Connector running');
    };
    if (control) {
      record.connector = systemMode ? 'system' : 'buddi';
      await deps.saveRecord(record);
      await control.saveToken(connectorToken);
      // The system service runs whatever token it was installed with: the line, should it be another tunnel's.
      if (systemMode) p.install = { ...installFor(connectorToken, deps.platform), note: 'Only if the system service runs another tunnel: uninstall it (sudo cloudflared service uninstall), then install it again with this line.' };
      await look();
    } else {
      step('connector').text = 'Install the connector';
      p.install = installFor(connectorToken, deps.platform);
    }
    p.state = 'waiting';
    emit();

    // 8. Wait for the tunnel to connect.
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
      if (!deps.signal?.aborted && control) { await look(); emit(); }
    }
    if (!healthy) {
      if (deps.signal?.aborted) {
        p.state = 'stopped';
        p.error = control
          ? 'Stopped waiting. Everything buddi made stays; Set it up again to finish.'
          : 'Stopped waiting. Everything buddi made stays; run the command, then Set it up again to finish.';
        emit();
        return p;
      }
      const v = view as ConnectorView | null;
      current = !control || v?.state === 'running' || v?.mode === 'system' ? 'healthy' : 'connector';
      if (!control) throw new SetupError('The tunnel hasn’t connected yet. Run the command above on this computer, then try again.');
      if (!v) throw new SetupError('buddi’s supervisor didn’t answer, so the connector isn’t running. Restart buddi, then Set it up again.');
      if (v.mode === 'system') throw new SetupError('The tunnel hasn’t connected through Cloudflare’s system service. Check that it runs this tunnel’s token, then Set it up again.');
      if (v.state === 'system-daemon') throw new SetupError('Cloudflare’s system service is still installed. Remove it (sudo cloudflared service uninstall) or use it instead, then Set it up again.');
      if (v.state === 'missing-binary') throw new SetupError(`cloudflared isn’t on this computer and buddi couldn’t download it. ${v.brew ? `Run ${v.brew}` : 'Install it from Cloudflare’s downloads page'}, then Set it up again.`);
      throw new SetupError('The tunnel hasn’t connected yet. cloudflared’s own lines are in logs/cloudflared.log in buddi’s data folder.');
    }
    const v = view as ConnectorView | null;
    finish('connector', !control ? 'Connector installed' : v?.mode === 'system' ? 'Cloudflare’s system service connected' : 'Connector running');
    finish('healthy', 'Connected');

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
 * and the tunnel whose ids the setup record holds, and nothing found by name.
 * Each id leaves the record as its object goes, so Remove again retries only
 * what is left. Turns signing in through Cloudflare off when the setting is
 * the one setup filled in, and forgets the record. Never throws.
 */
export async function removeCloudflareSetup(
  deps: Pick<SetupDeps, 'api' | 'platform' | 'readSetting' | 'saveSetting' | 'readRecord' | 'saveRecord' | 'lease' | 'connector'> & { host?: string | undefined },
  onProgress: (p: SetupProgress) => void = () => {},
): Promise<SetupProgress> {
  const lease = deps.lease ?? claimSetupOperation('remove');
  if (!lease) {
    const p = freshProgress();
    p.state = 'failed';
    p.error = setupBusySentence(setupOperation());
    onProgress(structuredClone(p));
    return p;
  }
  try {
    return await removeRun(deps, onProgress);
  } finally {
    if (!deps.lease) lease.release();
  }
}

async function removeRun(
  deps: Pick<SetupDeps, 'api' | 'platform' | 'readSetting' | 'saveSetting' | 'readRecord' | 'saveRecord' | 'connector'> & { host?: string | undefined },
  onProgress: (p: SetupProgress) => void,
): Promise<SetupProgress> {
  const record = await deps.readRecord();
  const host = record?.host ?? (deps.host ? normalizeHost(deps.host) : null) ?? '';
  const p = freshProgress(host, record?.email ?? '');
  p.state = 'removing';
  p.steps = [];
  const emit = (): void => onProgress(structuredClone(p));
  emit();
  if (!record) {
    p.state = 'removed';
    p.error = host
      ? `buddi has no record of making anything in Cloudflare for ${host}, so it removes nothing. Delete what is there in Cloudflare by hand.`
      : 'buddi has made nothing in Cloudflare to remove.';
    emit();
    return p;
  }
  const { api } = deps;
  const failures: string[] = [];
  const gone = (error: unknown): boolean => error instanceof CloudflareApiError && error.status === 404;
  const attempt = async (what: string, key: 'appId' | 'policyId' | 'dnsRecordId' | 'tunnelId', run: (id: string) => Promise<void>): Promise<void> => {
    const id = record[key];
    if (!id) return;
    try {
      await run(id);
      p.removed.push(what);
      emit();
    } catch (error) {
      // Already deleted in Cloudflare: nothing left to remove.
      if (!gone(error)) { failures.push(`${what}: ${sentence(error)}`); return; }
    }
    record[key] = undefined;
    await deps.saveRecord(record).catch(() => undefined);
  };

  // The connector first: its token forgotten (so nothing starts it again), the child stopped, a downloaded cloudflared deleted.
  let systemDaemon = !deps.connector;
  if (deps.connector) {
    try {
      await deps.connector.forgetToken();
      const view = await deps.connector.remove();
      if (view.removedBinary) { p.removed.push('the cloudflared buddi downloaded'); emit(); }
      systemDaemon = view.systemDaemon !== null;
    } catch {
      failures.push('buddi’s connector could not be stopped; restart buddi to stop it.');
    }
  }
  const account = record.accountId;
  const zone = record.zone.id;
  await attempt('the Access application', 'appId', (id) => api.deleteApp(account, id));
  await attempt('its policy', 'policyId', (id) => api.deletePolicy(account, id));
  await attempt('the DNS record', 'dnsRecordId', (id) => api.deleteDnsRecord(zone, id));
  await attempt('the tunnel', 'tunnelId', (id) => api.deleteTunnel(account, id));

  // buddi's setting goes off when it is the one setup filled in.
  try {
    const setting = await deps.readSetting();
    if (setting.enabled && (!record.aud || setting.aud === record.aud) && setting.publicOrigin === `https://${host}`) {
      await deps.saveSetting({ ...setting, enabled: false, aud: '', teamDomain: '', publicOrigin: '' });
    }
  } catch {
    failures.push('buddi’s own setting could not be turned off; turn it off by hand.');
  }
  if (failures.length === 0) await deps.saveRecord(null).catch(() => undefined);
  p.state = 'removed';
  // Cloudflare's system service is the owner's to remove: buddi never runs sudo.
  p.uninstall = systemDaemon ? uninstallFor(deps.platform) : null;
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
