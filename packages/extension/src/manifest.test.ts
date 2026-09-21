/**
 * The folder the owner loads unpacked.
 *
 * A manifest that names a file Chrome cannot find fails at load time with a
 * dialog and no explanation, so the build itself is the test: it runs, and then
 * every path the manifest mentions has to exist.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUNDLES, STATIC, buildExtension } from '../scripts/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
let manifest: Record<string, any>;

beforeAll(async () => {
  await buildExtension();
  manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
}, 60_000);

const exists = async (relative: string) => (await stat(path.join(dist, relative)).catch(() => null))?.isFile() ?? false;

describe('the built extension', () => {
  it('is a Manifest V3 extension carrying the package version', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['version']).toBe(pkg.version);
    expect(manifest['name']).toBe('buddi');
  });

  it('asks for the permissions the commands need, and says why it wants every site', () => {
    // `activeTab` would be the permission for a browser the owner is driving;
    // this one only ever works in background tabs. The web pages it may reach
    // are named as the two schemes it can drive, never as `<all_urls>`, which
    // would also cover `file://` and every other scheme Chrome invents.
    expect(new Set(manifest['permissions'])).toEqual(new Set(['tabs', 'tabGroups', 'scripting', 'debugger', 'storage', 'alarms']));
    expect(manifest['permissions']).not.toContain('activeTab');
    expect(manifest['host_permissions']).toEqual(['http://*/*', 'https://*/*']);
    expect(String(manifest['description'])).toMatch(/sites it opens are the ones you ask/);
  });

  it('names only files that are in the folder', async () => {
    const named = [
      manifest['background']['service_worker'],
      manifest['action']['default_popup'],
      ...Object.values(manifest['icons'] as Record<string, string>),
    ];
    for (const file of named) expect(await exists(file), `${file} is missing`).toBe(true);
    for (const bundle of BUNDLES) expect(await exists(bundle.out), `${bundle.out} is missing`).toBe(true);
    for (const asset of STATIC) expect(await exists(asset), `${asset} is missing`).toBe(true);
    expect(await exists('popup.js')).toBe(true);
  });

  it('runs the worker as a module and has no remote code in it', async () => {
    expect(manifest['background']['type']).toBe('module');
    for (const bundle of BUNDLES) {
      const source = await readFile(path.join(dist, bundle.out), 'utf8');
      expect(source, `${bundle.out} loads code from elsewhere`).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
      expect(source).not.toMatch(/\bimportScripts\s*\(/);
    }
  });

  it('draws its own icons rather than shipping a fetched asset', async () => {
    for (const [size, file] of Object.entries(manifest['icons'] as Record<string, string>)) {
      const bytes = await readFile(path.join(dist, file));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(Number(size));
    }
  });
});
