/**
 * The folder the owner loads unpacked.
 *
 * A manifest that names a file Chrome cannot find fails at load time with a
 * dialog and no explanation, so the build itself is the test: it runs, and then
 * every path the manifest mentions has to exist.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { BUNDLES, STATIC, buildExtension, buddiVersion } from '../scripts/build.mjs';
import { chromeVersion, stampManifest } from '../scripts/version.mjs';
import { storeZip } from '../scripts/zip.mjs';
import { EXTENSION_ID, STORE_EXTENSION_ID } from './id.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
let manifest: Record<string, any>;

beforeAll(async () => {
  await buildExtension();
  manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
}, 60_000);

const exists = async (relative: string) => (await stat(path.join(dist, relative)).catch(() => null))?.isFile() ?? false;

describe('the built extension', () => {
  it('is a Manifest V3 extension carrying buddi\'s version, as Chrome spells it', async () => {
    const version = await buddiVersion();
    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['version']).toBe(chromeVersion(version));
    expect(manifest['version']).toMatch(/^\d+(\.\d+){2,3}$/);
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
    // The store refuses a manifest description longer than 132 characters.
    expect(String(manifest['description']).length).toBeLessThanOrEqual(132);
  });

  /*
   * Chrome derives an unpacked extension's id from the folder path unless the
   * manifest pins a key, and an id that moves is an id the dashboard cannot
   * send a message to. This is the derivation Chrome performs, done here: the
   * SHA-256 of the DER public key, first sixteen bytes, `0`-`f` mapped onto
   * `a`-`p`.
   */
  it('carries the fixed public key, so its id is the one the dashboard knows', () => {
    const key = manifest['key'];
    expect(typeof key).toBe('string');
    const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    const derived = [...digest].map((hex) => String.fromCharCode('a'.charCodeAt(0) + parseInt(hex, 16))).join('');
    expect(derived).toBe(EXTENSION_ID);
    // The private half signs a .crx for the Web Store; it is not in this repo.
    expect(JSON.stringify(manifest)).not.toMatch(/PRIVATE KEY/);
  });

  it('has the dashboard asking both ids, the pinned one and the store one', async () => {
    expect(STORE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(STORE_EXTENSION_ID).not.toBe(EXTENSION_ID);
    const view = await readFile(path.join(root, '..', 'web', 'src', 'views', 'Browser.tsx'), 'utf8');
    expect(view).toContain(`const EXTENSION_ID = '${EXTENSION_ID}';`);
    expect(view).toContain(`const STORE_EXTENSION_ID = '${STORE_EXTENSION_ID}';`);
  });

  it('lets only a buddi dashboard on this machine speak to it, on any port', () => {
    expect(manifest['externally_connectable']).toEqual({
      matches: ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*'],
    });
    // A match pattern has no port in it, and Chrome matches every port; a
    // pattern that named one would be rejected at load time.
    for (const pattern of manifest['externally_connectable'].matches as string[]) expect(pattern).not.toMatch(/:\d+\/\*$/);
  });

  it('names only files that are in the folder', async () => {
    const named = [
      manifest['background']['service_worker'],
      manifest['action']['default_popup'],
      ...Object.values(manifest['icons'] as Record<string, string>),
      ...Object.values(manifest['action']['default_icon'] as Record<string, string>),
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

  it('ships the Blob at every icon size Chrome asks for', async () => {
    for (const [size, file] of Object.entries(manifest['icons'] as Record<string, string>)) {
      const bytes = await readFile(path.join(dist, file));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(Number(size));
    }
  });

  it('ships its fonts and the Blob, and its stylesheet fetches nothing remote', async () => {
    for (const file of ['blob.png', 'fonts/dm-sans-latin-standard-normal.woff2', 'fonts/dm-mono-latin-500-normal.woff2'])
      expect(await exists(file), `${file} is missing`).toBe(true);
    const css = await readFile(path.join(dist, 'popup.css'), 'utf8');
    expect(css).not.toMatch(/url\(\s*['"]?(https?:)?\/\//);
    expect(css).not.toMatch(/@import/);
  });
});

/*
 * Chrome's version is one to four integers. buddi's is semver with a
 * pre-release tag, so the two are mapped: a stable release as it is, a
 * pre-release's number as the fourth part, the full string in `version_name`.
 */
describe('the version Chrome is given', () => {
  it('keeps a stable release as it is', () => {
    expect(chromeVersion('0.1.0')).toBe('0.1.0');
    expect(chromeVersion('1.12.3')).toBe('1.12.3');
    expect(stampManifest({ version: 'x' }, '0.1.0')).toEqual({ version: '0.1.0' });
  });

  it('carries a pre-release number as the fourth part', () => {
    expect(chromeVersion('0.1.0-pre.24')).toBe('0.1.0.24');
    expect(chromeVersion('0.1.0-pre.0')).toBe('0.1.0.0');
    expect(stampManifest({ version: 'x' }, '0.1.0-pre.24')).toEqual({ version: '0.1.0.24', version_name: '0.1.0-pre.24' });
  });

  it('drops any other suffix, and refuses what is not a version', () => {
    expect(chromeVersion('0.1.0-dev.abc1234')).toBe('0.1.0');
    expect(() => chromeVersion('v0.1')).toThrow();
    expect(() => chromeVersion('0.1.70000')).toThrow(/65535/);
  });
});

/** Entries of a zip, read back from its local headers. Enough for what `zip.mjs` writes. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const method = bytes.readUInt16LE(at + 8);
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 30 + nameLength + extra + size;
  }
  return out;
}

describe('the store zip', () => {
  it('has the manifest at its root, without the key, stamped with the release', async () => {
    const entries = unzip(await storeZip(dist, '0.1.0-pre.25'));
    const names = [...entries.keys()];
    expect(names[0]).toBe('manifest.json');
    const store = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(store['key']).toBeUndefined();
    expect(store['version']).toBe('0.1.0.25');
    expect(store['version_name']).toBe('0.1.0-pre.25');
    expect(store['permissions']).toEqual(manifest['permissions']);
    for (const file of [...BUNDLES.map((b) => b.out), ...STATIC]) expect(names, file).toContain(file);
    expect(entries.get('popup.js')!.equals(await readFile(path.join(dist, 'popup.js')))).toBe(true);
    // The unpacked build keeps its key: that is what pins the id the tarball's copy has.
    expect(typeof manifest['key']).toBe('string');
  });
});
