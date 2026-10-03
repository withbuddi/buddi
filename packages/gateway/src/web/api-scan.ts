/**
 * Every `/api/*` route the gateway's source dispatches, read from the source.
 *
 * The router is hand-rolled — `path === '/api/…'` comparisons and regular
 * expressions in `server.ts` and the modules it hands a prefix to — so there
 * is no table to ask at run time. This reads those files the way a person
 * would: every quoted `'/api/…'` and every `/^\/api\/…$/` (or
 * `new RegExp(`^/api/…`)`) becomes a path template, its captures `:_`.
 *
 * In `server.ts` the section a match sits in says its method (the GET block,
 * then PATCH, DELETE, PUT, and POST after them). In the prefix modules the
 * method is decided inside, so their matches are `ANY`.
 *
 * Used by `api-routes.test.ts` to hold `API_ROUTES` (api-routes.ts) to the
 * source in both directions. Not used at run time.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type ScannedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY';

export interface ScannedRoute {
  method: ScannedMethod;
  /** A template with every capture as `:_`. */
  path: string;
  file: string;
  line: number;
}

/** The files a request under /api can be dispatched in, relative to `src/`. */
export const ROUTE_FILES = [
  'web/server.ts',
  'tips/route.ts',
  'web/lock.ts',
  'web/widgets.ts',
  'web/connections.ts',
  'web/places.ts',
  'web/people.ts',
  'web/pages.ts',
  'web/preview.ts',
  'web/extension.ts',
  'web/remote-hand.ts',
] as const;

const PARAM = '\u0000';

/** A route template with its parameter names erased, for comparing. */
export function normaliseTemplate(template: string): string {
  return template.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':_');
}

/** Expand a regular expression's source into the path templates it matches. */
export function expandRegex(source: string): string[] {
  let i = 0;
  const quantifier = (): boolean => {
    const c = source[i];
    if (c === '?' || c === '+' || c === '*') { i += 1; return c === '?'; }
    if (c === '{') { while (i < source.length && source[i] !== '}') i += 1; i += 1; }
    return false;
  };
  const cross = (a: string[], b: string[]): string[] => a.flatMap((x) => b.map((y) => x + y));
  const group = (): string[] => {
    const out: string[] = [];
    for (;;) {
      out.push(...seq());
      if (source[i] === '|') { i += 1; continue; }
      return out;
    }
  };
  const seq = (): string[] => {
    let variants = [''];
    while (i < source.length) {
      const c = source[i]!;
      if (c === ')' || c === '|') break;
      if (c === '^' || c === '$') { i += 1; continue; }
      if (c === '(') {
        i += 1;
        if (source.startsWith('?:', i)) i += 2;
        let inner = group();
        i += 1; // ')'
        // A segment with a capture in it is one parameter; the slashes around it stay.
        inner = [...new Set(inner.map((v) => v.replace(new RegExp(`[^/]*${PARAM}[^/]*`, 'g'), PARAM)))];
        if (quantifier()) inner = [...inner, ''];
        variants = cross(variants, inner);
        continue;
      }
      if (c === '[') {
        while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
        i += 1;
        quantifier();
        variants = variants.map((v) => v + PARAM);
        continue;
      }
      if (c === '\\') {
        const next = source[i + 1]!;
        i += 2;
        const literal = /[/.\-_]/.test(next);
        quantifier();
        variants = variants.map((v) => v + (literal ? next : PARAM));
        continue;
      }
      i += 1;
      variants = variants.map((v) => v + c);
    }
    return variants;
  };
  return [...new Set(group().map((v) => v.replace(new RegExp(`${PARAM}+`, 'g'), ':_')))];
}

/** The regex literals in a line of source that start `/^\/api\/`. */
function regexLiterals(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = line.indexOf('/^\\/api\\/', from);
    if (start < 0) break;
    let i = start + 1;
    let inClass = false;
    while (i < line.length) {
      const c = line[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i += 1;
    }
    out.push(line.slice(start + 1, i));
    from = i + 1;
  }
  return out;
}

/** `new RegExp(`^/api/…`)`: the template, every `${…}` a capture. */
function templateRegexes(line: string): string[] {
  const out: string[] = [];
  const re = /new RegExp\(`(\^\/api\/[^`]*)`/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1]!.replace(/\$\{[^}]+\}/g, '([^/]+)'));
  return out;
}

/** The section of `server.ts`'s `api()` a line falls in, by the method blocks' openings. */
function serverSections(lines: string[]): (line: number) => ScannedMethod | null {
  const find = (needle: string, after: number): number => {
    const at = lines.findIndex((l, n) => n > after && l.includes(needle));
    if (at < 0) throw new Error(`server.ts no longer has "${needle}": update api-scan.ts`);
    return at;
  };
  const api = find('async function api(', -1);
  const get = find("if (method === 'GET' || method === 'HEAD') {", api);
  const patch = find("if (method === 'PATCH') {", get);
  const del = find("if (method === 'DELETE') {", patch);
  const put = find("if (method === 'PUT') {", del);
  const post = find("if (method !== 'POST') return", put);
  const end = find('function finish(', post);
  return (n) => {
    if (n <= api || n >= end) return null;
    if (n < get) return 'ANY';
    if (n < patch) return 'GET';
    if (n < del) return 'PATCH';
    if (n < put) return 'DELETE';
    if (n < post) return 'PUT';
    return 'POST';
  };
}

/** Every route the source dispatches. `srcDir` is the gateway's `src/`. */
export function scanRoutes(srcDir: string): ScannedRoute[] {
  const out: ScannedRoute[] = [];
  for (const file of ROUTE_FILES) {
    const lines = readFileSync(path.join(srcDir, file), 'utf8').split('\n');
    const section = file === 'web/server.ts' ? serverSections(lines) : () => 'ANY' as const;
    lines.forEach((text, n) => {
      const code = text.trimStart();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      const method = section(n);
      if (method === null) return;
      const found: string[] = [];
      for (const m of text.matchAll(/'(\/api\/[^'\s]*)'/g)) found.push(m[1]!);
      for (const source of [...regexLiterals(text), ...templateRegexes(text)]) found.push(...expandRegex(source.replace(/\\\//g, '/').replace(/\//g, '\\/')));
      for (const p of found) {
        if (p === '/api/' || p.endsWith('/')) continue;
        out.push({ method, path: p, file, line: n + 1 });
      }
    });
  }
  return out;
}
