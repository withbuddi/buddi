/**
 * Skill bundles, the upload half (specs/skills-zone.md, part 2): a `.zip`
 * holding a SKILL.md with `scripts/` and `assets/` beside it.
 *
 * Nothing in a bundle runs here, ever. The upload is streamed to a temporary
 * folder, read and checked before anything is kept — size, file count, a
 * SKILL.md with front matter, no absolute paths, no `..`, no links, nothing
 * executable outside `scripts/` — and unpacked into a staging folder the
 * preview reads from. Only the owner's "Add the skill" moves it into the
 * skills folder (skills.ts, `acceptBundleRoute`); a staged upload nobody
 * accepted is swept after an hour.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { zipSync } from 'fflate';
import { BUNDLE_SKILL_FILE, BUNDLE_SCRIPTS_DIR, splitFrontmatter } from '@buddi/core';
import { isExecutableMode, isSymlink, readZipEntries, readZipMember, ZipFormatError, ZipLimitError, type ZipEntry } from './zip-read.js';

export interface RouteReply {
  status: number;
  body: unknown;
}

/** A bundle is at most this big unpacked. */
export const BUNDLE_MAX_BYTES = 20 * 1024 * 1024;
/** A bundle holds at most this many files. */
export const BUNDLE_MAX_FILES = 500;
/** The upload itself: a zip a little over the unpacked limit (stored members carry headers). */
const UPLOAD_MAX_BYTES = BUNDLE_MAX_BYTES + 1024 * 1024;
/** A staged upload nobody accepted goes after this long. */
const STAGED_TTL_MS = 60 * 60 * 1000;
/** The largest file the viewer shows as text. */
const VIEW_TEXT_MAX = 256 * 1024;

export type RefusalKind = 'notzip' | 'big' | 'count' | 'noskill' | 'paths' | 'frontmatter' | 'executable' | 'damaged';

export interface Refusal {
  kind: RefusalKind;
  filename: string;
  /** Bytes, for `big`: unpacked, or the upload's own size when it was stopped on the way in. */
  size?: number;
  /** For `count`. */
  files?: number;
  /** For `paths` and `executable`: each entry and why. */
  entries?: Array<{ path: string; why: string; target?: string }>;
  /** For `noskill`: where buddi looked (`''` is the top). */
  looked?: string[];
}

export type FileKind = 'skill' | 'script' | 'font' | 'image' | 'template' | 'data' | 'other';

export interface BundleFileRow {
  path: string;
  size: number;
  kind: FileKind;
  /** A script whose name says it sets things up (`setup.sh`, `install.py`). */
  setup?: boolean;
}

export interface StagedBundle {
  id: string;
  filename: string;
  /** The zip's own size. */
  packed: number;
  /** Unpacked. */
  size: number;
  files: BundleFileRow[];
  scripts: string[];
  skill: { name: string; title: string; description: string; firstLines: string; body: string; network?: boolean };
  createdAt: string;
}

const refuse = (status: number, refusal: Refusal, error: string): RouteReply => ({ status, body: { error, refusal } });

/* ------------------------------------------------------------------ *
 * kinds
 * ------------------------------------------------------------------ */

const FONT = /\.(ttf|otf|woff2?)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const DATA = /\.(json|csv|tsv|ya?ml|toml|xml)$/i;
const TEMPLATE = /\.(md|markdown|txt|html?|css|tex|rtf)$/i;
/** Kept out of everywhere but `scripts/`: what runs, or what a shell or a loader runs. */
const EXECUTABLE_EXT = /\.(sh|bash|zsh|fish|command|py|pyc|rb|pl|php|js|mjs|cjs|ts|exe|dll|so|dylib|bat|cmd|ps1|vbs|jar|app|bin|elf|msi|scpt|applescript)$/i;
const RASTER: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function fileKind(rel: string): FileKind {
  if (rel === BUNDLE_SKILL_FILE) return 'skill';
  if (rel.startsWith(`${BUNDLE_SCRIPTS_DIR}/`)) return 'script';
  if (FONT.test(rel)) return 'font';
  if (IMAGE.test(rel)) return 'image';
  if (DATA.test(rel)) return 'data';
  if (TEMPLATE.test(rel)) return 'template';
  return 'other';
}

function rowOf(rel: string, size: number): BundleFileRow {
  const kind = fileKind(rel);
  const setup = kind === 'script' && /^(setup|install|bootstrap)([._-]|$)/i.test(path.posix.basename(rel));
  return { path: rel, size, kind, ...(setup ? { setup: true } : {}) };
}

/** Every file in a bundle's folder, SKILL.md first, then by path. */
export function bundleFileRows(dir: string): BundleFileRow[] {
  const rows: BundleFileRow[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) rows.push(rowOf(child, statSync(path.join(dir, child)).size));
    }
  };
  walk('');
  return rows.sort((a, b) => (a.path === BUNDLE_SKILL_FILE ? -1 : b.path === BUNDLE_SKILL_FILE ? 1 : a.path.localeCompare(b.path)));
}

/* ------------------------------------------------------------------ *
 * receiving the upload
 * ------------------------------------------------------------------ */

/** The staging folder: `<private>/.incoming/skills` beside the skills folder. */
export function incomingDirFor(skillsDir: string): string {
  return path.join(path.dirname(path.resolve(skillsDir)), '.incoming', 'skills');
}

/** The filename the browser sent, as a label: its base name, no quotes or line breaks. */
export function uploadLabel(claimed: string | undefined): string {
  let name = claimed ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // As sent.
  }
  return path.basename(name.replace(/\\/g, '/')).replace(/[\r\n"]/g, '').trim().slice(0, 200) || 'bundle.zip';
}

/**
 * Stream the request body to a temporary file, counted as it arrives and
 * abandoned the moment it crosses the cap. Returns the path, or the refusal.
 */
export async function receiveBundleUpload(incomingDir: string, req: IncomingMessage, filename: string): Promise<{ path: string } | RouteReply> {
  if (!/\.zip$/i.test(filename)) {
    return refuse(415, { kind: 'notzip', filename }, `“${filename}” isn’t a .zip or a .md. A skill is one Markdown file, or a .zip bundle with SKILL.md inside.`);
  }
  sweepStaged(incomingDir);
  await mkdir(incomingDir, { recursive: true, mode: 0o700 });
  const target = path.join(incomingDir, `${randomUUID()}.zip`);
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
    req.resume();
    return refuse(413, { kind: 'big', filename, size: declared }, tooBigSentence(filename, declared));
  }
  let bytes = 0;
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > UPLOAD_MAX_BYTES && !tooBig) {
      tooBig = true;
      req.destroy(new Error('too big'));
    }
  });
  try {
    await pipeline(req, createWriteStream(target, { mode: 0o600 }));
  } catch (err) {
    await rm(target, { force: true }).catch(() => {});
    if (tooBig) return refuse(413, { kind: 'big', filename, size: bytes }, tooBigSentence(filename, bytes));
    return { status: 400, body: { error: `The upload did not finish: ${err instanceof Error ? err.message : String(err)}` } };
  }
  if (bytes === 0) {
    await rm(target, { force: true }).catch(() => {});
    return { status: 400, body: { error: 'That upload was empty.' } };
  }
  return { path: target };
}

function mb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function tooBigSentence(filename: string, size: number): string {
  return `“${filename}” is too big: it’s ${mb(size)}; a bundle can be up to ${mb(BUNDLE_MAX_BYTES)} unpacked. Leave large files out — SKILL.md can say where to find them.`;
}

/** Staged uploads older than an hour, and stray zips, go. */
export function sweepStaged(incomingDir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(incomingDir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(incomingDir, name);
    try {
      if (now - lstatSync(full).mtimeMs > STAGED_TTL_MS) rmSync(full, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

/* ------------------------------------------------------------------ *
 * checking and unpacking
 * ------------------------------------------------------------------ */

const IGNORED = (name: string): boolean => name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name);

/** Why a member's path is refused, or null. */
function pathProblem(name: string): string | null {
  if (name.includes('\0')) return 'has a NUL in its name';
  if (name.includes('\\')) return 'uses backslashes, which can climb out on some systems';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'is an absolute path';
  if (name.split('/').some((part) => part === '..')) return 'climbs out of the folder';
  return null;
}

/** Bytes that start a program: ELF, Mach-O (thin and fat), a Windows executable. */
function looksLikeProgram(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const b = (i: number): number => bytes[i] as number;
  const word = ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0;
  if (word === 0x7f454c46) return true;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(word)) return true;
  return b(0) === 0x4d && b(1) === 0x5a;
}

/** The lenient read of SKILL.md's front matter: the top-level `key: value` lines, nested maps skipped. */
export function readBundleFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  let split;
  try {
    split = splitFrontmatter(text.replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  } catch {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const line of split.frontmatter.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[2] as string).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value !== '' && value !== '|' && value !== '>') fields[(m[1] as string).toLowerCase()] = value;
  }
  return { fields, body: split.body };
}

/**
 * Read the zip at `zipPath`, check it, and unpack it into a staging folder.
 * Answers the preview, or the refusal with what buddi saw. The zip is
 * removed either way.
 */
export function stageBundle(incomingDir: string, zipPath: string, filename: string, now: Date): RouteReply {
  try {
    return stage(incomingDir, zipPath, filename, now);
  } finally {
    rmSync(zipPath, { force: true });
  }
}

function stage(incomingDir: string, zipPath: string, filename: string, now: Date): RouteReply {
  const zip = new Uint8Array(readFileSync(zipPath));
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(zip).filter((e) => !IGNORED(e.name));
  } catch (err) {
    return refuse(422, { kind: 'notzip', filename }, `“${filename}” could not be read as a zip: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Paths and links first: one bad entry and nothing is unpacked.
  const bad: NonNullable<Refusal['entries']> = [];
  for (const e of entries) {
    const problem = pathProblem(e.name);
    if (problem) bad.push({ path: e.name, why: problem });
    else if (isSymlink(e)) {
      let target: string | undefined;
      try {
        target = new TextDecoder().decode(readZipMember(zip, e, 4096)).slice(0, 200);
      } catch {
        target = undefined;
      }
      bad.push({ path: e.name, why: 'is a link', ...(target ? { target } : {}) });
    } else if (e.encrypted) bad.push({ path: e.name, why: 'is encrypted' });
  }
  if (bad.length > 0) {
    return refuse(
      422,
      { kind: 'paths', filename, entries: bad },
      `“${filename}” was refused: ${bad.length === 1 ? 'one entry reaches' : `${bad.length} entries reach`} outside the bundle or can’t be read (${bad.map((b) => `${b.path} ${b.why}`).join('; ')}), so nothing was unpacked.`,
    );
  }

  const files = entries.filter((e) => !e.directory);
  if (files.length > BUNDLE_MAX_FILES) {
    return refuse(422, { kind: 'count', filename, files: files.length }, `“${filename}” holds ${files.length} files; a bundle can hold up to ${BUNDLE_MAX_FILES}.`);
  }
  const declared = files.reduce((sum, e) => sum + e.size, 0);
  if (declared > BUNDLE_MAX_BYTES) return refuse(413, { kind: 'big', filename, size: declared }, tooBigSentence(filename, declared));

  // Where SKILL.md is: at the top, or inside the one folder everything sits in.
  const tops = new Set(entries.map((e) => e.name.split('/')[0] as string));
  const single = tops.size === 1 && entries.some((e) => e.name.includes('/')) ? `${[...tops][0]}/` : null;
  const prefix = files.some((e) => e.name === BUNDLE_SKILL_FILE) ? '' : single && files.some((e) => e.name === `${single}${BUNDLE_SKILL_FILE}`) ? single : null;
  if (prefix === null) {
    return refuse(
      422,
      { kind: 'noskill', filename, looked: single ? ['', single] : [''] },
      `No SKILL.md in “${filename}”. buddi looked at the top${single ? ` and inside ${single}` : ''}. A bundle needs SKILL.md in one of them, with scripts/ and assets/ beside it.`,
    );
  }
  const rel = (e: ZipEntry): string => e.name.slice(prefix.length);

  // Executables outside scripts/: by mode and by name, then by their first bytes as they unpack.
  const executables: NonNullable<Refusal['entries']> = [];
  for (const e of files) {
    const r = rel(e);
    if (r.startsWith(`${BUNDLE_SCRIPTS_DIR}/`)) continue;
    if (isExecutableMode(e)) executables.push({ path: r, why: 'is marked executable' });
    else if (EXECUTABLE_EXT.test(r)) executables.push({ path: r, why: 'is a script or a program' });
  }

  const id = randomUUID();
  const root = path.join(incomingDir, id);
  const filesDir = path.join(root, 'files');
  const rows: BundleFileRow[] = [];
  let unpacked = 0;
  try {
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    for (const e of files) {
      const r = rel(e);
      let bytes: Uint8Array;
      try {
        bytes = readZipMember(zip, e, BUNDLE_MAX_BYTES - unpacked);
      } catch (err) {
        rmSync(root, { recursive: true, force: true });
        if (err instanceof ZipLimitError) {
          return refuse(413, { kind: 'big', filename, size: declared }, `“${filename}” was refused: ${err.message} Nothing was kept.`);
        }
        if (err instanceof ZipFormatError) return refuse(422, { kind: 'damaged', filename }, `“${filename}” is damaged: ${err.message}`);
        throw err;
      }
      unpacked += bytes.length;
      if (!r.startsWith(`${BUNDLE_SCRIPTS_DIR}/`) && looksLikeProgram(bytes) && !executables.some((x) => x.path === r)) {
        executables.push({ path: r, why: 'is a program' });
      }
      const target = path.join(filesDir, r);
      if (!target.startsWith(filesDir + path.sep)) throw new Error(`refusing ${r}`);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, bytes, { mode: 0o644, flag: 'wx' });
      rows.push(rowOf(r, bytes.length));
    }
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return refuse(422, { kind: 'damaged', filename }, `“${filename}” lists the same file twice, so it was refused.`);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR' || code === 'EISDIR') {
      return refuse(422, { kind: 'damaged', filename }, `“${filename}” holds a file and a folder with the same name, so it was refused.`);
    }
    throw err;
  }
  if (executables.length > 0) {
    rmSync(root, { recursive: true, force: true });
    return refuse(
      422,
      { kind: 'executable', filename, entries: executables },
      `“${filename}” was refused: ${executables.map((x) => `${x.path} ${x.why}`).join('; ')}. A bundle keeps anything that runs in scripts/.`,
    );
  }

  const skillText = readFileSync(path.join(filesDir, BUNDLE_SKILL_FILE), 'utf8');
  const fm = readBundleFrontmatter(skillText);
  const description = fm?.fields.description ?? '';
  if (!fm || description === '' || fm.body.trim() === '') {
    rmSync(root, { recursive: true, force: true });
    return refuse(
      422,
      { kind: 'frontmatter', filename },
      `“${filename}”’s SKILL.md needs front matter with a description (when it’s used) between --- lines, then the steps.`,
    );
  }
  const body = fm.body.trim();
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const named = fm.fields.name ?? '';
  const words = (named || filename.replace(/\.zip$/i, '')).replace(/[-_]+/g, ' ').trim();
  const title = (fm.fields.title ?? heading ?? (words.charAt(0).toUpperCase() + words.slice(1))).slice(0, 80);
  const firstLines = body.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  rows.sort((a, b) => (a.path === BUNDLE_SKILL_FILE ? -1 : b.path === BUNDLE_SKILL_FILE ? 1 : a.path.localeCompare(b.path)));
  const staged: StagedBundle = {
    id,
    filename,
    packed: zip.length,
    size: unpacked,
    files: rows,
    scripts: rows.filter((r) => r.kind === 'script').map((r) => r.path),
    skill: { name: named, title, description: description.slice(0, 300), firstLines, body, ...(fm.fields.network === 'true' ? { network: true } : {}) },
    createdAt: now.toISOString(),
  };
  writeFileSync(path.join(root, 'meta.json'), JSON.stringify(staged), { mode: 0o600 });
  return { status: 200, body: { staged: previewOf(staged) } };
}

/** What the preview shows: everything but the whole text. */
function previewOf(staged: StagedBundle): Omit<StagedBundle, 'skill'> & { skill: Omit<StagedBundle['skill'], 'body'> } {
  const { body: _body, ...skill } = staged.skill;
  return { ...staged, skill };
}

const STAGED_ID = /^[0-9a-f-]{36}$/;

/** A staged upload by its id: its meta and the folder its files are in. Null when it is gone. */
export function readStaged(incomingDir: string, id: string): { staged: StagedBundle; dir: string; root: string } | null {
  if (!STAGED_ID.test(id)) return null;
  const root = path.join(incomingDir, id);
  try {
    const staged = JSON.parse(readFileSync(path.join(root, 'meta.json'), 'utf8')) as StagedBundle;
    return { staged, dir: path.join(root, 'files'), root };
  } catch {
    return null;
  }
}

export function discardStaged(incomingDir: string, id: string): RouteReply {
  const found = readStaged(incomingDir, id);
  if (found) rmSync(found.root, { recursive: true, force: true });
  return { status: 200, body: { discarded: id } };
}

/* ------------------------------------------------------------------ *
 * reading one file, for the viewer
 * ------------------------------------------------------------------ */

/** A path inside `dir`, or null when it names anything else (or a link). */
export function bundlePath(dir: string, rel: string): string | null {
  if (!rel || pathProblem(rel) || rel.split('/').some((p) => p === '' || p === '.')) return null;
  const full = path.join(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) return null;
  try {
    const st = lstatSync(full);
    return st.isFile() ? full : null;
  } catch {
    return null;
  }
}

/** `{ path, size, kind, text }` for a text file, `{ …, binary: true }` (and `image` for a picture) for the rest. */
export function bundleFileView(dir: string, rel: string): RouteReply {
  const full = bundlePath(dir, rel);
  if (!full) return { status: 404, body: { error: `There is no file "${rel}" in this bundle.` } };
  const row = rowOf(rel, statSync(full).size);
  const image = RASTER[path.extname(rel).toLowerCase()] !== undefined;
  if (row.kind === 'font' || (image && !/\.svg$/i.test(rel)) || row.size > VIEW_TEXT_MAX) {
    return { status: 200, body: { file: { ...row, binary: true, ...(image ? { image: true } : {}) } } };
  }
  const bytes = readFileSync(full);
  if (bytes.subarray(0, 8192).includes(0)) return { status: 200, body: { file: { ...row, binary: true } } };
  return { status: 200, body: { file: { ...row, text: bytes.toString('utf8'), ...(image ? { image: true } : {}) } } };
}

/** A picture's bytes and type, for the viewer's <img>. Null for anything that is not a picture. */
export function bundleImage(dir: string, rel: string): { bytes: Buffer; type: string } | null {
  const type = RASTER[path.extname(rel).toLowerCase()];
  const full = type ? bundlePath(dir, rel) : null;
  if (!full || !type) return null;
  return { bytes: readFileSync(full), type };
}

/** The bundle as a .zip, its folder at the top, for Download. */
export function zipBundle(dir: string, name: string): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const row of bundleFileRows(dir)) tree[`${name}/${row.path}`] = new Uint8Array(readFileSync(path.join(dir, row.path)));
  return zipSync(tree, { level: 6 });
}

/** Whether a folder exists (for the accept's collision check). */
export function folderExists(dir: string): boolean {
  return existsSync(dir);
}
