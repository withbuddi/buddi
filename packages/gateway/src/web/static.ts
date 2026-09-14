/**
 * Serving the built dashboard.
 *
 * `packages/web` is a Vite build: one `index.html` and a folder of hashed
 * assets. There is nothing dynamic about them, and nothing here reaches outside
 * the assets directory — a path is resolved and then *checked* to still be
 * inside it, which is the only defence against `..` that does not depend on
 * getting the normalization exactly right.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { baseHeaders } from './http.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** The file this pathname names, or null when it escapes the assets dir. */
export function resolveAsset(assetsDir: string, pathname: string): string | null {
  const root = path.resolve(assetsDir);
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative === '' ? 'index.html' : relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

export interface ServeResult {
  served: boolean;
  /** Set when the build is missing entirely, so the caller can say so once. */
  missing?: boolean;
}

/**
 * Send one static file, falling back to `index.html` so the SPA's own routes
 * survive a reload. A missing build is reported, not guessed at.
 */
export async function serveAsset(
  res: ServerResponse,
  assetsDir: string,
  pathname: string,
): Promise<ServeResult> {
  const index = path.resolve(assetsDir, 'index.html');
  const direct = resolveAsset(assetsDir, pathname);
  const file = direct && (await isFile(direct)) ? direct : index;

  if (!(await isFile(file))) return { served: false, missing: true };

  const type = contentType(file);
  const hashed = /\/assets\//.test(pathname) && /-[A-Za-z0-9_]{8,}\./.test(pathname);
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': type,
    // The page itself is never cached (a republish must take effect); hashed
    // assets are immutable by construction, so they are cached hard.
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    stream.on('error', () => {
      res.end();
      resolve();
    });
    stream.on('end', () => resolve());
    stream.pipe(res);
  });
  return { served: true };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** What to say when nobody ran `pnpm -r build`. Owner-facing, plain text. */
export const BUILD_MISSING =
  'The dashboard has not been built yet. Run `pnpm -r build` (or `pnpm --filter @buddi/web build`) and reload.';
