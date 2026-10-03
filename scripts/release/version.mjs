/**
 * The pure parts of `pnpm release`: which version an argument names, and the
 * `API_SINCE` entries a release stamps into packages/gateway/src/web/api-routes.ts.
 * `release.mjs` does the git, the files and the pushing; these are tested on
 * their own in version.test.mjs.
 */

/** A refusal `release.mjs` prints as it is. */
export class ReleaseError extends Error {}

/**
 * `pre.N`, `0.1.0-pre.N` or `v0.1.0-pre.N` → the version, its tag and the tag
 * before it. `base` fills in `pre.N` (the root package.json's version).
 * `previousTag` is undefined for `pre.1`: there is nothing before it to check.
 */
export function parseVersion(arg, base = '0.1.0') {
  const text = String(arg ?? '').trim();
  const short = /^pre\.(\d+)$/.exec(text);
  const full = /^v?(\d+\.\d+\.\d+)-pre\.(\d+)$/.exec(text);
  if (!short && !full) throw new ReleaseError(`"${text}" is not a release like pre.36 or 0.1.0-pre.36.`);
  const core = full ? full[1] : base;
  const n = Number(full ? full[2] : short[1]);
  if (!Number.isSafeInteger(n) || n < 1 || String(n) !== (full ? full[2] : short[1])) {
    throw new ReleaseError(`"${text}" needs a pre-release number from 1 up, without leading zeros.`);
  }
  const version = `${core}-pre.${n}`;
  return {
    version,
    n,
    tag: `v${version}`,
    previousTag: n > 1 ? `v${core}-pre.${n - 1}` : undefined,
  };
}

/** `METHOD /path` for every route the table has and `API_SINCE` does not, in table order. */
export function missingSince(routes, since) {
  const seen = new Set();
  const missing = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (Object.hasOwn(since, key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(key);
  }
  return missing;
}

const OPENING = /^export const API_SINCE\b[^\n]*=\s*\{[ \t]*\n/m;

/**
 * The source of api-routes.ts with one `'<key>': '<version>',` line per key
 * at the top of the `API_SINCE` map, indented like the lines already there.
 */
export function stampSince(source, keys, version) {
  if (keys.length === 0) return source;
  const open = OPENING.exec(source);
  if (!open) throw new ReleaseError('api-routes.ts has no `export const API_SINCE … = {` to stamp.');
  const at = open.index + open[0].length;
  const indent = /^([ \t]*)\S/.exec(source.slice(at))?.[1] || '  ';
  const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = keys.map((key) => `${indent}${quote(key)}: ${quote(version)},\n`).join('');
  return source.slice(0, at) + lines + source.slice(at);
}
