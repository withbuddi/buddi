#!/usr/bin/env node
/**
 * The release gate's runtime check: buddi must run on the Node buddi.app ships.
 *
 * buddi.app carries its own Node (apps/mac/NODE_VERSION, fetched by
 * apps/mac/scripts/fetch-payload.sh into Contents/Resources/runtime), and an
 * installed app updates buddi from npm and runs the new release on that same
 * Node, until a new app shell arrives through Sparkle. So every `engines.node`
 * buddi declares must admit the pinned version, and the recipe must put npm
 * beside node (plugin installs run it: packages/gateway/src/plugins/npm.ts).
 *
 * Sources of `engines.node`: the root package.json (the published manifest takes
 * its engines from it, scripts/release/build.mjs) and every packages/<dir> and
 * packages/tools/<dir> package.json that declares one.
 *
 *   node scripts/release/runtime-gate.mjs [root]
 *
 * No dependencies: the range check below covers npm's range grammar except
 * prerelease tags; anything it cannot read fails the gate rather than passing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIN_FILE = 'apps/mac/NODE_VERSION';
export const RECIPE_FILE = 'apps/mac/scripts/fetch-payload.sh';

/** "v22.23.3" or "22.23.3" -> [22, 23, 3]; anything else throws. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  if (!match) throw new Error(`"${text}" is not an exact Node version like 22.23.3`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const WILD = /^[xX*]$/;

/** A partial version ("22", "22.1", "22.x", "*") as numbers, null where it is open. */
function partial(text, range) {
  const parts = text.replace(/^v/, '').split('.');
  if (parts.length > 3 || parts.some(p => !/^\d+$/.test(p) && !WILD.test(p))) {
    throw new Error(`engines.node "${range}": cannot read "${text}"`);
  }
  const numbers = parts.map(p => (WILD.test(p) ? null : Number(p)));
  const open = numbers.indexOf(null);
  return open === -1 ? numbers : numbers.slice(0, open);
}

/** One comparator ("^22.6", ">=22", "22.x") as [op, version] pairs that must all hold. */
function comparators(token, range) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!match) throw new Error(`engines.node "${range}": cannot read "${token}"`);
  const op = match[1] ?? '';
  const p = partial(match[2], range);
  const low = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  // The first version past a partial: 22 -> 23.0.0, 22.6 -> 22.7.0.
  const next = n => (n === 0 ? null : n === 1 ? [p[0] + 1, 0, 0] : n === 2 ? [p[0], p[1] + 1, 0] : null);
  switch (op) {
    case '':
    case '=': {
      if (p.length === 3) return [['=', low]];
      const high = next(p.length);
      return high ? [['>=', low], ['<', high]] : [];
    }
    case '^': {
      if (p.length === 0) return [];
      const first = p.findIndex(n => n !== 0);
      // ^0.0 and ^0.0.x: the first open part bounds it, as npm reads them.
      const at = first === -1 || first >= p.length ? p.length - 1 : first;
      const high = at === 0 ? [p[0] + 1, 0, 0] : at === 1 ? [p[0], p[1] + 1, 0] : [p[0], p[1], p[2] + 1];
      return [['>=', low], ['<', high]];
    }
    case '~': {
      if (p.length === 0) return [];
      return [['>=', low], ['<', p.length === 1 ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]]];
    }
    case '>':
      return p.length === 3 ? [['>', low]] : p.length === 0 ? [['<', [0, 0, 0]]] : [['>=', next(p.length)]];
    case '>=':
      return [['>=', low]];
    case '<':
      return [['<', low]];
    case '<=':
      return p.length === 3 ? [['<=', low]] : p.length === 0 ? [] : [['<', next(p.length)]];
  }
  throw new Error(`engines.node "${range}": cannot read "${token}"`);
}

function holds([op, bound], version) {
  const c = compare(version, bound);
  return op === '=' ? c === 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0;
}

/** Whether an npm-style range admits an exact version. Throws on what it cannot read. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (typeof range !== 'string' || range.trim() === '') throw new Error(`engines.node ${JSON.stringify(range)} is not a range`);
  return range.split('||').some(alternative => {
    const set = alternative.trim();
    if (set === '' || set === '*' || set.toLowerCase() === 'x') return true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    const tokens = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : set.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
    return tokens.every(token => comparators(token, range).every(c => holds(c, v)));
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Every `engines.node` in the tree: [{ source, range }]. */
export function readEngines(root) {
  const found = [];
  const manifests = ['package.json'];
  for (const base of ['packages', 'packages/tools']) {
    const dir = path.join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (existsSync(path.join(dir, name, 'package.json'))) manifests.push(`${base}/${name}/package.json`);
    }
  }
  for (const source of manifests) {
    const range = readJson(path.join(root, source)).engines?.node;
    if (range !== undefined) found.push({ source, range });
  }
  return found;
}

/** The pinned Node and what the recipe would do with it; problems as plain sentences. */
export function readRecipe(root) {
  const problems = [];
  let pin;
  const pinFile = path.join(root, PIN_FILE);
  if (!existsSync(pinFile)) {
    problems.push(`${PIN_FILE} is missing: buddi.app's Node must be pinned to an exact version.`);
  } else {
    try { pin = parseVersion(readFileSync(pinFile, 'utf8')).join('.'); }
    catch (error) { problems.push(`${PIN_FILE}: ${error.message}.`); }
  }
  const recipeFile = path.join(root, RECIPE_FILE);
  if (!existsSync(recipeFile)) {
    problems.push(`${RECIPE_FILE} is missing: nothing says how the app's runtime is built.`);
    return { pin, problems };
  }
  // Comments say what a line does; only the lines that run count.
  const recipe = readFileSync(recipeFile, 'utf8').split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  if (!/<\s*"?\$HERE\/NODE_VERSION/.test(recipe)) {
    problems.push(`${RECIPE_FILE} does not read the pinned version (${PIN_FILE}); the app could ship another Node.`);
  }
  if (!/cp\s+-R\s+\S*lib\/node_modules\/npm"?\s+"?\$PAYLOAD\/runtime\/lib\/node_modules\/npm/.test(recipe)) {
    problems.push(`${RECIPE_FILE} no longer copies npm (lib/node_modules/npm) into the runtime: buddi.app would ship node without npm, and plugin installs need it.`);
  }
  if (!/ln\s+-s\s+lib\/node_modules\/npm\/bin\/npm-cli\.js\s+"?\$PAYLOAD\/runtime\/npm"?/.test(recipe)) {
    problems.push(`${RECIPE_FILE} no longer links runtime/npm beside node: plugin installs look for npm next to the running node.`);
  }
  return { pin, problems };
}

/** The whole check: { ok, lines, errors }. */
export function check(root) {
  const lines = [];
  const errors = [];
  const { pin, problems } = readRecipe(root);
  errors.push(...problems);
  if (pin) lines.push(`buddi.app bundles Node ${pin} (${PIN_FILE}), npm beside it (${RECIPE_FILE}).`);
  const engines = readEngines(root);
  if (!engines.some(e => e.source === 'package.json')) {
    errors.push('package.json declares no engines.node: the published manifest takes its engines from it.');
  }
  for (const { source, range } of engines) {
    if (!pin) { lines.push(`${source}: engines.node "${range}" (not compared: no pinned Node)`); continue; }
    let ok;
    try { ok = satisfies(pin, range); }
    catch (error) { errors.push(`${source}: ${error.message}.`); continue; }
    if (ok) lines.push(`${source}: engines.node "${range}" admits ${pin}.`);
    else {
      errors.push(`${source}: engines.node "${range}" excludes Node ${pin}, the one buddi.app ships. `
        + 'Installed apps would update to a buddi that cannot start. Ship a buddi.app with a newer Node first '
        + `(${PIN_FILE} and apps/mac/SHELL_VERSION), then raise engines.node (docs/release.md).`);
    }
  }
  return { ok: errors.length === 0, lines, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const { ok, lines, errors } = check(root);
  for (const line of lines) console.log(line);
  for (const error of errors) console.log(process.env.GITHUB_ACTIONS ? `::error title=Runtime gate::${error}` : `error: ${error}`);
  console.log(ok ? 'Runtime gate: green.' : `Runtime gate: ${errors.length} problem(s).`);
  process.exit(ok ? 0 : 1);
}
