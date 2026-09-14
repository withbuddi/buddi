import { describe, expect, it } from 'vitest';
import { DB_UNREACHABLE, DOCKER_DOWN } from './db-cmd.js';
import {
  checkNodeVersion,
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
