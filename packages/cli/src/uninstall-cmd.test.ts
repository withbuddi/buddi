/** `buddi uninstall` in a source checkout, with every effect faked: the live service and keychain are never touched. */
import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { uninstallCheckout } from './uninstall-cmd.js';
import type { CheckoutUninstallDeps, CheckoutUninstallOptions } from './uninstall-cmd.js';

const repo = '/Users/owner/src/buddi';

function checkout(overrides: Partial<CheckoutUninstallDeps> = {}, answer: string | undefined = 'yes') {
  const did: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CheckoutUninstallDeps = {
    platform: 'darwin',
    repoRoot: repo,
    dataDir: `${repo}/data`,
    backupDir: `${repo}/data/backups`,
    service: {
      line: '/Users/owner/Library/LaunchAgents/com.buddi.serve.plist',
      uninstall: async () => { did.push('service'); },
    },
    database: { down: async () => { did.push('docker compose down'); } },
    keychain: {
      service: 'buddi',
      names: async () => ['BACKUP_PASSPHRASE', 'BUDDI_DB_PASSWORD', 'TELEGRAM_BOT_TOKEN'],
      purge: async (names) => { did.push(`purge ${names.join(',')}`); },
    },
    removeFile: async (file) => { did.push(`rm ${file}`); },
    backup: async () => { did.push('backup'); },
    passphrase: async () => 'one two three four five six',
    telegram: { collect: async () => async () => { did.push('menu'); } },
    io: { log: (l) => out.push(l), error: (l) => err.push(l), ask: async () => answer },
    ...overrides,
  };
  return { deps, did, out, err };
}

const defaults: CheckoutUninstallOptions = { yes: false, keepData: false, backup: true };

describe('buddi uninstall in a checkout', () => {
  it('parses its flags', () => {
    expect(parseArgs(['uninstall'])).toEqual({ kind: 'uninstall', yes: false, keepData: false, backup: true });
    expect(parseArgs(['uninstall', '--yes', '--keep-data', '--no-backup'])).toEqual({ kind: 'uninstall', yes: true, keepData: true, backup: false });
    expect(() => parseArgs(['uninstall', '--all'])).toThrow(/unknown option for buddi uninstall/);
  });

  it('backs up, removes the service and the keychain entries, stops Docker, and leaves the repository', async () => {
    const c = checkout();
    expect(await uninstallCheckout(defaults, c.deps)).toBe(0);
    expect(c.did).toEqual(['backup', 'service', 'docker compose down', 'purge BACKUP_PASSPHRASE,BUDDI_DB_PASSWORD,TELEGRAM_BOT_TOKEN', 'menu']);
    expect(c.out).toContain(`  - the Docker Postgres, stopped with docker compose down in ${repo}`);
    expect(c.out).toContain('  - secrets: 3 keychain entries under buddi: BACKUP_PASSPHRASE, BUDDI_DB_PASSWORD, TELEGRAM_BOT_TOKEN');
    expect(c.out.some((l) => l.startsWith(`Left alone: the repository ${repo}, its .env, the data in ${repo}/data`))).toBe(true);
    expect(c.out.some((l) => l.endsWith('one two three four five six'))).toBe(true);
    // No npm line: a checkout is not a package.
    expect(c.out.some((l) => l.includes('npm uninstall'))).toBe(false);
  });

  it('removes nothing when the answer is not yes', async () => {
    const c = checkout({}, 'nope');
    expect(await uninstallCheckout(defaults, c.deps)).toBe(1);
    expect(c.did).toEqual([]);
  });

  it('--keep-data keeps the secrets that open the kept database', async () => {
    const c = checkout();
    expect(await uninstallCheckout({ ...defaults, yes: true, keepData: true, backup: false }, c.deps)).toBe(0);
    expect(c.did).toEqual(['service', 'docker compose down', 'menu']);
  });

  it('stops with nothing removed when the backup fails', async () => {
    const c = checkout({ backup: async () => { throw new Error('The last backup did not finish. Start the database with buddi db up, or run buddi uninstall --no-backup.'); } });
    expect(await uninstallCheckout({ ...defaults, yes: true }, c.deps)).toBe(1);
    expect(c.did).toEqual([]);
    expect(c.err[0]).toMatch(/--no-backup\. Nothing was removed\.$/);
  });

  it('exits 1 when the service would not unload, after doing the rest', async () => {
    const c = checkout({ service: { line: 'svc', uninstall: async () => { throw new Error('launchd still runs it (pid 12)'); } } });
    expect(await uninstallCheckout({ ...defaults, yes: true, backup: false }, c.deps)).toBe(1);
    expect(c.did).toContain('docker compose down');
    expect(c.err[0]).toBe('Could not remove svc: launchd still runs it (pid 12).');
  });

  it('on Linux, removes the file vault instead', async () => {
    const { keychain: _unused, ...rest } = checkout().deps;
    const c = checkout();
    const deps = { ...rest, io: c.deps.io, platform: 'linux', fileVault: '/home/owner/.buddi/vault.json', removeFile: async (f: string) => { c.did.push(`rm ${f}`); } };
    expect(await uninstallCheckout({ ...defaults, yes: true, backup: false }, deps)).toBe(0);
    expect(c.did).toContain('rm /home/owner/.buddi/vault.json');
    expect(c.out[0]).toBe("This removes buddi's service and secrets from this machine:");
  });
});
