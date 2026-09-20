#!/usr/bin/env node
/**
 * Three boundary checks, all lightweight on purpose — no ESLint.
 *
 * 1. **Dependency direction** (ARCHITECTURE.md principle 6): core never imports
 *    a tool or an upper layer. Tools import core, not the reverse. Scans
 *    packages/core sources and its package.json dependencies.
 *
 * 2. **Core never loads code it was handed a path to.** A plugin is installed
 *    by writing a record and importing its entry point at runtime
 *    (`packages/gateway/src/plugins/load.ts`). That is the composition root's
 *    job: core knows a plugin only through `PluginManifest`, and anything that
 *    resolves an arbitrary specifier and imports it knows more than that. A
 *    *literal* dynamic import (`await import('dotenv')`) is just a deferred
 *    static one and stays fine; a computed one is the violation.
 *
 * 3. **One outbound HTTP transport.** Nothing in this repo may reach the
 *    network through the global `fetch`, through `undici`, or through its own
 *    `node:http(s)` client. They all pool connections per origin, and a pooled
 *    connection the far end has already closed is handed back for ever: every
 *    subsequent request in the process then fails in a millisecond with a bare
 *    `fetch failed`, and the process never recovers on its own. That wedged the
 *    owner's service for hours and killed twelve unattended jobs in one
 *    evening. The fix was `packages/runtime/src/transport.ts` — one connection
 *    per request, nothing kept — and it is only a fix while *every* long-lived
 *    caller uses it, so this check is what stops the next one drifting back.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(repoRoot, 'packages', 'core');

const FORBIDDEN = [/^@buddi\/runtime$/, /^@buddi\/gateway$/, /^@buddi\/tool-.+$/];
const SPECIFIER = /(?:from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

function forbidden(spec) {
  return FORBIDDEN.some((re) => re.test(spec));
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) yield full;
  }
}

const violations = [];

for await (const file of walk(coreDir)) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  for (const [i, line] of lines.entries()) {
    SPECIFIER.lastIndex = 0;
    let m;
    while ((m = SPECIFIER.exec(line))) {
      if (forbidden(m[1])) {
        violations.push(`${path.relative(repoRoot, file)}:${i + 1} imports ${m[1]}`);
      }
    }
  }
}

try {
  const pkg = JSON.parse(await readFile(path.join(coreDir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (forbidden(dep)) {
        violations.push(`packages/core/package.json: ${field} declares ${dep}`);
      }
    }
  }
} catch (err) {
  console.error(`check-boundaries: cannot read packages/core/package.json: ${err.message}`);
  process.exit(1);
}

/*
 * Computed dynamic imports in core. See rule 2 above: `import('dotenv')` is a
 * literal and fine; `import(entry)`, `import(`${dir}/index.js`)` is core
 * loading somebody else's code, which belongs in the gateway.
 */
const DYNAMIC_IMPORT = /(?<![.\w$])import\s*\(\s*([^)]*)/g;

for await (const file of walk(coreDir)) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  for (const [i, line] of lines.entries()) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    const code = line.replace(/(^|\s)\/\/.*$/, '$1');
    DYNAMIC_IMPORT.lastIndex = 0;
    let m;
    while ((m = DYNAMIC_IMPORT.exec(code))) {
      const arg = m[1].trim();
      // `import type {...} from` and `import x from` are static forms that this
      // pattern cannot reach (they have no paren), so anything here is a call.
      if (/^['"][^'"]*['"]\s*\)?$/.test(arg)) continue;
      violations.push(
        `${path.relative(repoRoot, file)}:${i + 1} imports a computed specifier (${arg.slice(0, 60)})`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('Boundary violations (core must never import runtime/gateway/tools,');
  console.error('and must never import a specifier it computed — that is the gateway\'s job):');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 3. One outbound HTTP transport
 * ------------------------------------------------------------------ */

/**
 * Where source that runs in Node lives.
 *
 * `--http-root <dir>` points the scan somewhere else. That exists for one
 * reason: the test in `packages/runtime/src/boundaries.test.ts` has to prove
 * this check still fires on a reintroduced `fetch`, and it must be able to do
 * that against a fixture tree instead of by writing a violation into the real
 * repo while other suites are reading it.
 */
const rootFlag = process.argv.indexOf('--http-root');
const HTTP_ROOTS =
  rootFlag === -1
    ? [path.join(repoRoot, 'packages'), path.join(repoRoot, 'examples')]
    : [path.resolve(process.argv[rootFlag + 1])];

/**
 * Files allowed to speak to the network any other way, and why.
 *
 * `packages/web` is the only permanent exemption: it is the dashboard's
 * browser bundle. `fetch` there is the browser's, on a page that lives for
 * minutes, with no Node connection pool anywhere near it — converting it would
 * be symmetry, not safety.
 */
const HTTP_EXEMPT = [
  // The transport itself. It *is* the `node:https` client; that is the point.
  /^packages\/runtime\/src\/transport\.ts$/,
  // Browser code. See above.
  /^packages\/web\//,
  // The two clients of the supervisor's control socket. A Unix domain socket
  // is not the network: there is no origin, so there is no per-origin pool to
  // wedge, and `fetch` cannot address one at all — `node:http`'s client is the
  // only way to speak it. Both send one request with no agent and no keep-alive.
  /^packages\/install\/src\/launcher\.ts$/,
  /^packages\/gateway\/src\/web\/service\.ts$/,
  // Tests may stand up servers, inject pooling agents, and prove the bug. The
  // rule is about what the *service* does at runtime.
  /\.test\.(ts|tsx|mts|js|mjs)$/,
  /\/__fixtures__\//,
];

/**
 * Each rule says what it catches and what to do instead. The message is the
 * whole value of this check: whoever trips it is about to reintroduce a
 * six-hour outage and needs to know that in one line.
 */
const HTTP_RULES = [
  {
    /*
     * A bare `fetch(...)` call.
     *
     * Not `this.#fetch(` or `client.fetch(` — a member call on an injected
     * seam, which is how every test fake and the IMAP client's own `fetch`
     * command read — and not a `fetch(` that opens a line, which is a method
     * or interface declaration, not a call.
     */
    test(line) {
      for (const m of line.matchAll(/fetch\s*\(/g)) {
        const before = line.slice(0, m.index);
        if (/[.#\w$]$/.test(before)) continue;
        if (/^\s*$/.test(before)) continue;
        return true;
      }
      return false;
    },
    what: 'calls the global `fetch` (undici, which pools connections per origin)',
  },
  {
    re: /globalThis\s*\.\s*fetch/,
    what: 'reaches for the global `fetch` (undici, which pools connections per origin)',
  },
  {
    re: /from\s*['"]undici['"]/,
    what: 'imports undici directly',
  },
  {
    // A *client* out of node:http(s). `createServer` and `import type` are the
    // inbound web server and its types, which pool nothing and are fine.
    re: /^(?!.*\bimport\s+type\b).*\b(?:request|Agent)\b[^;]*from\s*['"]node:https?['"]/,
    what: 'builds its own node:http(s) client',
  },
];

const httpViolations = [];

for (const root of HTTP_ROOTS) {
  for await (const file of walk(root)) {
    const rel = path.relative(rootFlag === -1 ? repoRoot : root, file).split(path.sep).join('/');
    if (HTTP_EXEMPT.some((re) => re.test(rel))) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) {
      // Comments talk about this bug constantly; only code counts. A whole
      // comment line is skipped, and a trailing `//` is cut off — without
      // eating the `//` in a URL.
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      const code = line.replace(/(^|\s)\/\/.*$/, '$1');
      for (const rule of HTTP_RULES) {
        const hit = rule.test ? rule.test(code) : rule.re.test(code);
        if (hit) httpViolations.push(`${rel}:${i + 1} ${rule.what}`);
      }
    }
  }
}

if (httpViolations.length > 0) {
  console.error(
    'Outbound HTTP must go through the shared transport (packages/runtime/src/transport.ts):',
  );
  for (const v of httpViolations) console.error(`  - ${v}`);
  console.error(
    '\n  Why: undici and any keep-alive agent keep a pool per origin. When a pooled\n' +
      '  connection dies, it is handed back for ever — every later request in the\n' +
      '  process fails instantly with a bare `fetch failed` and the process never\n' +
      '  recovers. That is what wedged `buddi serve` for hours.\n' +
      '\n  Instead: `defaultHttpTransport(url, { method, headers, body })` from\n' +
      '  @buddi/runtime (re-exported by @buddi/gateway), or `createHttpTransport()`\n' +
      '  when you need your own timeout. Pass a fake transport in tests rather than\n' +
      '  stubbing a global.',
  );
  process.exit(1);
}

console.log('check-boundaries: ok (core imports no runtime/gateway/tool package)');
console.log('check-boundaries: ok (core loads no code from a computed specifier)');
console.log('check-boundaries: ok (no outbound HTTP outside the shared transport)');
