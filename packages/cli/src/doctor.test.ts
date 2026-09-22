import { describe, expect, it } from 'vitest';
import { DB_UNREACHABLE, DOCKER_DOWN } from './db-cmd.js';
import {
  checkAgents,
  checkDatabaseExposure,
  checkEmail,
  checkNodeVersion,
  checkPlugins,
  checkRecovery,
  checkTailscale,
  checkVault,
  collectChecks,
  exitCodeFor,
  renderTable,
  summarize,
  type DoctorProbes,
  type ProbeResult,
  type VaultFacts,
} from './doctor.js';

const ok = (detail = 'fine'): ProbeResult => ({ status: 'ok', detail });

/** Every probe green; a test overrides only the one it is about. */
function fakeProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: () => ok('v22.10.0'),
    pnpmVersion: async () => ok('11.0.0'),
    dockerVersion: async () => ok('Docker version 29'),
    postgres: async () => ok('PostgreSQL 16'),
    migrations: async () => ok('6 applied, none pending'),
    vault: async () => ok('keychain — from the vault: ANTHROPIC_API_KEY'),
    modelCredential: async () => ok('api-key accepted'),
    agents: async () => ok('5 agents — 5 anthropic (claude-sonnet-5)'),
    botToken: async () => ok('@buddi_bot'),
    pairedDevices: async () => ok('telegram:phone'),
    queue: async () => ok('running — 0 pending, 0 running, 0 suspended, 0 failed, 3 succeeded'),
    dashboard: async () => ok('http://127.0.0.1:4317/ — token in the keychain'),
    service: async () => ok('launchd: running (pid 1)'),
    timezone: () => ok('Europe/Paris (BUDDI_TZ)'),
    ...overrides,
  };
}

describe('collectChecks', () => {
  it('returns one row per check, in a stable order', async () => {
    const checks = await collectChecks(fakeProbes());
    expect(checks.map((c) => c.name)).toEqual([
      'node',
      'pnpm',
      'docker',
      'postgres',
      'migrations',
      'vault',
      'model credential',
      'agents',
      'telegram bot',
      'paired devices',
      'queue',
      'dashboard',
      'service',
      'timezone',
    ]);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('marks the checks the installation cannot work without as critical', async () => {
    const checks = await collectChecks(fakeProbes());
    const critical = checks.filter((c) => c.critical).map((c) => c.name);
    expect(critical).toEqual([
      'node',
      'pnpm',
      'postgres',
      'migrations',
      'vault',
      'model credential',
      'agents',
    ]);
  });

  it('turns a probe that throws into a failed check rather than crashing', async () => {
    const checks = await collectChecks(
      fakeProbes({
        postgres: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:5432');
        },
      }),
    );
    const pg = checks.find((c) => c.name === 'postgres');
    expect(pg).toMatchObject({ status: 'fail', detail: 'ECONNREFUSED 127.0.0.1:5432' });
    // …and the checks after it still ran.
    expect(checks.find((c) => c.name === 'timezone')?.status).toBe('ok');
  });
});

describe('exitCodeFor', () => {
  it('is 0 when everything passes', async () => {
    expect(exitCodeFor(await collectChecks(fakeProbes()))).toBe(0);
  });

  it('is 0 when only non-critical checks fail', async () => {
    const checks = await collectChecks(
      fakeProbes({ botToken: async () => ({ status: 'fail', detail: 'unauthorized' }) }),
    );
    expect(exitCodeFor(checks)).toBe(0);
  });

  it('is 1 when a critical check fails', async () => {
    const checks = await collectChecks(
      fakeProbes({ migrations: async () => ({ status: 'fail', detail: '1 pending' }) }),
    );
    expect(exitCodeFor(checks)).toBe(1);
  });

  it('is 0 for a warning on a critical check — a warning is not a failure', async () => {
    const checks = await collectChecks(
      fakeProbes({
        modelCredential: async () => ({ status: 'warn', detail: '/v1/models refuses oauth' }),
      }),
    );
    expect(exitCodeFor(checks)).toBe(0);
  });
});

describe('summarize', () => {
  it('names the critical failures', async () => {
    const checks = await collectChecks(
      fakeProbes({
        postgres: async () => ({ status: 'fail', detail: 'down' }),
        migrations: async () => ({ status: 'fail', detail: 'unknown' }),
      }),
    );
    expect(summarize(checks)).toContain('postgres, migrations');
  });

  it('says so when everything is in place', async () => {
    expect(summarize(await collectChecks(fakeProbes()))).toBe('everything checks out');
  });

  it('separates "works but look at this" from "broken"', async () => {
    const checks = await collectChecks(
      fakeProbes({ service: async () => ({ status: 'warn', detail: 'not installed' }) }),
    );
    expect(summarize(checks)).toMatch(/everything critical is in place; 1 thing/);
  });
});

describe('renderTable', () => {
  it('aligns the names and marks each status', async () => {
    const table = renderTable(
      await collectChecks(
        fakeProbes({ service: async () => ({ status: 'warn', detail: 'not installed' }) }),
      ),
    );
    expect(table).toContain('ok    node              v22.10.0');
    expect(table).toContain('warn  service           not installed');
  });
});

describe('checkNodeVersion', () => {
  it('accepts 22 and newer', () => {
    expect(checkNodeVersion('22.10.0').status).toBe('ok');
    expect(checkNodeVersion('v26.7.0').status).toBe('ok');
  });

  it('fails an older runtime and says what is needed', () => {
    const result = checkNodeVersion('20.11.1');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Node 22');
  });
});

describe('checkVault', () => {
  const facts = (over: Partial<VaultFacts> = {}): VaultFacts => ({
    vault: 'keychain',
    sources: { CLAUDE_CODE_OAUTH_TOKEN: 'vault', TELEGRAM_BOT_TOKEN: 'env' },
    problems: {},
    ...over,
  });

  it('names which secrets came from the vault and which from .env', () => {
    const row = checkVault(facts());
    expect(row.status).toBe('ok');
    expect(row.detail).toBe(
      'keychain — from the vault: CLAUDE_CODE_OAUTH_TOKEN; from .env: TELEGRAM_BOT_TOKEN',
    );
  });

  it('fails on a locked vault, and says so before anything else', () => {
    const row = checkVault(
      facts({
        sources: {},
        problems: {
          CLAUDE_CODE_OAUTH_TOKEN: { code: 'vault-locked', message: 'the keychain is locked' },
        },
      }),
    );
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/locked/);
  });

  it('fails when no model credential resolved anywhere', () => {
    const row = checkVault(facts({ sources: { TELEGRAM_BOT_TOKEN: 'env' } }));
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/no model credential/);
  });

  it('does not fail over an optional secret nobody set', () => {
    const row = checkVault(
      facts({
        sources: { ANTHROPIC_API_KEY: 'vault' },
        problems: { GMAIL_APP_PASSWORD: { code: 'missing-secret', message: 'not set' } },
      }),
    );
    expect(row.status).toBe('ok');
  });
});


/**
 * The shape of a machine that has just rebooted with Docker Desktop closed:
 * the daemon is down, so the database is down, so everything under it is.
 * The table has to make the *cause* obvious and stay quiet about the rest.
 */
describe('the table when Docker is not running', () => {
  const dockerDown = (): Partial<DoctorProbes> => ({
    dockerVersion: async () => ({ status: 'fail', detail: `${DOCKER_DOWN} — then \`buddi db up\`` }),
    postgres: async () => ({
      status: 'fail',
      detail: 'database not reachable at localhost:55433 — is Docker running? try: buddi db up',
    }),
    migrations: async () => ({ status: 'fail', detail: DB_UNREACHABLE }),
    queue: async () => ({ status: 'warn', detail: DB_UNREACHABLE }),
    pairedDevices: async () => ({ status: 'warn', detail: DB_UNREACHABLE }),
    service: async () => ({
      status: 'warn',
      detail: 'launchd: loaded but not running — `buddi service start` (logs: `buddi service logs`)',
    }),
  });

  it('fails the docker row with the command that fixes it', async () => {
    const checks = await collectChecks(fakeProbes(dockerDown()));
    const docker = checks.find((c) => c.name === 'docker');
    expect(docker?.status).toBe('fail');
    expect(docker?.detail).toContain('Docker is not running (open -a Docker)');
  });

  it('says the database is unreachable once, and skips the rows under it', async () => {
    const checks = await collectChecks(fakeProbes(dockerDown()));
    expect(checks.find((c) => c.name === 'postgres')?.detail).toBe(
      'database not reachable at localhost:55433 — is Docker running? try: buddi db up',
    );
    for (const name of ['migrations', 'queue', 'paired devices']) {
      expect(checks.find((c) => c.name === name)?.detail).toBe('skipped: database unreachable');
    }
    // Nothing in the table is a stack trace or a bare AggregateError.
    expect(renderTable(checks)).not.toMatch(/AggregateError|\bat \//);
  });

  it('points at `buddi service start` when the plist is loaded but dead', async () => {
    const checks = await collectChecks(fakeProbes(dockerDown()));
    expect(checks.find((c) => c.name === 'service')?.detail).toContain('buddi service start');
  });

  it('exits 1, because postgres and migrations are critical', async () => {
    const checks = await collectChecks(fakeProbes(dockerDown()));
    expect(exitCodeFor(checks)).toBe(1);
    expect(summarize(checks)).toContain('postgres');
  });
});

describe('the agents row', () => {
  const agent = (over: Partial<Parameters<typeof checkAgents>[0][number]> = {}) => ({
    id: 'ledger',
    handle: 'ledger',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    available: true,
    isDefault: false,
    ...over,
  });

  it('summarises the engines, grouped by provider and model', () => {
    const row = checkAgents([
      agent({ id: 'a', handle: 'a', isDefault: true }),
      agent({ id: 'b', handle: 'b' }),
      agent({ id: 'c', handle: 'c' }),
      agent({ id: 'd', handle: 'd' }),
      agent({
        id: 'scout',
        handle: 'scout',
        provider: 'openai',
        model: 'gpt-5',
        available: false,
        reason: 'environment variable OPENAI_API_KEY is not set',
      }),
    ]);
    expect(row.detail).toContain('5 agents');
    expect(row.detail).toContain('4 anthropic (claude-sonnet-5)');
    expect(row.detail).toContain(
      '1 openai (gpt-5, unavailable: environment variable OPENAI_API_KEY is not set)',
    );
    // One agent on a provider this machine cannot reach is a warning, never a
    // failed installation: the other four still run.
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('@scout');
  });

  it('FAILS only when the default agent cannot run', () => {
    const row = checkAgents([
      agent({ isDefault: true, available: false, reason: 'ANTHROPIC_API_KEY is not set' }),
      agent({ id: 'other', handle: 'other' }),
    ]);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('the default agent @ledger cannot run');
  });

  /*
   * A plugin that is not installed is a state of the installation, not a
   * broken one: the gateway starts, every other agent runs, and the owner
   * fixes it from one page. So the row *names* the held-back agents and warns
   * — even when the default one is among them, which is exactly the case that
   * used to take `buddi doctor` down with the catalog.
   */
  it('warns about a held-back agent and never fails on one', () => {
    const row = checkAgents([
      agent({ isDefault: true }),
      agent({
        id: 'ledger-2',
        handle: 'credo',
        available: false,
        heldBack: true,
        reason: 'Needs the finance plugin.',
      }),
    ]);
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('@credo held back until the plugin they grant is installed');
    expect(row.detail).toContain('Needs the finance plugin.');
    // Not reported as a credential problem: nothing is wrong with the engine.
    expect(row.detail).not.toContain('unavailable: Needs');
    expect(row.detail).not.toContain('cannot run here');
  });

  it('still only warns when the DEFAULT agent is the held-back one', () => {
    const row = checkAgents([
      agent({ isDefault: true, available: false, heldBack: true, reason: 'Needs the finance plugin.' }),
      agent({ id: 'other', handle: 'other' }),
    ]);
    expect(row.status).toBe('warn');
    expect(row.detail).not.toContain('the default agent @ledger cannot run');
  });

  it('is ok when everything installed can run, and names who answers by default', () => {
    expect(checkAgents([agent({ isDefault: true })]).status).toBe('ok');
    expect(checkAgents([agent({ isDefault: true })]).detail).toBe(
      '1 agent — 1 anthropic (claude-sonnet-5); default @ledger',
    );
  });

  /*
   * Files disagreeing about the default is a *configuration*, not a broken
   * installation: the record settles it, somebody answers, and the row says
   * what the owner should go and fix.
   */
  it('warns, and never fails, when the agent files disagree about the default', () => {
    const row = checkAgents([agent({ isDefault: true })], {
      code: 'multiple-defaults',
      message: 'a and b both declare "default: true" in their files.',
    });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('both declare');
  });

  it('fails an installation with no agents at all', () => {
    expect(checkAgents([]).status).toBe('fail');
  });
});

/* ------------------------------------------------------------------ *
 * database exposure
 * ------------------------------------------------------------------ */

describe('checkDatabaseExposure', () => {
  const secure = {
    composeManaged: true,
    published: '127.0.0.1:55433',
    legacyPassword: false,
    passwordInVault: true,
  };

  it('passes on a loopback binding with a real password', () => {
    const row = checkDatabaseExposure(secure);
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('127.0.0.1:55433');
    expect(row.detail).toContain('loopback');
  });

  it('accepts every spelling of loopback docker prints', () => {
    for (const published of ['127.0.0.1:5432', 'localhost:5432', '[::1]:5432', '127.1.2.3:5432']) {
      expect(checkDatabaseExposure({ ...secure, published }).status).toBe('ok');
    }
  });

  it('FAILS when the port is published on 0.0.0.0', () => {
    // The real exposure: `"${BUDDI_DB_PORT:-5432}:5432"` with no host, which
    // docker reads as every interface on the machine.
    const row = checkDatabaseExposure({ ...secure, published: '0.0.0.0:55433' });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('0.0.0.0:55433');
    expect(row.detail).toContain('NOT loopback');
    expect(row.detail).toContain('buddi db secure');
    // The binding is only fixed by re-creating the container, so say so.
    expect(row.detail).toContain('buddi db down && buddi db up');
  });

  it('FAILS on the IPv6 wildcard too', () => {
    expect(checkDatabaseExposure({ ...secure, published: '[::]:55433' }).status).toBe('fail');
  });

  it('FAILS when the password is the literal `buddi`', () => {
    const row = checkDatabaseExposure({ ...secure, legacyPassword: true, passwordInVault: false });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('literal `buddi`');
    expect(row.detail).toContain('buddi db secure');
  });

  it('FAILS when compose expects a password the vault does not hold', () => {
    const row = checkDatabaseExposure({ ...secure, passwordInVault: false });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('BUDDI_DB_PASSWORD');
    expect(row.detail).toContain('buddi db secure');
  });

  it('reports both problems at once when both are true', () => {
    const row = checkDatabaseExposure({
      composeManaged: true,
      published: '0.0.0.0:55433',
      legacyPassword: true,
      passwordInVault: false,
    });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('NOT loopback');
    expect(row.detail).toContain('literal `buddi`');
  });

  it('warns rather than guesses when the docker daemon is unreachable', () => {
    // Nothing can be said about a binding that cannot be read — but a secured
    // password is still a secured password, so this is not a failure.
    const row = checkDatabaseExposure({
      composeManaged: true,
      bindingError: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      legacyPassword: false,
      passwordInVault: true,
    });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('Cannot connect to the Docker daemon');
  });

  it('still FAILS on the shipped password with the daemon down', () => {
    const row = checkDatabaseExposure({
      composeManaged: true,
      bindingError: 'Cannot connect to the Docker daemon',
      legacyPassword: true,
      passwordInVault: false,
    });
    expect(row.status).toBe('fail');
  });

  it("says nothing about someone else's postgres", () => {
    const row = checkDatabaseExposure({
      composeManaged: false,
      legacyPassword: false,
      passwordInVault: false,
    });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('your own postgres');
  });

  it('is a critical row: a failure makes `buddi doctor` exit 1', async () => {
    const checks = await collectChecks(
      fakeProbes({
        databaseExposure: async () =>
          checkDatabaseExposure({ ...secure, published: '0.0.0.0:5432' }),
      }),
    );
    const row = checks.find((c) => c.name === 'database exposure');
    expect(row?.critical).toBe(true);
    expect(exitCodeFor(checks)).toBe(1);
  });
});


describe('the email row', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const account = {
    address: 'owner@example.test',
    enabled: true,
    secretName: 'GMAIL_APP_PASSWORD',
    secretPresent: true,
    lastSyncAt: '2026-09-21T11:00:00Z',
  };

  it('says so plainly when no mailbox is configured', () => {
    const row = checkEmail([], now);
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('no mailbox configured');
  });

  it('names every account, its secret and when mail last landed', () => {
    const row = checkEmail(
      [
        account,
        {
          address: 'owner@work.test',
          enabled: true,
          secretName: 'EMAIL_OWNER_WORK_TEST',
          secretPresent: true,
          lastSyncAt: null,
        },
      ],
      now,
    );
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('2 account(s)');
    expect(row.detail).toContain('owner@example.test [GMAIL_APP_PASSWORD] last mail 1h ago');
    expect(row.detail).toContain('owner@work.test [EMAIL_OWNER_WORK_TEST] never synced');
  });

  /**
   * The state a single-account row could never show: one mailbox polling
   * happily while another has had no password since the vault was rebuilt.
   */
  it('warns, and names which mailbox, when a password is not there', () => {
    const row = checkEmail(
      [account, { address: 'owner@work.test', enabled: true, secretName: 'EMAIL_OWNER_WORK_TEST', secretPresent: false, lastSyncAt: null }],
      now,
    );
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('EMAIL_OWNER_WORK_TEST MISSING');
    expect(row.detail).toContain('owner@work.test cannot open');
    expect(row.detail).toContain('Settings → Email');
  });

  it('says a disabled mailbox is off rather than silent, and does not warn about it', () => {
    const row = checkEmail([{ ...account, enabled: false, secretPresent: false }], now);
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('disabled');
  });
});

describe('the plugins row', () => {
  const record = '/home/o/.buddi/plugins.json';

  it('is quiet, and still names the record, when nothing is installed', () => {
    const row = checkPlugins({ record, loaded: [], problems: [] });
    expect(row.status).toBe('ok');
    expect(row.detail).toBe(`none installed beyond what this build ships (${record})`);
  });

  it('names what is installed and says it loaded', () => {
    const row = checkPlugins({
      record,
      loaded: [
        { name: 'weather', version: '0.2.0' },
        { name: 'trains', version: '1.0.0' },
      ],
      problems: [],
    });
    expect(row.status).toBe('ok');
    expect(row.detail).toBe('2 installed, all loaded: weather@0.2.0, trains@1.0.0');
  });

  /**
   * The state the doctor never asked about: a plugin in the record whose entry
   * point will not import. Its tools are gone from every agent that was granted
   * them, and until now `buddi plugins list` was the only place that said so.
   */
  it('fails the row — but not the installation — when one did not load', () => {
    const row = checkPlugins({
      record,
      loaded: [{ name: 'trains', version: '1.0.0' }],
      problems: [
        { name: 'weather', message: 'its entry point is not on disk any more (/p/dist/index.js)' },
      ],
    });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('2 installed, 1 did not load');
    expect(row.detail).toContain('weather (its entry point is not on disk any more');
    expect(row.detail).toContain('loaded: trains@1.0.0');
    expect(row.detail).toContain('buddi plugins list');
  });

  it('names where each one came from, when the record says', () => {
    const row = checkPlugins({
      record,
      loaded: [{ name: 'weather', version: '0.2.0', source: 'npm buddi-plugin-weather@0.2.0' }],
      problems: [],
    });
    expect(row.detail).toContain('weather@0.2.0 (npm buddi-plugin-weather@0.2.0)');
  });

  /**
   * The row the recorded hash exists for. The plugin still loads and still
   * works; what it is not is what the owner approved, and a plugin runs with
   * everything buddi can do. A warning, named, never a silent pass.
   */
  it('warns when a plugin no longer hashes to what was approved', () => {
    const row = checkPlugins({
      record,
      loaded: [{ name: 'weather', version: '0.2.0' }],
      problems: [],
      changed: [{ name: 'weather', message: 'weather changed on disk since it was approved.' }],
    });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('weather changed on disk since it was approved');
  });

  it('is never critical: a broken plugin does not make the installation broken', async () => {
    const checks = await collectChecks(
      fakeProbes({
        plugins: async () => checkPlugins({ record, loaded: [], problems: [{ name: 'w', message: 'boom' }] }),
      }),
    );
    const row = checks.find((c) => c.name === 'plugins');
    expect(row).toBeDefined();
    expect(row?.critical).toBe(false);
    expect(row?.status).toBe('fail');
    expect(exitCodeFor(checks)).toBe(0);
    expect(summarize(checks)).toContain('1 thing(s) to look at');
  });

  it('is skipped entirely by a caller whose probes predate it', async () => {
    const checks = await collectChecks(fakeProbes());
    expect(checks.some((c) => c.name === 'plugins')).toBe(false);
  });
});

describe('the recovery row', () => {
  it('is quiet when the installation was never restored', () => {
    expect(checkRecovery({ active: false })).toEqual({ status: 'ok', detail: 'not in recovery' });
  });

  it('says since when, and what is asleep', () => {
    const result = checkRecovery({
      active: true,
      restoredAt: new Date('2026-09-14T03:30:00.000Z'),
      archive: 'buddi-backup-20260913-033000.tar.gz',
      pending: { jobs: 11, missions: 2, approvals: 1, grants: 4 },
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('in recovery since 2026-09-14 03:30');
    expect(result.detail).toContain('buddi-backup-20260913-033000.tar.gz');
    expect(result.detail).toContain('11 queued job(s)');
  });

  it('says so plainly when the database could not be asked', () => {
    expect(checkRecovery({ active: false, unknown: true }).status).toBe('warn');
  });
});

describe('the tailscale row', () => {
  const SERVING = { checked: true, routesGateway: true };

  it('is quiet, and says whether a daemon is here, while the setting is off', () => {
    const row = checkTailscale({ daemon: { reachable: true, self: 'owner@example.com' }, setting: null, gatewayPort: 4317, serve: SERVING });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('off');
    expect(row.detail).toContain('tailscaled is running as owner@example.com');
  });

  it('names who may sign in, and where it is published', () => {
    const row = checkTailscale({
      daemon: { reachable: true, self: 'owner@example.com' },
      setting: { enabled: true, login: 'owner@example.com' },
      publicOrigin: 'https://buddi.tail1234.ts.net:9443',
      gatewayPort: 4317,
      serve: SERVING,
    });
    expect(row).toEqual({ status: 'ok', detail: 'on for owner@example.com; tailscaled is running as owner@example.com; published at https://buddi.tail1234.ts.net:9443; serve forwards to 127.0.0.1:4317' });
  });

  it('warns when it is on but nothing forwards to the gateway', () => {
    const row = checkTailscale({
      daemon: { reachable: true, self: 'owner@example.com' },
      setting: { enabled: true, login: 'owner@example.com' },
      publicOrigin: 'https://buddi.tail1234.ts.net:9443',
      gatewayPort: 4317,
      serve: { checked: true, routesGateway: false },
    });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('serve forwards nothing to 127.0.0.1:4317');
  });

  it('warns when it is on with no daemon and no .ts.net origin', () => {
    const row = checkTailscale({
      daemon: { reachable: false },
      setting: { enabled: true, login: 'owner@example.com' },
      publicOrigin: 'https://buddi.example.com',
      gatewayPort: 4317,
      serve: SERVING,
    });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('without a local tailscaled');
    expect(row.detail).toContain('not a .ts.net origin');
  });

  it('says it could not check when there is no tailscale binary', () => {
    const row = checkTailscale({
      daemon: { reachable: true, self: 'owner@example.com' },
      setting: { enabled: true, login: 'owner@example.com' },
      publicOrigin: 'https://buddi.tail1234.ts.net:9443',
      gatewayPort: 4317,
      serve: { checked: false, error: 'the tailscale binary was not found' },
    });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('could not check');
  });
});
