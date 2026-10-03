/**
 * Plugin assets (host API 1.27, docs/plugin-host-api.md §4.2 `assets`): small
 * images a plugin fetched — an outlet's logo — kept by core and served by
 * buddi, so the dashboard draws them without ever reaching the host they
 * came from.
 *
 * A plugin hands over bytes; core decodes them and writes PNGs it encoded
 * itself, at 64 and 128 pixels, under `<data>/plugin-assets/<plugin>/`. Only
 * those files are ever served (`/api/plugin-assets/<plugin>/<key>`), with
 * `image/png`, `nosniff` and the sandboxing CSP: nothing a plugin wrote
 * byte-for-byte reaches a page. The directory is core's, not the plugin's own
 * (`dir`), and it is removed with the plugin.
 *
 * Decoding is not done here: core carries no image library. The composition
 * root hands one in (`configurePluginHost({ images })`), as it hands in the
 * HTTP transport; a process without one refuses `put` in a sentence.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveDataDir, type EnvLike } from './artifacts/store.js';
import {
  ASSET_QUOTA_BYTES,
  ASSET_SIZES,
  AssetRefusal,
  assetInputProblem,
  isAssetKey,
  type AssetImageCodec,
  type AssetSize,
  type PluginAsset,
} from './plugin/assets.js';

export * from './plugin/assets.js';

/** `<data>/plugin-assets`. */
export function assetsRoot(env: EnvLike = process.env): string {
  return path.join(resolveDataDir(env), 'plugin-assets');
}

function pluginDir(plugin: string, env: EnvLike): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(plugin)) throw new AssetRefusal(`"${plugin}" is not a plugin name`);
  return path.join(assetsRoot(env), plugin);
}

function fileOf(dir: string, key: string, size: AssetSize): string {
  return path.join(dir, `${key}.${size}.png`);
}

function checkKey(key: unknown): string {
  if (!isAssetKey(key)) {
    throw new AssetRefusal(
      `"${String(key)}" is not an asset key (lower-case letters, digits, ".", "_" and "-", at most 96 characters)`,
    );
  }
  return key;
}

/** Every asset a plugin keeps, by key. */
export async function listPluginAssets(plugin: string, env: EnvLike = process.env): Promise<PluginAsset[]> {
  const dir = pluginDir(plugin, env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const byKey = new Map<string, PluginAsset>();
  for (const name of names.sort()) {
    const match = /^(.+)\.(64|128)\.png$/.exec(name);
    if (!match || !isAssetKey(match[1])) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (!info) continue;
    const key = match[1]!;
    const seen = byKey.get(key);
    const at = info.mtime.toISOString();
    byKey.set(key, {
      key,
      bytes: (seen?.bytes ?? 0) + info.size,
      updatedAt: seen && seen.updatedAt > at ? seen.updatedAt : at,
    });
  }
  return [...byKey.values()];
}

/**
 * Decode, re-encode and keep one asset under `key`, replacing what was
 * there. Refused, as an `AssetRefusal` with the sentence why, for a bad key,
 * an SVG, a type buddi does not read, more than 256 KB in, an image the codec
 * cannot read, or a plugin over its 20 MB.
 */
export async function putPluginAsset(
  plugin: string,
  key: string,
  bytes: Buffer,
  mime: string,
  codec: AssetImageCodec | undefined,
  env: EnvLike = process.env,
): Promise<PluginAsset> {
  checkKey(key);
  const problem = assetInputProblem(bytes, mime);
  if (problem) throw new AssetRefusal(`${plugin}: ${problem}`);
  if (!codec) throw new AssetRefusal('This process cannot keep plugin assets (no image codec was configured).');
  const encoded = await codec.normalise(bytes, mime);
  const dir = pluginDir(plugin, env);
  const size = ASSET_SIZES.reduce((sum, s) => sum + (encoded[s]?.length ?? 0), 0);
  const kept = await listPluginAssets(plugin, env);
  const others = kept.filter((a) => a.key !== key).reduce((sum, a) => sum + a.bytes, 0);
  if (others + size > ASSET_QUOTA_BYTES) {
    throw new AssetRefusal(`${plugin} keeps ${others} bytes of assets; this one would pass its ${ASSET_QUOTA_BYTES / 1024 / 1024} MB (delete some first)`);
  }
  await mkdir(dir, { recursive: true });
  for (const s of ASSET_SIZES) {
    const png = encoded[s];
    if (!png) throw new AssetRefusal(`${plugin}: the image could not be drawn at ${s} px`);
    // Written beside and renamed over: a page never reads half a file.
    const target = fileOf(dir, key, s);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, png);
    await rename(temp, target);
  }
  return { key, bytes: size, updatedAt: new Date().toISOString() };
}

/** Delete one asset. False when there was none. */
export async function deletePluginAsset(plugin: string, key: string, env: EnvLike = process.env): Promise<boolean> {
  checkKey(key);
  const dir = pluginDir(plugin, env);
  let removed = false;
  for (const s of ASSET_SIZES) {
    try {
      await rm(fileOf(dir, key, s));
      removed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

/** The stored PNG for one size, or null when there is none. */
export async function readPluginAsset(
  plugin: string,
  key: string,
  size: AssetSize,
  env: EnvLike = process.env,
): Promise<Buffer | null> {
  if (!isAssetKey(key) || !(ASSET_SIZES as readonly number[]).includes(size)) return null;
  try {
    return await readFile(fileOf(pluginDir(plugin, env), key, size));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof AssetRefusal) return null;
    throw err;
  }
}

/** Remove every asset a plugin kept: when the plugin is removed. Never throws for a missing directory. */
export async function removePluginAssets(plugin: string, env: EnvLike = process.env): Promise<void> {
  await rm(pluginDir(plugin, env), { recursive: true, force: true });
}
