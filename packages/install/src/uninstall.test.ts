/** `buddi uninstall` in a packaged install, against a fake machine: no file, no process, no keychain is real. */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchAgentLabel, launchAgentPlist, systemdUnitPath } from './environment.js';
import { PACKAGE_LINE, parseUninstallArgs, uninstallPackaged } from './uninstall.js';
import type { ExecResult, PackagedUninstallDeps, UninstallOptions } from './uninstall.js';

const home = '/Users/owner';
const data = '/Users/owner/Library/Application Support/buddi-test';
const label = launchAgentLabel(data);
const plist = launchAgentPlist(data, home);

interface Machine {
  deps: PackagedUninstallDeps;
  files: Set<string>;
  out: string[];
  err: string[];
  exec: string[];
  removed: string[];
  moved: Array<[string, string]>;
  purged: string[][];
  menuCleared: boolean;
  backups: number;
  written: Map<string, string>;
  copied: Array<[string, string]>;
}

function machine(opts: {
  platform?: string;
  files?: string[];
  answer?: string | undefined;
  supervisor?: boolean;
  names?: string[] | Error;
  bootout?: ExecResult;
  purge?: Error;
  telegram?: boolean;
  app?: string;
  phrase?: string | undefined;
  state?: Record<string, unknown>;
} = {}): Machine {
  const platform = opts.platform ?? 'darwin';
  const unit = platform === 'darwin' ? plist : systemdUnitPath(data, {}, home);
  const files = new Set(opts.files ?? [
    data, unit, `${data}/installation.json`, `${data}/postgres`, `${data}/agents`, `${data}/artifacts`,
    `${data}/logs`, `${data}/backups`, `${data}/browser/engines`, `${data}/extension.json`,
    ...(platform === 'linux' ? [`${data}/vault.json`, `${data}/vault-key`] : []),
  ]);
  let supervisorAlive = opts.supervisor ?? true;
  let loaded = true;
  const m: Machine = {
    files, out: [], err: [], exec: [], removed: [], moved: [], purged: [], menuCleared: false, backups: 0, written: new Map(), copied: [],
    deps: undefined as unknown as PackagedUninstallDeps,
  };
  m.deps = {
    data, home, platform, env: {}, uid: 501,
    exists: file => [...files].some(f => f === file),
    remove: async file => { m.removed.push(file); for (const f of [...files]) if (f === file || f.startsWith(`${file}/`)) files.delete(f); },
    move: async (from, to) => { m.moved.push([from, to]); files.delete(from); files.add(to); },
    exec: async (command, argv) => {
      m.exec.push(`${command} ${argv.join(' ')}`);
      if (argv[0] === 'bootout' || argv[1] === 'disable') {
        const result = opts.bootout ?? { code: 0, stdout: '', stderr: '' };
        if (result.code === 0) { loaded = false; supervisorAlive = false; }
        return result;
      }
      if (argv[0] === 'print') return loaded ? { code: 0, stdout: 'state = running', stderr: '' } : { code: 113, stdout: '', stderr: 'Could not find service' };
      return { code: 0, stdout: '', stderr: '' };
    },
    supervisor: {
      answers: async () => supervisorAlive,
      stopGateway: async () => {},
      backup: async () => {
        m.backups++;
        const archive = `${data}/backups/buddi-backup-20260926-120000.tar.gz.age`;
        files.add(archive); files.add(`${data}/backups/buddi-backup-20260926-120000.tar.gz.json`);
        return archive;
      },
    },
    passphrase: async () => ('phrase' in opts ? opts.phrase : 'alpha bravo charlie delta echo foxtrot'),
    writePrivate: async (file, text) => { m.written.set(file, text); files.add(file); },
    copy: async (from, to) => { m.copied.push([from, to]); files.add(to); },
    readState: () => (opts.state as never) ?? undefined,
    now: () => new Date('2026-10-04T10:00:00Z'),
    supervisorPid: () => (supervisorAlive ? 4242 : undefined),
    signal: () => { supervisorAlive = false; },
    ...(platform === 'darwin' ? {
      keychain: {
        service: 'buddi.install.abc',
        names: async () => { if (opts.names instanceof Error) throw opts.names; return opts.names ?? ['BRAVE_SEARCH_API_KEY', 'BUDDI_DB_ADMIN_PASSWORD', 'BUDDI_DB_PASSWORD']; },
        purge: async (names: string[]) => { if (opts.purge) throw opts.purge; m.purged.push(names); },
      },
    } : {}),
    ...(opts.telegram ? { telegram: { collect: async () => async () => { m.menuCleared = true; } } } : {}),
    ...(opts.app === undefined ? {} : { app: opts.app }),
    sleep: async () => {},
    io: {
      log: line => m.out.push(line),
      error: line => m.err.push(line),
      ask: async () => ('answer' in opts ? opts.answer : 'yes'),
    },
  };
  return m;
}

const defaults: UninstallOptions = { yes: false, keepData: false, backup: true };

describe('parseUninstallArgs', () => {
  it('takes its flags and nothing else', () => {
    expect(parseUninstallArgs([])).toEqual(defaults);
    expect(parseUninstallArgs(['--yes', '--keep-data', '--no-backup'])).toEqual({ yes: true, keepData: true, backup: false });
    expect(parseUninstallArgs(['--no-backup', '--i-have-the-passphrase', '--copy-to', '/Users/owner/Desktop']))
      .toEqual({ ...defaults, backup: false, havePassphrase: true, copyTo: '/Users/owner/Desktop' });
    expect(parseUninstallArgs(['--copy-to=/tmp/x'])).toEqual({ ...defaults, copyTo: '/tmp/x' });
    expect(() => parseUninstallArgs(['--copy-to'])).toThrow(/--copy-to needs a folder/);
    expect(() => parseUninstallArgs(['--force'])).toThrow(/unknown option for buddi uninstall: --force/);
  });
});

describe('uninstallPackaged', () => {
  it('prints every path first, then removes everything after yes, and ends on the npm line', async () => {
    const m = machine({ telegram: true, app: `${home}/Applications/Buddi Dashboard.app` });
    const code = await uninstallPackaged(defaults, m.deps);
    expect(code).toBe(0);
    const plan = m.out.slice(0, m.out.indexOf('Taking one last backup.'));
    expect(plan).toEqual([
      `Installation: ${data}`,
      'Keychain namespace: buddi.install.abc',
      'This removes buddi from this Mac:',
      `  - the background service: launchd agent ${label} (${plist})`,
      `  - the data directory ${data}: the database, agents and skills, the files library, logs, backups and the fetched Chromium`,
      '  - secrets: 3 keychain entries under buddi.install.abc: BRAVE_SEARCH_API_KEY, BUDDI_DB_ADMIN_PASSWORD, BUDDI_DB_PASSWORD',
      `  - the dashboard app ${home}/Applications/Buddi Dashboard.app`,
      `  - the extension pairing record ${data}/extension.json`,
      "  - the Telegram bot's command menu",
      `First it takes one last backup and moves it to ${home}/buddi-backups, where it stays.`,
    ]);
    expect(m.exec).toContain(`launchctl bootout gui/501/${label}`);
    expect(m.removed).toEqual([plist, data, `${home}/Applications/Buddi Dashboard.app`]);
    expect(m.purged).toEqual([['BRAVE_SEARCH_API_KEY', 'BUDDI_DB_ADMIN_PASSWORD', 'BUDDI_DB_PASSWORD']]);
    expect(m.menuCleared).toBe(true);
    // The backup left the data directory before it was deleted, envelope and all.
    expect(m.moved.map(([, to]) => to)).toEqual([
      `${home}/buddi-backups/buddi-backup-20260926-120000.tar.gz.age`,
      `${home}/buddi-backups/buddi-backup-20260926-120000.tar.gz.json`,
    ]);
    expect(m.out).toContain(`The backup is ${home}/buddi-backups/buddi-backup-20260926-120000.tar.gz.age. It stays: uninstall does not touch that folder.`);
    expect(m.out.some(line => line.endsWith('alpha bravo charlie delta echo foxtrot'))).toBe(true);
    expect(m.out[m.out.length - 1]).toBe(PACKAGE_LINE);
    expect(m.err).toEqual([]);
  });

  it('also removes the passphrase entry the last backup just made', async () => {
    const m = machine();
    const names = ['BUDDI_DB_PASSWORD'];
    m.deps.keychain!.names = async () => [...names];
    const backup = m.deps.supervisor.backup;
    m.deps.supervisor.backup = async () => { names.push('BACKUP_PASSPHRASE'); return await backup(); };
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(0);
    expect(m.purged).toEqual([['BUDDI_DB_PASSWORD', 'BACKUP_PASSPHRASE']]);
  });

  it('removes nothing unless the answer is yes', async () => {
    const m = machine({ answer: 'no' });
    expect(await uninstallPackaged(defaults, m.deps)).toBe(1);
    expect(m.out).toContain('Nothing was removed.');
    expect(m.removed).toEqual([]);
    expect(m.exec).toEqual([]);
    expect(m.backups).toBe(0);
  });

  it('removes nothing without a terminal to ask, and names --yes', async () => {
    const m = machine({ answer: undefined });
    expect(await uninstallPackaged(defaults, m.deps)).toBe(1);
    expect(m.err.join('\n')).toMatch(/buddi uninstall --yes/);
    expect(m.removed).toEqual([]);
  });

  it('does not ask with --yes', async () => {
    const m = machine();
    m.deps.io.ask = async () => { throw new Error('asked'); };
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(0);
    expect(m.files.has(data)).toBe(false);
  });

  it('--keep-data removes the service and the app, and keeps the data directory and its secrets', async () => {
    const m = machine({ app: `${home}/Applications/Buddi Dashboard.app` });
    expect(await uninstallPackaged({ ...defaults, yes: true, keepData: true }, m.deps)).toBe(0);
    expect(m.removed).toEqual([plist, `${home}/Applications/Buddi Dashboard.app`]);
    expect(m.purged).toEqual([]);
    expect(m.moved).toEqual([]);
    expect(m.files.has(`${data}/postgres`)).toBe(true);
    expect(m.out).toContain(`The data directory ${data} stays as it is, with the secrets that open it, for a reinstall.`);
    expect(m.out).toContain(`The backup is ${data}/backups/buddi-backup-20260926-120000.tar.gz.age. It stays, with the rest of the data directory.`);
    expect(m.out.some(line => line.includes('alpha bravo'))).toBe(false);
  });

  it('--no-backup takes none', async () => {
    const m = machine();
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false }, m.deps)).toBe(0);
    expect(m.backups).toBe(0);
    expect(m.out.some(line => /last backup|The backup is/.test(line))).toBe(false);
  });

  it('refuses a data directory that is not an installation, and deletes nothing', async () => {
    const m = machine({ files: [data, `${data}/photos`] });
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(1);
    expect(m.err[0]).toMatch(/is not a buddi installation .* so nothing was removed/);
    expect(m.removed).toEqual([]);
  });

  it('stops before removing anything when the backup cannot be taken', async () => {
    const m = machine({ files: [data, `${data}/installation.json`, `${data}/postgres`], supervisor: false });
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(1);
    expect(m.err[0]).toMatch(/The service is not running, so the last backup could not be taken\. .*--no-backup\. Nothing was removed\./);
    expect(m.removed).toEqual([]);
  });

  it('does the rest and exits 1 when the keychain is locked', async () => {
    const m = machine({ purge: new Error('the keychain refused to delete BUDDI_DB_PASSWORD (security exit 51)') });
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(1);
    expect(m.files.has(data)).toBe(false);
    expect(m.err[0]).toMatch(/^Could not remove secrets: .*security exit 51\)\.$/);
    expect(m.out[m.out.length - 1]).toBe(PACKAGE_LINE);
  });

  it('keeps the data directory when the service will not unload, and exits 1', async () => {
    const m = machine({ bootout: { code: 5, stdout: '', stderr: 'Input/output error' } });
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false }, m.deps)).toBe(1);
    expect(m.files.has(`${data}/postgres`)).toBe(true);
    expect(m.err.join('\n')).toMatch(/launchctl bootout .* failed \(5\): Input\/output error/);
    expect(m.err.join('\n')).toMatch(/Could not remove the data directory .*the service did not stop/);
    expect(m.purged).toHaveLength(1);
  });

  it('on Linux, stops the systemd unit and lists the file vault and its key', async () => {
    const m = machine({ platform: 'linux' });
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false }, m.deps)).toBe(0);
    const unit = systemdUnitPath(data, {}, home);
    expect(m.out).toContain(`  - the background service: systemd user unit ${label}.service (${unit})`);
    expect(m.out).toContain(`  - secrets: the file vault ${path.join(data, 'vault.json')} and its key ${path.join(data, 'vault-key')}`);
    expect(m.exec).toContain(`systemctl --user disable --now ${label}.service`);
    expect(m.exec).toContain('systemctl --user daemon-reload');
    expect(m.out.slice(0, 2)).toEqual([`Installation: ${data}`, 'This removes buddi from this machine:']);
  });

  it('says there is nothing to remove when nothing is there', async () => {
    const m = machine({ files: [], supervisor: false, names: [] });
    expect(await uninstallPackaged(defaults, m.deps)).toBe(0);
    expect(m.out).toEqual([`Installation: ${data}`, 'Keychain namespace: buddi.install.abc', 'Nothing of buddi is installed here, so there is nothing to remove.', PACKAGE_LINE]);
  });
});

describe('uninstallPackaged: the passphrase leaves with the owner', () => {
  const archive = `${home}/buddi-backups/buddi-backup-20260926-120000.tar.gz.age`;

  it('prints it and writes <archive>.passphrase.txt beside the kept backup before the keychain is purged', async () => {
    const m = machine();
    let writtenBeforePurge = false;
    const purge = m.deps.keychain!.purge;
    m.deps.keychain!.purge = async (names) => { writtenBeforePurge = m.written.has(`${archive}.passphrase.txt`); await purge(names); };
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(0);
    expect(writtenBeforePurge).toBe(true);
    const text = m.written.get(`${archive}.passphrase.txt`)!;
    expect(text).toContain('alpha bravo charlie delta echo foxtrot');
    expect(text).toContain('buddi-backup-20260926-120000.tar.gz.age');
    expect(m.out.some(line => line.includes(`${archive}.passphrase.txt`))).toBe(true);
  });

  it('--copy-to copies the archive and its envelope, and writes a passphrase file beside the copy too', async () => {
    const m = machine();
    m.files.add(`${home}/buddi-backups/buddi-backup-20260926-120000.tar.gz.json`);
    expect(await uninstallPackaged({ ...defaults, yes: true, copyTo: `${home}/Desktop` }, m.deps)).toBe(0);
    expect(m.copied.map(([, to]) => to)).toEqual([
      `${home}/Desktop/buddi-backup-20260926-120000.tar.gz.age`,
      `${home}/Desktop/buddi-backup-20260926-120000.tar.gz.json`,
    ]);
    expect([...m.written.keys()]).toEqual([`${archive}.passphrase.txt`, `${home}/Desktop/buddi-backup-20260926-120000.tar.gz.age.passphrase.txt`]);
  });

  it('--no-backup still prints and saves the passphrase, in ~/buddi-backups', async () => {
    const m = machine();
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false }, m.deps)).toBe(0);
    expect([...m.written.keys()]).toEqual([`${home}/buddi-backups/buddi-passphrase-20261004-100000.txt`]);
    expect(m.out.some(line => line.endsWith('alpha bravo charlie delta echo foxtrot'))).toBe(true);
    expect(m.out.join('\n')).toMatch(/--i-have-the-passphrase/);
  });

  it('--no-backup --i-have-the-passphrase neither prints nor saves it', async () => {
    const m = machine();
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false, havePassphrase: true }, m.deps)).toBe(0);
    expect(m.written.size).toBe(0);
    expect(m.out.some(line => line.includes('alpha bravo'))).toBe(false);
  });

  it('writes nothing when the vault keeps no passphrase', async () => {
    const m = machine({ phrase: undefined });
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false }, m.deps)).toBe(0);
    expect(m.written.size).toBe(0);
  });
});

describe('uninstallPackaged: buddi.app\'s command line tool', () => {
  it('lists and removes the shims that run this installation', async () => {
    const m = machine();
    const removed: string[] = [];
    m.deps.shims = { files: ['/usr/local/bin/buddi'], remove: async (file) => { removed.push(file); } };
    expect(await uninstallPackaged({ ...defaults, yes: true, backup: false, havePassphrase: true }, m.deps)).toBe(0);
    expect(m.out).toContain('  - the command line tool /usr/local/bin/buddi');
    expect(removed).toEqual(['/usr/local/bin/buddi']);
  });
});

describe('uninstallPackaged: only the installation installation.json names', () => {
  it('refuses, touching nothing, when installation.json was written for another folder', async () => {
    const m = machine({ state: { version: 1, kind: 'packaged', dataDir: '/Users/owner/Library/Application Support/buddi', vaultService: 'buddi.install.abc' } });
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(1);
    expect(m.err[0]).toMatch(/was written for the installation in \/Users\/owner\/Library\/Application Support\/buddi, not .*buddi-test\. Nothing was removed\./);
    expect(m.err[1]).toBe("Run this from the app's menu, or set BUDDI_DATA_DIR to the installation you mean.");
    expect(m.removed).toEqual([]);
    expect(m.purged).toEqual([]);
    expect(m.exec).toEqual([]);
    expect(m.backups).toBe(0);
  });

  it('refuses when the keychain namespace is not the one installation.json names', async () => {
    const m = machine({ state: { version: 1, kind: 'packaged', dataDir: data, vaultService: 'buddi' } });
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(1);
    expect(m.err[0]).toMatch(/names the keychain namespace buddi, but this run would use buddi\.install\.abc/);
    expect(m.purged).toEqual([]);
  });

  it('goes ahead when both match', async () => {
    const m = machine({ state: { version: 1, kind: 'packaged', dataDir: data, vaultService: 'buddi.install.abc' } });
    expect(await uninstallPackaged({ ...defaults, yes: true }, m.deps)).toBe(0);
  });
});
