/**
 * scripts/install.sh against fake bundles on a real Linux filesystem: the
 * releases it keeps and removes, through a linked data folder and a trailing
 * slash, a same-version reinstall, and the backup before a switch. The fake
 * bundle's node runs the Node running this test; its launcher only answers.
 * Linux only (GNU coreutils, the gate's runner); nothing is started for real.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.sh');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

/** A launcher that answers like buddi's: not running, a backup on request, a link otherwise. */
const LAUNCHER = `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), data = process.env.BUDDI_DATA_DIR;
fs.appendFileSync(path.join(data, 'calls.log'), args.join(' ') + '\\n');
if (args[0] === 'service') process.exit(1);
if (args[0] === 'backup') { fs.mkdirSync(path.join(data, 'backups'), { recursive: true }); fs.writeFileSync(path.join(data, 'backups', 'buddi-backup-20261010-120000.tar.gz.age'), 'x'); process.exit(0); }
console.log('Dashboard: http://127.0.0.1:4317/?t=x');
`;

function bundle(root, version) {
  const name = `buddi-${version}-linux-${arch}`;
  const dir = path.join(root, 'src', name);
  const pkg = path.join(dir, 'release/node_modules/@withbuddi/buddi');
  mkdirSync(path.join(pkg, 'packages/install/dist'), { recursive: true });
  mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  writeFileSync(path.join(dir, 'runtime/node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(path.join(dir, 'runtime/node'), 0o755);
  writeFileSync(path.join(dir, 'runtime/VERSION'), `${process.version}\n`);
  writeFileSync(path.join(dir, 'VERSION'), `${version}\n`);
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version }));
  writeFileSync(path.join(pkg, 'packages/install/dist/launcher.js'), LAUNCHER);
  const tgz = path.join(root, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', path.join(root, 'src'), name]);
  return tgz;
}

describe.skipIf(process.platform !== 'linux')('install.sh', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function machine() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'install-sh-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    mkdirSync(path.join(root, 'var/home'), { recursive: true });
    // A home reached through a link, as /home -> var/home on Silverblue.
    symlinkSync(path.join(root, 'var/home'), home);
    const data = path.join(home, 'data');
    const run = (version, extra = {}) => spawnSync('sh', [script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home, BUDDI_TARBALL: bundle(root, version), BUDDI_DATA_DIR: `${data}/`, BUDDI_NO_START: '1', ...extra },
    });
    const releases = path.join(realpathSync(path.join(root, 'var/home')), 'data/releases');
    const link = name => { try { return readlinkSync(path.join(releases, name)); } catch { return undefined; } };
    return { root, home, data, releases, run, link };
  }

  test('keeps current and previous through a linked data folder with a trailing slash, and prunes the rest', () => {
    const m = machine();
    for (const v of ['0.1.0-pre.1', '0.1.0-pre.2']) expect(m.run(v).status).toBe(0);
    expect(m.link('current')).toMatch(/buddi-0\.1\.0-pre\.2\//);
    expect(m.link('previous')).toMatch(/buddi-0\.1\.0-pre\.1\//);
    expect(existsSync(path.join(m.releases, 'buddi-0.1.0-pre.1'))).toBe(true);
    expect(existsSync(path.join(m.releases, 'buddi-0.1.0-pre.2'))).toBe(true);
    // The same version again: the running release is not removed, previous stays.
    const again = m.run('0.1.0-pre.2');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('installed already');
    expect(existsSync(path.join(m.releases, 'buddi-0.1.0-pre.2/node_modules/@withbuddi/buddi/package.json'))).toBe(true);
    expect(existsSync(path.join(m.releases, 'buddi-0.1.0-pre.1'))).toBe(true);
    expect(m.run('0.1.0-pre.3').status).toBe(0);
    expect(existsSync(path.join(m.releases, 'buddi-0.1.0-pre.1'))).toBe(false);
    expect(existsSync(path.join(m.releases, 'buddi-0.1.0-pre.2'))).toBe(true);
    expect(existsSync(path.join(m.releases, '.lock'))).toBe(false);
    const command = readFileSync(path.join(m.home, '.local/bin/buddi'), 'utf8');
    expect(command).toContain('# buddi-linux-install');
    expect(JSON.parse(readFileSync(path.join(m.releases, '../installer.json'), 'utf8'))).toMatchObject({ version: '0.1.0-pre.3', linger: false });
  });

  test('backs up existing data before the switch, and records the switch as an upgrade', () => {
    const m = machine();
    expect(m.run('0.1.0-pre.1').status).toBe(0);
    const state = path.join(m.releases, '../installation.json');
    writeFileSync(state, JSON.stringify({ version: 1, phase: 'ready', dataDir: m.data }));
    const up = m.run('0.1.0-pre.2');
    expect(up.status, up.stderr).toBe(0);
    const calls = readFileSync(path.join(m.releases, '../calls.log'), 'utf8');
    expect(calls).toMatch(/service status\n--no-service --no-open\nbackup create\n/);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ phase: 'upgrading', upgrade: { from: '0.1.0-pre.1', to: '0.1.0-pre.2', backup: 'buddi-backup-20261010-120000.tar.gz.age' } });
  });

  test('refuses to switch existing data that nothing here can back up, and changes nothing', () => {
    const m = machine();
    mkdirSync(m.data.replace('/home/', '/var/home/'), { recursive: true });
    writeFileSync(path.join(realpathSync(m.home), 'data/installation.json'), '{}');
    const r = m.run('0.1.0-pre.1');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no buddi here can back it up first');
    expect(existsSync(path.join(m.releases, 'current'))).toBe(false);
  });

  test('reinstalls on data an uninstall kept ("Keep my data"): no backup to refuse over, the last one named, buddi started on it', () => {
    const m = machine();
    const data = path.join(realpathSync(m.home), 'data');
    mkdirSync(path.join(data, 'postgres'), { recursive: true });
    mkdirSync(path.join(data, 'backups'), { recursive: true });
    writeFileSync(path.join(data, 'postgres/PG_VERSION'), '17\n');
    writeFileSync(path.join(data, 'installation.json'), JSON.stringify({ version: 1, phase: 'ready', dataDir: m.data }));
    writeFileSync(path.join(data, 'backups/buddi-backup-20261012-120000.tar.gz.age'), 'x');
    writeFileSync(path.join(data, 'kept-for-reinstall.json'), '{}');
    const r = m.run('0.1.0-pre.2');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Reinstalling buddi on the data kept in');
    expect(r.stdout).toMatch(/no new backup first: the buddi that wrote this data was removed.*The last backup it took is \S*\/data\/backups\/buddi-backup-20261012-120000\.tar\.gz\.age/);
    expect(m.link('current')).toMatch(/buddi-0\.1\.0-pre\.2\//);
    expect(readFileSync(path.join(data, 'postgres/PG_VERSION'), 'utf8')).toBe('17\n');
    expect(existsSync(path.join(data, 'kept-for-reinstall.json'))).toBe(false);
    const calls = existsSync(path.join(data, 'calls.log')) ? readFileSync(path.join(data, 'calls.log'), 'utf8') : '';
    expect(calls).not.toContain('backup create');
  });

  test('puts buddi in the app grid, and the desktop app in autostart only when it is installed, never over an entry it did not write', () => {
    const m = machine();
    const apps = path.join(m.home, '.local/share/applications/buddi-desktop.desktop');
    const autostart = path.join(m.home, '.config/autostart/buddi-desktop.desktop');
    expect(m.run('0.1.0-pre.1').status).toBe(0);
    const entry = readFileSync(apps, 'utf8');
    expect(entry).toContain('X-Buddi-Linux-Install=true');
    expect(entry).toContain(`X-Buddi-Data=${realpathSync(m.home)}/data`);
    expect(entry).toContain(`exec buddi-desktop || exec ${m.home}/.local/bin/buddi dashboard"`);
    expect(entry).toContain(`Icon=${realpathSync(m.home)}/data/releases/current/packages/web/dist/icon-512.png`);
    expect(entry).toContain('Actions=new-conversation;check-updates;lock;');
    expect(entry).toContain(`Exec=sh -c "command -v buddi-desktop >/dev/null 2>&1 && exec buddi-desktop --lock || exec ${m.home}/.local/bin/buddi dashboard"`);
    // No desktop app on this PATH (unless the machine running the test has it installed).
    expect(existsSync(autostart)).toBe(existsSync('/usr/bin/buddi-desktop') || existsSync('/bin/buddi-desktop'));
    // The desktop app on PATH: autostart, in the tray.
    const bin = path.join(m.root, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'buddi-desktop'), '#!/bin/sh\n');
    chmodSync(path.join(bin, 'buddi-desktop'), 0o755);
    expect(m.run('0.1.0-pre.1', { PATH: `${bin}:/usr/bin:/bin` }).status).toBe(0);
    expect(readFileSync(autostart, 'utf8')).toContain('Exec=buddi-desktop --hidden');
    // Another installation's entry: left as it is.
    writeFileSync(autostart, '[Desktop Entry]\nX-Buddi-Linux-Install=true\nX-Buddi-Data=/elsewhere\n');
    expect(m.run('0.1.0-pre.1', { PATH: `${bin}:/usr/bin:/bin` }).status).toBe(0);
    expect(readFileSync(autostart, 'utf8')).toContain('X-Buddi-Data=/elsewhere');
    // The owner turned it off (no mark): left as it is.
    writeFileSync(autostart, '[Desktop Entry]\nHidden=true\n');
    expect(m.run('0.1.0-pre.1', { PATH: `${bin}:/usr/bin:/bin` }).status).toBe(0);
    expect(readFileSync(autostart, 'utf8')).toBe('[Desktop Entry]\nHidden=true\n');
  });

  test('quotes an unusual command path for Exec by the desktop entry spec', () => {
    const m = machine();
    const bin = path.join(m.root, 'b"in $x%');
    expect(m.run('0.1.0-pre.1', { BUDDI_BIN_DIR: bin }).status).toBe(0);
    const entry = readFileSync(path.join(m.home, '.local/share/applications/buddi-desktop.desktop'), 'utf8');
    const quoted = `${m.root}/b\\\\"in \\\\$x%%/buddi`;
    expect(entry).toContain(`Exec="${quoted}" dashboard`);
    expect(entry).not.toContain('Actions=');
  });

  test('refuses a tarball that is not the version asked for', () => {
    const m = machine();
    const r = m.run('0.1.0-pre.1', { BUDDI_VERSION: '0.1.0-pre.9' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not the 0.1.0-pre.9 asked for');
  });
});
