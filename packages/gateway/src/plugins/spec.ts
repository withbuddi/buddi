/**
 * What the owner typed, turned into a source.
 *
 * Three shapes, decided in this order and no other:
 *
 *  1. a path that exists and is a directory — the developer path, unchanged.
 *     It is first because a developer with a `finance` directory beside them
 *     means that directory, not a package on the public registry with the same
 *     name. Guessing the registry there would silently install a stranger's
 *     code instead of the owner's own build.
 *  2. a path ending `.tgz` — a tarball on disk, for a plugin that should never
 *     be public.
 *  3. anything else — an npm spec: `name`, `name@1.2.3`, `@scope/name@^1`.
 *
 * Nothing here touches the network or the registry; it is a pure function of
 * the text and of what is on disk, which is what makes it testable and what
 * makes the CLI able to say what it is about to do before it does it.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export type PluginSpec =
  | { kind: 'directory'; path: string }
  | { kind: 'tarball'; path: string }
  /** `range` is what the owner asked for; staging resolves it to one version. */
  | { kind: 'registry'; name: string; range: string; registry?: string };

export class BadPluginSpec extends Error {
  override readonly name = 'BadPluginSpec';
}

/** `@scope/name@^1` → name `@scope/name`, range `^1`. */
export function splitNpmSpec(text: string): { name: string; range: string } {
  const scoped = text.startsWith('@');
  const at = text.indexOf('@', scoped ? 1 : 0);
  if (at === -1) return { name: text, range: 'latest' };
  const name = text.slice(0, at);
  const range = text.slice(at + 1).trim();
  return { name, range: range === '' ? 'latest' : range };
}

/** npm's own rule, narrowed: no uppercase, no spaces, optional single scope. */
export function isNpmPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214;
}

export function parsePluginSpec(
  text: string,
  opts: { cwd?: string; registry?: string } = {},
): PluginSpec {
  const raw = text.trim();
  if (raw === '') throw new BadPluginSpec('no plugin was named');
  const cwd = opts.cwd ?? process.cwd();
  const asPath = path.resolve(cwd, raw);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) {
    return { kind: 'directory', path: asPath };
  }
  if (raw.toLowerCase().endsWith('.tgz')) {
    if (!existsSync(asPath)) {
      throw new BadPluginSpec(`${asPath} is not on disk, so there is no tarball to install`);
    }
    return { kind: 'tarball', path: asPath };
  }
  const { name, range } = splitNpmSpec(raw);
  if (!isNpmPackageName(name)) {
    throw new BadPluginSpec(
      `"${raw}" is neither a directory that exists, nor a .tgz on disk, nor a valid npm package name`,
    );
  }
  return {
    kind: 'registry',
    name,
    range,
    ...(opts.registry === undefined || opts.registry.trim() === '' ? {} : { registry: opts.registry }),
  };
}

/** `name@range`, the way npm wants it back. */
export function npmSpecText(spec: { name: string; range: string }): string {
  return `${spec.name}@${spec.range}`;
}
