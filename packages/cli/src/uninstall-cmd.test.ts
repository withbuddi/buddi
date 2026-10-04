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
    backup: async () => { did.push('backup'); return `${repo}/data/backups/buddi-backup-20261004-100000.tar.gz.age`; },
    passphrase: async () => 'one two three four five six',
    writePrivate: async (file) => { did.push(`write ${file}`); },
    copy: async (from, to) => { did.push(`copy ${to}`); },
    now: () => new Date('2026-10-04T10:00:00Z'),
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
    expect(parseArgs(['uninstall', '--no-backup', '--i-have-the-passphrase', '--copy-to', '/d'])).toEqual({ kind: 'uninstall', yes: false, keepData: false, backup: false, havePassphrase: true, copyTo: '/d' });
    expect(() => parseArgs(['uninstall', '--all'])).toThrow(/unknown option for buddi uninstall/);
  });

  it('backs up, removes the service and the keychain entries, stops Docker, and leaves the repository', async () => {
    const c = checkout();
    expect(await uninstallCheckout(defaults, c.deps)).toBe(0);
    expect(c.did).toEqual(['backup', `write ${repo}/data/backups/buddi-backup-20261004-100000.tar.gz.age.passphrase.txt`, 'service', 'docker compose down', 'purge BACKUP_PASSPHRASE,BUDDI_DB_PASSWORD,TELEGRAM_BOT_TOKEN', 'menu']);
    expect(c.out).toContain(`  - the Docker Postgres, stopped with docker compose down in ${repo}`);
    expect(c.out).toContain('  - secrets: 3 keychain entries under buddi: BACKUP_PASSPHRASE, BUDDI_DB_PASSWORD, TELEGRAM_BOT_TOKEN');
    expect(c.out.some((l) => l.startsWith(`Left alone: the repository ${repo}, its .env, the data in ${repo}/data`))).toBe(true);
    expect(c.out.some((l) => l.endsWith('one two three four five six'))).toBe(true);
    // No npm line: a checkout is not a package.
    expect(c.out.some((l) => l.includes('npm uninstall'))).toBe(false);
  });

  it('--copy-to copies the last backup and writes the passphrase file beside both', async () => {
    const c = checkout();
    expect(await uninstallCheckout({ ...defaults, yes: true, copyTo: '/Users/owner/Desktop' }, c.deps)).toBe(0);
    expect(c.did.slice(0, 4)).toEqual([
      'backup',
      'copy /Users/owner/Desktop/buddi-backup-20261004-100000.tar.gz.age',
      `write ${repo}/data/backups/buddi-backup-20261004-100000.tar.gz.age.passphrase.txt`,
      'write /Users/owner/Desktop/buddi-backup-20261004-100000.tar.gz.age.passphrase.txt',
    ]);
  });

  it('--no-backup still prints and saves the passphrase before the keychain goes, unless --i-have-the-passphrase', async () => {
    const c = checkout();
    expect(await uninstallCheckout({ ...defaults, yes: true, backup: false }, c.deps)).toBe(0);
    expect(c.did[0]).toBe(`write ${repo}/data/backups/buddi-passphrase-20261004-100000.txt`);
    expect(c.did.indexOf(c.did.find((d) => d.startsWith('purge'))!)).toBeGreaterThan(0);
    expect(c.out.some((l) => l.endsWith('one two three four five six'))).toBe(true);
    const quiet = checkout();
    expect(await uninstallCheckout({ ...defaults, yes: true, backup: false, havePassphrase: true }, quiet.deps)).toBe(0);
    expect(quiet.did.some((d) => d.startsWith('write'))).toBe(false);
    expect(quiet.out.some((l) => l.includes('one two three'))).toBe(false);
  });

  it('stops with nothing removed when the passphrase cannot be read, unless --i-have-the-passphrase', async () => {
    for (const backup of [true, false]) {
      const c = checkout({ passphrase: async () => { throw new Error('the keychain is locked'); } });
      expect(await uninstallCheckout({ ...defaults, yes: true, backup }, c.deps), `backup ${backup}`).toBe(1);
      expect(c.did.filter((d) => !d.startsWith('backup'))).toEqual([]);
      expect(c.err[0]).toMatch(/could not be read from the vault \(the keychain is locked\).*Nothing was removed\.$/);
    }
    const sure = checkout({ passphrase: async () => { throw new Error('the keychain is locked'); } });
    expect(await uninstallCheckout({ ...defaults, yes: true, backup: false, havePassphrase: true }, sure.deps)).toBe(0);
    expect(sure.did.some((d) => d.startsWith('purge'))).toBe(true);
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
