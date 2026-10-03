/**
 * Plugin assets (host API 1.27): the key, the refusals before decoding, the
 * files core keeps, the quota, and the area on `ctx.buddi` only for a plugin
 * that declares `assets`. The codec is a fake here; the gateway's own is
 * tested beside it (`plugins/asset-image.test.ts`).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configurePluginHost, createPluginHost, hostBindingOf, resetPluginHost } from './host/build.js';
import {
  ASSET_INPUT_MAX,
  ASSET_QUOTA_BYTES,
  assetInputProblem,
  assetPath,
  deletePluginAsset,
  isAssetKey,
  listPluginAssets,
  putPluginAsset,
  readPluginAsset,
  removePluginAssets,
  type AssetImageCodec,
} from './plugin-assets.js';
import type { PluginManifest } from './tools.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Draws "pixels" of a known size, so the files can be told apart. */
const codec = (size = 10): AssetImageCodec => ({
  normalise: async () => ({ 64: Buffer.alloc(size, 64), 128: Buffer.alloc(size, 128) }),
});

describe('plugin assets', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-assets-'));
    env = { BUDDI_DATA_DIR: dir };
  });
  afterEach(async () => {
    resetPluginHost();
    await rm(dir, { recursive: true, force: true });
  });

  it('takes a key of lower-case letters, digits, dots, dashes and underscores, and builds only buddi\'s own path', () => {
    expect(isAssetKey('lemonde.fr')).toBe(true);
    expect(isAssetKey('outlet_12-logo')).toBe(true);
    for (const bad of ['', 'Le Monde', '../x', 'a..b', '.hidden', 'x/y', 'https://evil.example/x.png', 'a'.repeat(97)]) {
      expect(isAssetKey(bad), bad).toBe(false);
    }
    expect(assetPath('news', 'lemonde.fr', 64)).toBe('/api/plugin-assets/news/lemonde.fr?size=64');
    expect(assetPath('news', 'https://evil.example/logo.png')).toBeNull();
    expect(assetPath('../core', 'x')).toBeNull();
  });

  it('refuses an SVG, a WebP, a type it does not read, an empty file and more than 256 KB before decoding', () => {
    expect(assetInputProblem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')).toMatch(/SVG cannot be kept/);
    expect(assetInputProblem(Buffer.from('<?xml version="1.0"?><svg/>'), '')).toMatch(/SVG/);
    expect(assetInputProblem(PNG, 'image/svg+xml')).toMatch(/SVG/);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    expect(assetInputProblem(webp, 'image/png')).toMatch(/WebP image cannot be read yet/);
    expect(assetInputProblem(PNG, 'text/html')).toMatch(/text\/html is not an image type/);
    expect(assetInputProblem(Buffer.alloc(0), 'image/png')).toMatch(/empty/);
    expect(assetInputProblem(Buffer.alloc(ASSET_INPUT_MAX + 1), 'image/png')).toMatch(/at most 262144/);
    expect(assetInputProblem(PNG, 'image/png')).toBeUndefined();
    expect(assetInputProblem(PNG, 'image/x-icon')).toBeUndefined();
  });

  it('keeps the two PNGs the codec drew, lists, reads, replaces and deletes them', async () => {
    const kept = await putPluginAsset('news', 'lemonde.fr', PNG, 'image/png', codec(10), env);
    expect(kept).toMatchObject({ key: 'lemonde.fr', bytes: 20 });
    expect((await readdir(path.join(dir, 'plugin-assets', 'news'))).sort()).toEqual(['lemonde.fr.128.png', 'lemonde.fr.64.png']);
    expect((await readPluginAsset('news', 'lemonde.fr', 64, env))!.equals(Buffer.alloc(10, 64))).toBe(true);
    expect((await readPluginAsset('news', 'lemonde.fr', 128, env))!.equals(Buffer.alloc(10, 128))).toBe(true);
    expect(await readPluginAsset('news', 'missing', 64, env)).toBeNull();
    expect(await readPluginAsset('news', '../x', 64, env)).toBeNull();
    await putPluginAsset('news', 'lemonde.fr', PNG, 'image/png', codec(30), env);
    expect(await listPluginAssets('news', env)).toEqual([expect.objectContaining({ key: 'lemonde.fr', bytes: 60 })]);
    expect(await deletePluginAsset('news', 'lemonde.fr', env)).toBe(true);
    expect(await deletePluginAsset('news', 'lemonde.fr', env)).toBe(false);
    expect(await listPluginAssets('news', env)).toEqual([]);
  });

  it('refuses past 20 MB per plugin, a bad key, and a process with no codec', async () => {
    const MB = 1024 * 1024;
    expect(ASSET_QUOTA_BYTES).toBe(20 * MB);
    await putPluginAsset('news', 'a', PNG, 'image/png', codec(4 * MB), env); // 8 MB with both sizes
    await putPluginAsset('news', 'b', PNG, 'image/png', codec(4 * MB), env); // 16 MB
    await expect(putPluginAsset('news', 'c', PNG, 'image/png', codec(3 * MB), env)).rejects.toThrow(/would pass its 20 MB/);
    // Replacing one counts its new size, not both: 10 + 8 = 18 MB.
    await expect(putPluginAsset('news', 'a', PNG, 'image/png', codec(5 * MB), env)).resolves.toMatchObject({ bytes: 10 * MB });
    await expect(putPluginAsset('news', 'Bad Key', PNG, 'image/png', codec(), env)).rejects.toThrow(/not an asset key/);
    await expect(putPluginAsset('news', 'x', PNG, 'image/png', undefined, env)).rejects.toThrow(/cannot keep plugin assets/);
  });

  it('removes everything a plugin kept, and nothing of another', async () => {
    await putPluginAsset('news', 'a', PNG, 'image/png', codec(), env);
    await putPluginAsset('weather', 'b', PNG, 'image/png', codec(), env);
    await removePluginAssets('news', env);
    await removePluginAssets('never-installed', env);
    expect(await listPluginAssets('news', env)).toEqual([]);
    expect(await listPluginAssets('weather', env)).toHaveLength(1);
  });

  it('puts the area on ctx.buddi only for a plugin that declares assets, scoped to its own name', async () => {
    configurePluginHost({ env, images: codec(5) });
    const manifest = (uses: PluginManifest['uses']): PluginManifest => ({ name: 'news', version: '0.1.0', schema: 'news', migrationsDir: '', tools: [], uses });
    const facts = { db: {} as never, now: () => new Date(), timezone: 'UTC' };
    expect(createPluginHost(hostBindingOf(manifest([])), facts).assets).toBeUndefined();
    const host = createPluginHost(hostBindingOf(manifest(['assets'])), facts);
    await host.assets!.put('rfi.fr', PNG, 'image/png');
    expect((await host.assets!.list()).map((a) => a.key)).toEqual(['rfi.fr']);
    expect(await listPluginAssets('news', env)).toHaveLength(1);
    await expect(host.assets!.put('logo', Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toThrow(/SVG cannot be kept/);
    expect(await host.assets!.delete('rfi.fr')).toBe(true);
  });
});
