#!/usr/bin/env node
/**
 * pnpm review — the two reviews before a release, over the diff since the last tag.
 *
 *   pnpm review                       Codex reviews `git diff <last tag>..HEAD` into <out>/codex-review-<next>.md,
 *                                     then prints the brief for the Fable review agent the lead launches
 *   pnpm review --focus "the lock screen"   adds a line to the focus list (repeatable)
 *   pnpm review --print               prints the prompt and the brief, runs nothing
 *   pnpm review --out <dir>           where the files go (default $BUDDI_REVIEW_DIR or <tmp>/buddi-review)
 *   pnpm review --merge <fable-file>  puts Codex's and Fable's findings into <out>/review-<next>.md
 *
 * The pure parts (tags, the prompt, the brief, the merge) are exported and tested in review.test.mjs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionOf, ChangelogError } from './release/changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ReviewError extends Error {}

/** What every release review looks at, whatever changed. */
export const STANDARD_FOCUS = [
  'Secrets: nothing prints, logs or sends a key, token or password; the scrubber still covers new paths.',
  'Approvals and grants: every effectful tool or route still asks the owner; no new way around a card, a grant or confinement.',
  'Auth: new routes sit behind the dashboard sign-in and count failures; nothing new is reachable unauthenticated.',
  'Data: migrations are additive and idempotent; nothing deletes or overwrites owner data without asking.',
  'Races and restarts: leases, retries, timers and async UI state; what happens when buddi restarts mid-way.',
  'Tests: behaviour changes have tests that would fail without them; no test touches port 55433, a data dir or the keychain.',
  'UX: copy is plain and kind, the primary action sits on the right, empty and error states are handled, phone width works.',
];

/** The newest `v0.1.0-pre.N` tag in a list, and the version after it. */
export function lastPreTag(tags) {
  let best;
  for (const raw of tags) {
    const tag = raw.trim();
    const m = /^v(\d+\.\d+\.\d+)-pre\.(\d+)$/.exec(tag);
    if (!m) continue;
    const n = Number(m[2]);
    if (best === undefined || n > best.n) best = { tag, core: m[1], n };
  }
  if (best === undefined) throw new ReviewError('There is no v0.1.0-pre.N tag to review from.');
  return { tag: best.tag, n: best.n, next: `pre.${best.n + 1}`, nextVersion: `${best.core}-pre.${best.n + 1}` };
}

/** The CHANGELOG's Unreleased body, or a line saying it is empty. */
export function unreleasedSummary(changelog) {
  try { return sectionOf(changelog, 'unreleased'); }
  catch (error) {
    if (error instanceof ChangelogError) return '(Unreleased is empty: review the diff on its own.)';
    throw error;
  }
}

/** The release-review prompt Codex runs and the Fable agent is briefed with. */
export function buildPrompt({ tag, next, summary, focus = [] }) {
  const items = [...STANDARD_FOCUS, ...focus.map(f => f.trim()).filter(Boolean)];
  return [
    `You are reviewing buddi before release ${next}. Review every change since ${tag}:`,
    `run \`git diff ${tag}..HEAD\` (and \`git log --oneline ${tag}..HEAD\`) in this repository and read the changed files in full where a hunk is not enough.`,
    'Do not edit anything.',
    '',
    `## What changed (CHANGELOG.md, Unreleased)`,
    '',
    summary.trim(),
    '',
    '## Focus',
    '',
    ...items.map((item, i) => `${i + 1}. ${item}`),
    '',
    '## Report',
    '',
    'List findings only, most severe first. For each: a severity (blocker, major, minor), `file:line`,',
    'what is wrong in one or two sentences, why it matters, and the fix you suggest.',
    'Say plainly when you are unsure. Skip style nits and praise. End with one line: "N findings" or "No findings".',
  ].join('\n');
}

/** What the lead pastes into an Agent call for the Fable reviewer. */
export function buildFableBrief({ prompt, fableFile, repo }) {
  return [
    `In ${repo}, read-only (do not edit, commit or build).`,
    '',
    prompt,
    '',
    `Return the findings as your final message; the lead saves them to ${fableFile}`,
    `and runs \`pnpm review --merge ${fableFile}\`.`,
  ].join('\n');
}

/** Both reviews in one findings file. */
export function mergeFindings({ next, codex, fable }) {
  const part = (title, text) => [`## ${title}`, '', (text ?? '').trim() || '(no output)', ''];
  return [
    `# Review before ${next}`,
    '',
    'Two independent reviews over the same diff. A finding both name is the first to fix.',
    '',
    ...part('Codex', codex),
    ...part('Fable', fable),
  ].join('\n');
}

export function parseArgs(argv) {
  const opts = { focus: [], print: false, out: undefined, merge: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = name => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new ReviewError(`${name} needs a value.`);
      return v;
    };
    if (a === '--') continue;
    else if (a === '--print') opts.print = true;
    else if (a === '--focus') opts.focus.push(value('--focus'));
    else if (a === '--out') opts.out = value('--out');
    else if (a === '--merge') opts.merge = value('--merge');
    else throw new ReviewError(`Unknown argument ${a}.`);
  }
  return opts;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new ReviewError(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function main(argv) {
  const opts = parseArgs(argv);
  const out = path.resolve(opts.out || process.env.BUDDI_REVIEW_DIR?.trim() || path.join(os.tmpdir(), 'buddi-review'));
  const last = lastPreTag(git(['tag', '--list', 'v*-pre.*']).split('\n'));
  const codexFile = path.join(out, `codex-review-${last.next}.md`);
  const fableFile = path.join(out, `fable-review-${last.next}.md`);

  if (opts.merge !== undefined) {
    const fable = readFileSync(path.resolve(opts.merge), 'utf8');
    const codex = existsSync(codexFile) ? readFileSync(codexFile, 'utf8') : `(no Codex review at ${codexFile})`;
    const merged = path.join(out, `review-${last.next}.md`);
    mkdirSync(out, { recursive: true });
    writeFileSync(merged, mergeFindings({ next: last.next, codex, fable }));
    console.log(`Findings: ${merged}`);
    return 0;
  }

  const summary = unreleasedSummary(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
  const prompt = buildPrompt({ tag: last.tag, next: last.next, summary, focus: opts.focus });
  const brief = buildFableBrief({ prompt, fableFile, repo: ROOT });
  const commits = git(['rev-list', '--count', `${last.tag}..HEAD`]).trim();

  if (opts.print) {
    console.log(`# Codex prompt (${commits} commits since ${last.tag})\n\n${prompt}\n\n# Fable brief\n\n${brief}`);
    return 0;
  }

  mkdirSync(out, { recursive: true });
  console.log(`Codex is reviewing ${commits} commits since ${last.tag} into ${codexFile} …`);
  const fd = openSync(codexFile, 'w');
  const r = spawnSync('codex', ['exec', '--sandbox', 'read-only', prompt], { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] });
  closeSync(fd);
  if (r.error) throw new ReviewError(`codex did not start: ${r.error.message}`);
  if (r.status !== 0) console.error(`codex exited with ${r.status}; what it wrote is in ${codexFile}.`);
  else console.log(`Codex review: ${codexFile}`);
  console.log(`\nLaunch the Fable review as an agent (no model override) with this brief:\n\n${brief}\n`);
  console.log(`Then: pnpm review --merge ${fableFile}`);
  return r.status === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
