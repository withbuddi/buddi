/** The Linux install's unit and its command, with the disk injected. */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { takeReleasesLock } from './app-layout.js';
import { LINUX_COMMAND_MARKER, bundledNode, commandData, commandOwnedBy, linuxUnitSpec } from './linux-install.js';

const data = '/home/owner/.local/share/buddi';
const releases = `${data}/releases`;

describe('the unit', () => {
  test('runs the bundled node and current, never the node that ran the command', () => {
    const spec = linuxUnitSpec({ data, releases, label: 'com.buddi.install.abc', exists: file => file === `${data}/node/node`, extra: { BUDDI_WEB_PORT: '4417' } });
    expect(spec.nodePath).toBe(`${data}/node/node`);
    expect(spec.serveEntry).toBe(`${releases}/current/packages/install/dist/launcher.js`);
    expect(spec.path.split(':')[0]).toBe(`${data}/node`);
    expect(spec.environment).toEqual({
      BUDDI_DATA_DIR: data, BUDDI_SERVICE_UNIT: 'com.buddi.install.abc', BUDDI_WEB_PORT: '4417',
      BUDDI_APP_LAYOUT: releases, BUDDI_LINUX_INSTALL: '1', npm_config_cache: `${data}/cache/npm`,
    });
  });

  test('refuses without the bundled node rather than fall back to /usr/bin/node', () => {
    expect(() => linuxUnitSpec({ data, releases, label: 'x', exists: () => false })).toThrow(/bundled Node is missing at .*\/node\/node/);
    expect(bundledNode(data)).toBe(`${data}/node/node`);
  });
});

describe('the command', () => {
  const command = (dir: string): string => `#!/bin/sh\n${LINUX_COMMAND_MARKER}: written by https://withbuddi.com/install.sh\nDATA='${dir.replace(/'/g, `'\\''`)}'\nexec true\n`;

  test('is this installation\'s only while it carries the marker and names this data folder', () => {
    expect(commandOwnedBy(command(data), data)).toBe(true);
    expect(commandOwnedBy(command(data), `${data}/`)).toBe(true);
    expect(commandOwnedBy(command('/srv/other/buddi'), data)).toBe(false);
    expect(commandOwnedBy(`#!/bin/sh\nDATA='${data}'\n`, data)).toBe(false);
    expect(commandOwnedBy(undefined, data)).toBe(false);
    expect(commandData(command("/home/o'neil/buddi"))).toBe("/home/o'neil/buddi");
  });

  test('a linked home still matches its real folder', () => {
    const real = (file: string): string => file.replace(/^\/home\//, '/var/home/');
    expect(commandOwnedBy(command('/home/owner/buddi'), '/var/home/owner/buddi', real)).toBe(true);
  });
});

describe('the releases lock', () => {
  test('is held by one at a time, and a dead holder\'s lock is taken over', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'releases-lock-'));
    const unlock = await takeReleasesLock(dir);
    expect((await readFile(path.join(dir, '.lock', 'pid'), 'utf8')).trim()).toBe(String(process.pid));
    await expect(takeReleasesLock(dir, process.pid + 1)).rejects.toThrow(/another install or upgrade/);
    await unlock();
    const again = await takeReleasesLock(dir, 999_999_9);
    await again();
  });
});
