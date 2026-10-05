#!/usr/bin/env node
/**
 * Release flow v2: does this push to main tag a release? (docs/release.md)
 *
 * `pnpm release pre.N` commits "Release <version>" with `release/REQUEST.json`
 * ({ version, from }) and pushes main; no tag. On every push to main the
 * release workflow (and ci.yml, to skip its own gate) asks this file:
 *
 *   - The marker is the commit that last changed release/REQUEST.json. It
 *     counts only when its subject is exactly "Release <version>" for the
 *     version the file names (both, so neither a stray commit message nor a
 *     hand edit of the file starts a release).
 *   - It must be one of the last WINDOW first-parent commits of HEAD. Fixes
 *     pushed on top of it are fine: the tag goes on HEAD, the fixes included.
 *   - The tag `v<version>` must not exist on origin yet; if it does, nothing.
 *   - The version's core (0.1.0 of 0.1.0-pre.N) must be the root
 *     package.json's version, else the run fails.
 *
 * `decide()` is the pure rule (plan.test.mjs); the CLI gathers its input from
 * git:
 *
 *   node scripts/release/plan.mjs             JSON on stdout
 *   node scripts/release/plan.mjs --github    also GITHUB_OUTPUT and annotations;
 *                                             exit 1 when the plan is `fail`
 *   node scripts/release/plan.mjs --verify V  for the publish run on tag vV:
 *                                             HEAD's request and package.json agree with V
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUEST_PATH = 'release/REQUEST.json';
/** How many first-parent commits back from HEAD a release request still counts. */
export const WINDOW = 50;

const VERSION = /^(\d+\.\d+\.\d+)(?:-pre\.([1-9]\d*))?$/;

/** The JSON a release commit writes to release/REQUEST.json. */
export function requestFile(version, from) {
  return `${JSON.stringify({ version, from }, null, 2)}\n`;
}

/** `{ version }` from the file's text, or a reason it is not a request. */
export function parseRequest(text) {
  if (text == null) return { error: 'missing' };
  let data;
  try { data = JSON.parse(text); } catch { return { error: `${REQUEST_PATH} is not JSON.` }; }
  const version = typeof data?.version === 'string' ? data.version : '';
  if (!VERSION.test(version)) return { error: `${REQUEST_PATH} names "${version}", not a version like 0.1.0-pre.44.` };
  return { version, from: typeof data.from === 'string' ? data.from : undefined };
}

/** Null when `version` belongs to the workspace at `packageVersion`, else why not. */
export function versionMismatch(version, packageVersion) {
  const core = VERSION.exec(version)?.[1];
  if (core === packageVersion) return null;
  return `The release request names ${version}, but package.json is at ${packageVersion}: a release of ${packageVersion} would be ${packageVersion}-pre.N.`;
}

/**
 * The plan for one push.
 *
 * @param {object} input
 * @param {string} input.head         the commit the run is for
 * @param {{sha: string, subject: string}[]} input.commits  HEAD's first-parent history, newest first (WINDOW of them)
 * @param {string|null} input.markerSha  the commit that last changed release/REQUEST.json (any depth), or null
 * @param {string|null} input.requestText  release/REQUEST.json at HEAD, or null
 * @param {string} input.packageVersion  the root package.json's version at HEAD
 * @param {(tag: string) => boolean} input.tagExists  on origin
 * @returns {{action: 'tag'|'none'|'fail', reason: string, version?: string, tag?: string, sha?: string, marker?: string, onTop?: number, warning?: boolean}}
 */
export function decide({ head, commits, markerSha, requestText, packageVersion, tagExists }) {
  if (requestText == null || markerSha == null) return { action: 'none', reason: `No ${REQUEST_PATH}: not a release.` };
  const request = parseRequest(requestText);
  if (request.error) return { action: 'fail', reason: request.error };
  const { version } = request;
  const tag = `v${version}`;
  if (tagExists(tag)) return { action: 'none', reason: `${tag} already exists: nothing to release.`, version, tag };

  const index = commits.findIndex((c) => c.sha === markerSha);
  if (index < 0) {
    return {
      action: 'none',
      warning: true,
      reason: `The request for ${version} (${markerSha.slice(0, 8)}) is more than ${commits.length} commits behind HEAD and was never tagged; it has gone stale. Cut it again (docs/release.md).`,
      version,
      tag,
    };
  }
  const marker = commits[index];
  if (marker.subject !== `Release ${version}`) {
    return {
      action: 'fail',
      reason: `${REQUEST_PATH} names ${version} but was last changed by "${marker.subject}" (${marker.sha.slice(0, 8)}), not "Release ${version}". Only \`pnpm release\` writes it.`,
      version,
      tag,
    };
  }
  const mismatch = versionMismatch(version, packageVersion);
  if (mismatch) return { action: 'fail', reason: mismatch, version, tag };
  const onTop = index === 0 ? 'the release commit itself' : `the release commit ${marker.sha.slice(0, 8)} and ${index} commit(s) on top`;
  return {
    action: 'tag',
    reason: `Release ${version}: gate ${head.slice(0, 8)} (${onTop}), then tag it ${tag}.`,
    version,
    tag,
    sha: head,
    marker: marker.sha,
    onTop: index,
  };
}

/** For a publish run on tag v<version>: null when HEAD's request and package.json agree, else why not. */
export function checkPublish({ version, requestText, packageVersion }) {
  const request = parseRequest(requestText);
  if (request.error) return request.error === 'missing' ? `The tag v${version} has no ${REQUEST_PATH}: it was not cut by release flow v2.` : request.error;
  if (request.version !== version) return `The tag v${version} carries a request for ${request.version}.`;
  return versionMismatch(version, packageVersion);
}

// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(...a) {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

function gather() {
  const head = process.env.GITHUB_SHA || git('rev-parse', 'HEAD').out;
  const commits = git('log', `-n${WINDOW}`, '--first-parent', '--format=%H%x09%s', head).out
    .split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  const markerSha = git('log', '-1', '--first-parent', '--format=%H', head, '--', REQUEST_PATH).out || null;
  const shown = git('show', `${head}:${REQUEST_PATH}`);
  const packageVersion = JSON.parse(git('show', `${head}:package.json`).out).version;
  const tagExists = (tag) => {
    const r = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { cwd: root, encoding: 'utf8' });
    if (r.status === 0) return true;
    if (r.status === 2) return false; // --exit-code: no matching ref
    throw new Error(`git ls-remote origin failed (exit ${r.status}): ${(r.stderr ?? '').trim()}`);
  };
  return { head, commits, markerSha, requestText: shown.ok ? shown.out : null, packageVersion, tagExists };
}

function output(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(pairs).map(([k, v]) => `${k}=${v ?? ''}\n`).join(''));
}

function main(argv) {
  const github = argv.includes('--github');
  const verifyAt = argv.indexOf('--verify');
  if (verifyAt >= 0) {
    const version = String(argv[verifyAt + 1] ?? '').replace(/^v/, '');
    const shown = git('show', `HEAD:${REQUEST_PATH}`);
    const problem = checkPublish({
      version,
      requestText: shown.ok ? shown.out : null,
      packageVersion: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    });
    if (problem) { console.log(github ? `::error title=Not publishing::${problem}` : problem); return 1; }
    console.log(`v${version} is a release request for ${version}; package.json agrees.`);
    return 0;
  }

  const plan = decide(gather());
  console.log(JSON.stringify(plan, null, 2));
  if (github) {
    output({ action: plan.action, version: plan.version, tag: plan.tag, sha: plan.sha });
    const level = plan.action === 'fail' ? 'error' : plan.warning ? 'warning' : 'notice';
    console.log(`::${level} title=Release plan: ${plan.action}::${plan.reason}`);
  }
  return plan.action === 'fail' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
