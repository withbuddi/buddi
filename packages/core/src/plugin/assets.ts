/**
 * The pure half of plugin assets (host API 1.27): the key, the sizes, the
 * caps, the path the dashboard draws one from, and the check `put` makes
 * before decoding. No state and no I/O, so it sits in `@buddi/core/plugin`;
 * the files are `../plugin-assets.ts`.
 */
/** A key: lower case, digits, `.`, `_` and `-`, starting with a letter or digit; no `..`. */
export const ASSET_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
/** The sizes core keeps, in pixels (a square each). */
export const ASSET_SIZES = [64, 128] as const;
export type AssetSize = (typeof ASSET_SIZES)[number];
/** The most bytes `put` takes in. */
export const ASSET_INPUT_MAX = 256 * 1024;
/** The most a plugin keeps, summed over its stored PNGs. */
export const ASSET_QUOTA_BYTES = 20 * 1024 * 1024;
/**
 * The types `put` reads. SVG is refused: it can carry script. WebP is refused
 * too, for now: buddi carries no pure-JavaScript WebP decoder, and a logo
 * fetch moves on to the next candidate (an apple-touch-icon is a PNG).
 */
export const ASSET_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif'] as const;
/** The route an asset is served on, relative to the dashboard. */
export const ASSET_ROUTE = '/api/plugin-assets';

/** One stored asset, as `list` and `put` answer it. */
export interface PluginAsset {
  key: string;
  /** Bytes of both PNGs together. */
  bytes: number;
  /** When it was last written. */
  updatedAt: string;
}

/** A refusal a plugin reads as it is ("an SVG cannot be kept…"). */
export class AssetRefusal extends Error {
  override readonly name = 'AssetRefusal';
}

/**
 * What decodes an image and draws it again as PNG squares. The gateway's
 * (`plugins/asset-image.ts`); a refusal is thrown as `AssetRefusal`.
 */
export interface AssetImageCodec {
  normalise(bytes: Buffer, mime: string): Promise<Record<AssetSize, Buffer>>;
}

/** Whether `key` may name an asset. */
export function isAssetKey(key: unknown): key is string {
  return typeof key === 'string' && ASSET_KEY.test(key) && !key.includes('..');
}

/**
 * The path the dashboard draws an asset from, or null when the plugin or the
 * key could not be one. Same-origin and relative: never a host.
 */
export function assetPath(plugin: string, key: unknown, size?: AssetSize): string | null {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(plugin) || !isAssetKey(key)) return null;
  return `${ASSET_ROUTE}/${plugin}/${key}${size ? `?size=${size}` : ''}`;
}

/** What `put` refuses before decoding: the size, the type, an SVG by its bytes. */
export function assetInputProblem(bytes: Buffer, mime: string): string | undefined {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return 'the image is empty';
  if (bytes.length > ASSET_INPUT_MAX) return `the image is ${bytes.length} bytes; at most ${ASSET_INPUT_MAX} are taken`;
  const type = String(mime ?? '').toLowerCase().split(';')[0]!.trim();
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (type === 'image/svg+xml' || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'an SVG cannot be kept: it can carry script (give a PNG, JPEG, GIF or ICO)';
  }
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  if (type === 'image/webp' || webp) return 'a WebP image cannot be read yet (give a PNG, JPEG, GIF or ICO)';
  if (type !== '' && type !== 'application/octet-stream' && !(ASSET_INPUT_TYPES as readonly string[]).includes(type)) {
    return `${type} is not an image type buddi keeps (PNG, JPEG, GIF or ICO)`;
  }
  return undefined;
}
