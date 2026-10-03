#!/usr/bin/env node
/**
 * `pnpm release pre.N [--dry-run]` (also `0.1.0-pre.N`): cut a release from main.
 *
 *   1. Preflight: clean tree, on main, level with origin/main, the tag absent
 *      here and on origin, the previous tag present, Unreleased not empty.
 *   2. Stamp the routes missing from `API_SINCE` (read from the built gateway,
 *      rebuilt first when its dist is older than the source) at the top of the
 *      map in packages/gateway/src/web/api-routes.ts.
 *   3. CHANGELOG.md: Unreleased becomes `## <version> — <date>` under a fresh,
 *      empty Unreleased.
 *   4. `pnpm docs:api` and `pnpm docs:cli`.
 *   5. Commit "Release <version>", tag `v<version>`, push main and the tag.
 *   6. Print the release workflow run and the command that watches it.
 *
 * `--dry-run` reports every preflight problem and what each step would do, and
 * writes nothing to the tree (it may build the gateway's dist to read routes).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChangelogError, cutRelease, sectionOf, today } from './changelog.mjs';
import { missingSince, parseVersion, ReleaseError, stampSince } from './version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHANGELOG = path.join(root, 'CHANGELOG.md');
const ROUTES_SRC = path.join(root, 'packages', 'gateway', 'src', 'web', 'api-routes.ts');
const ROUTES_DIST = path.join(root, 'packages', 'gateway', 'dist', 'web', 'api-routes.js');

const args = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));

function git(...a) {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function run(cmd, a) {
  console.log(`$ ${[cmd, ...a].join(' ')}`);
  const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new ReleaseError(`\`${[cmd, ...a].join(' ')}\` failed (exit ${r.status ?? r.signal}).`);
}

function preflight(rel) {
  const problems = [];
  if (git('status', '--porcelain').out !== '') problems.push('The working tree has changes: commit or stash them first.');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
  if (branch !== 'main') problems.push(`On branch ${branch}, not main.`);
  if (!git('fetch', '--quiet', 'origin', 'main', '--tags').ok) problems.push('`git fetch origin` failed.');
  const head = git('rev-parse', 'HEAD').out;
  const upstream = git('rev-parse', 'origin/main').out;
  if (head !== upstream) problems.push('HEAD is not level with origin/main: pull or push first.');
  if (git('rev-parse', '-q', '--verify', `refs/tags/${rel.tag}`).ok) problems.push(`The tag ${rel.tag} already exists here.`);
  else if (git('ls-remote', '--tags', 'origin', `refs/tags/${rel.tag}`).out !== '') problems.push(`The tag ${rel.tag} already exists on origin.`);
  if (rel.previousTag && !git('rev-parse', '-q', '--verify', `refs/tags/${rel.previousTag}`).ok) {
    problems.push(`The previous tag ${rel.previousTag} does not exist: is ${rel.version} the next release?`);
  }
  try { sectionOf(readFileSync(CHANGELOG, 'utf8'), 'unreleased'); }
  catch (e) { if (e instanceof ChangelogError) problems.push(e.message); else throw e; }
  return problems;
}

/** The newest file under a directory, by mtime. */
function newest(dir) {
  let best = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else best = Math.max(best, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return best;
}

async function routeTable() {
  const stale = !existsSync(ROUTES_DIST) || statSync(ROUTES_DIST).mtimeMs < newest(path.join(root, 'packages', 'gateway', 'src'));
  if (stale) run('pnpm', ['--filter', '@buddi/gateway', 'build']);
  const { API_ROUTES, API_SINCE } = await import(pathToFileURL(ROUTES_DIST).href);
  return { API_ROUTES, API_SINCE };
}

async function main() {
  if (positional.length !== 1) {
    console.error('Usage: pnpm release pre.N [--dry-run]   (or 0.1.0-pre.N)');
    return 2;
  }
  const base = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const rel = parseVersion(positional[0], base);
  const say = (line) => console.log(dryRun ? `[dry run] ${line}` : line);
  console.log(`Releasing ${rel.version}${dryRun ? ' (dry run: nothing is written)' : ''}`);

  const problems = preflight(rel);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  - ${p}`);
    if (!dryRun) return 1;
  } else {
    say('Preflight passed.');
  }

  const { API_ROUTES, API_SINCE } = await routeTable();
  const missing = missingSince(API_ROUTES, API_SINCE);
  const date = today();
  const routesSource = readFileSync(ROUTES_SRC, 'utf8');
  const stamped = stampSince(routesSource, missing, rel.version);
  const changelog = cutRelease(readFileSync(CHANGELOG, 'utf8'), rel.version, date);

  if (missing.length === 0) say('API_SINCE: every route already has a version.');
  else say(`API_SINCE: stamp ${missing.length} route(s) with ${rel.version}: ${missing.join(', ')}`);
  say(`CHANGELOG.md: Unreleased becomes "## ${rel.version} — ${date}".`);

  if (dryRun) {
    say('Run pnpm docs:api and pnpm docs:cli.');
    say(`Commit "Release ${rel.version}", tag ${rel.tag}, push main and ${rel.tag}.`);
    say('Print the release workflow run to watch.');
    return problems.length > 0 ? 1 : 0;
  }

  if (stamped !== routesSource) writeFileSync(ROUTES_SRC, stamped);
  writeFileSync(CHANGELOG, changelog);
  run('pnpm', ['docs:api']);
  run('pnpm', ['docs:cli']);
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', `Release ${rel.version}`]);
  run('git', ['tag', rel.tag]);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', rel.tag]);

  // The run shows up a few seconds after the tag lands.
  let line;
  for (let i = 0; i < 15 && !line; i++) {
    const r = spawnSync('gh', ['run', 'list', '--workflow', 'release', '--limit', '1', '--json', 'databaseId,headBranch,status,url'], { cwd: root, encoding: 'utf8' });
    const runInfo = r.status === 0 ? JSON.parse(r.stdout || '[]')[0] : undefined;
    if (runInfo && runInfo.headBranch === rel.tag) line = runInfo;
    else await sleep(2000);
  }
  if (line) {
    console.log(`Release run ${line.databaseId} (${line.status}): ${line.url}`);
    console.log(`Watch it: gh run watch ${line.databaseId} --exit-status`);
  } else {
    console.log('The release run has not shown up yet: gh run list --workflow release --limit 1, then gh run watch <id> --exit-status');
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof ReleaseError || e instanceof ChangelogError) {
    console.error(e.message);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
