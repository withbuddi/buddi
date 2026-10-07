/**
 * A plugin's kept image (host API 1.27): an outlet's logo, drawn from buddi's
 * own `/api/plugin-assets/<plugin>/<key>` and never from anywhere else. A key
 * that is not one, or an asset that is gone, is a letter tile from its label,
 * as Sources draws a page it has no picture for.
 *
 * The path is built here from the plugin drawing the page and a key read
 * from its data; nothing in the data can name a host, so the page still makes
 * no request outside buddi.
 */
import { useState } from 'react';

/** The same rule as core's `ASSET_KEY`. */
const ASSET_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const PLUGIN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The route an asset is drawn from, or null when the plugin or key could not be one. */
export function assetSrc(plugin: string, key: unknown, size: 64 | 128 | 768 = 64): string | null {
  if (!PLUGIN.test(plugin) || typeof key !== 'string' || !ASSET_KEY.test(key) || key.includes('..')) return null;
  return `/api/plugin-assets/${plugin}/${key}?size=${size}`;
}

/** Only a path buddi serves assets on is ever put in an `<img>`. */
export function isAssetSrc(src: unknown): src is string {
  return typeof src === 'string' && /^\/api\/plugin-assets\/[a-z][a-z0-9_-]{0,63}\/[a-z0-9._-]+(\?size=(64|128|768))?$/.test(src);
}

/** A tile's letters: the first letter or digit of the words. */
export function letterOf(label: string): string {
  return label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '?';
}

export function AssetImage({
  src,
  label,
  className,
}: {
  /** From `assetSrc` or a widget row's `image.src`; anything else draws the tile. */
  src: string | null;
  label: string;
  className?: string;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const drawn = src !== null && isAssetSrc(src) && !failed;
  return (
    <span className={['pl-logo', className].filter(Boolean).join(' ')} data-letter={drawn ? undefined : 'true'} aria-hidden="true">
      {drawn ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : letterOf(label)}
    </span>
  );
}
