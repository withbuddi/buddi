/**
 * Reading an Office package without trusting it: the one home of the zip
 * limit rule (`OFFICE_ZIP_LIMITS`) that every reader applies — the server's
 * text, render and fill for agents, the sheet engine, an Open in app import,
 * the page's previews.
 *
 * A zip's central directory says how large each part is, and a crafted file
 * can understate it. So the directory is checked first (`zipEntries`), and
 * then every part is inflated here, counted as it goes, and refused at the
 * first byte past what it declared. A parser buddi does not own (mammoth,
 * read-excel-file, docx-preview, the deck viewer) never sees the owner's
 * bytes: it gets `verifiedOfficePackage`'s copy, the same compressed parts
 * under a directory that states their true sizes, so whatever it inflates is
 * what was counted here. Reached through `@buddi/core/office-zip` (fflate's
 * inflate only), so the dashboard loads it with a preview, not before.
 */
import { Inflate, zipSync, type Zippable } from 'fflate';
import { OFFICE_FORMATS, OFFICE_ZIP_LIMITS, zipEntries, type OfficeKind, type ZipEntry } from './office-files.js';

/** The limits a package is read within: parts, bytes of each, bytes in all. */
export interface ZipLimits { entries: number; entryBytes: number; totalBytes: number }

const LOCAL = 0x04034b50;
/** Compressed bytes fed to the inflater at a time: a part that lies is stopped after one slice's output. */
const SLICE = 16 * 1024;

const isDirectory = (entry: ZipEntry): boolean => entry.name.endsWith('/');

/** Where an entry's compressed data is, from its local header, or why it cannot be found. */
function dataOf(bytes: Uint8Array, view: DataView, entry: ZipEntry): Uint8Array | string {
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) return `${entry.name} is damaged`;
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  if (start + entry.compressed > bytes.length) return `${entry.name} is damaged`;
  return bytes.subarray(start, start + entry.compressed);
}

/**
 * One part inflated, never past `entry.size`: its bytes (`keep`), else only
 * how many there are; or why it is refused.
 */
function inflatePart(data: Uint8Array, entry: ZipEntry, keep: boolean): Uint8Array | number | string {
  const over = `${entry.name} unpacks to more than its zip directory says`;
  if ((entry.flags & 1) === 1) return `${entry.name} is encrypted`;
  if (entry.method === 0) {
    if (data.length > entry.size) return over;
    return keep ? data.slice() : data.length;
  }
  if (entry.method !== 8) return `${entry.name} uses a compression buddi does not read`;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let past = false;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > entry.size) past = true;
    else if (keep) chunks.push(chunk);
  });
  try {
    for (let i = 0; i < data.length && !past; i += SLICE) inflate.push(data.subarray(i, i + SLICE), i + SLICE >= data.length);
    if (data.length === 0) inflate.push(data, true);
  } catch {
    return `${entry.name} is damaged`;
  }
  if (past) return over;
  if (!keep) return total;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** One entry of the directory with its compressed data. */
interface Located { entry: ZipEntry; data: Uint8Array }

/**
 * The directory, each name once, within the limits, each entry with its
 * data; refused when two entries' regions (local header and data) overlap —
 * a shared offset included — so no byte of the file is read, or copied
 * into the verified package, for two parts: what is copied is never more
 * than the file itself.
 */
function entriesOf(bytes: Uint8Array, limits: ZipLimits): Located[] | string {
  const entries = zipEntries(bytes, limits);
  if (typeof entries === 'string') return entries;
  const names = new Set<string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const located: Located[] = [];
  for (const entry of entries) {
    if (names.has(entry.name)) return `it names ${entry.name} twice`;
    names.add(entry.name);
    const data = dataOf(bytes, view, entry);
    if (typeof data === 'string') return data;
    located.push({ entry, data });
  }
  const regions = located
    .map(({ entry, data }) => ({ from: entry.offset, to: data.byteOffset - bytes.byteOffset + data.length }))
    .sort((a, b) => a.from - b.from);
  let copied = 0;
  for (let i = 0; i < regions.length; i++) {
    if (i > 0 && regions[i]!.from < regions[i - 1]!.to) return 'its parts overlap in the zip';
    copied += regions[i]!.to - regions[i]!.from;
  }
  if (copied > bytes.length) return 'its parts overlap in the zip';
  return located;
}

/**
 * A package's parts, by name, inflated within the limits: every part
 * `want` keeps (all of them by default), each refused past its declared
 * size. Why it cannot be read, as a string, otherwise.
 */
export function unzipOffice(bytes: Uint8Array, want: (name: string) => boolean = () => true, limits: ZipLimits = OFFICE_ZIP_LIMITS): Record<string, Uint8Array> | string {
  const entries = entriesOf(bytes, limits);
  if (typeof entries === 'string') return entries;
  const parts: Record<string, Uint8Array> = {};
  for (const { entry, data } of entries) {
    if (isDirectory(entry) || !want(entry.name)) continue;
    const part = inflatePart(data, entry, true);
    if (typeof part === 'string') return part;
    parts[entry.name] = part as Uint8Array;
  }
  return parts;
}

/** Each part with its compressed data and the size it truly inflates to, or why the package is refused. */
function verifiedParts(bytes: Uint8Array, kind: OfficeKind, limits: ZipLimits): Array<{ entry: ZipEntry; data: Uint8Array; size: number }> | string {
  const entries = entriesOf(bytes, limits);
  if (typeof entries === 'string') return entries;
  const names = new Set(entries.map((e) => e.entry.name));
  if (!names.has('[Content_Types].xml')) return 'it is not an Office package';
  const main = OFFICE_FORMATS[kind]!.main!;
  if (!names.has(main)) return `it has no ${main}`;
  const out: Array<{ entry: ZipEntry; data: Uint8Array; size: number }> = [];
  for (const { entry, data } of entries) {
    if (isDirectory(entry)) continue;
    const size = inflatePart(data, entry, false);
    if (typeof size === 'string') return size;
    out.push({ entry, data, size: size as number });
  }
  return out;
}

/**
 * Why these bytes are not a whole package of this kind buddi will read, or
 * null: within `OFFICE_ZIP_LIMITS` as each part truly inflates, with
 * `[Content_Types].xml` and the kind's main part. What an Open in app save
 * must be before it is imported (an app half way through writing leaves
 * something that is not), what a composed document must be before it is
 * saved, and what every reader checks first.
 */
export function officePackageProblem(bytes: Uint8Array, kind: OfficeKind, limits: ZipLimits = OFFICE_ZIP_LIMITS): string | null {
  const parts = verifiedParts(bytes, kind, limits);
  return typeof parts === 'string' ? parts : null;
}

/**
 * The package as a parser may be handed it: its parts' compressed bytes as
 * they are, under a fresh directory that states the size each truly inflates
 * to (directories and anything outside the parts dropped). Why it is refused
 * (`officePackageProblem`'s answer) as a string otherwise.
 */
export function verifiedOfficePackage(bytes: Uint8Array, kind: OfficeKind, limits: ZipLimits = OFFICE_ZIP_LIMITS): Uint8Array | string {
  const parts = verifiedParts(bytes, kind, limits);
  if (typeof parts === 'string') return parts;
  const encoder = new TextEncoder();
  const named = parts.map((p) => ({ ...p, name: encoder.encode(p.entry.name) }));
  const localBytes = named.reduce((n, p) => n + 30 + p.name.length + p.data.length, 0);
  const dirBytes = named.reduce((n, p) => n + 46 + p.name.length, 0);
  const out = new Uint8Array(localBytes + dirBytes + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const p of named) {
    offsets.push(at);
    view.setUint32(at, LOCAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x800, true); // UTF-8 names
    view.setUint16(at + 8, p.entry.method, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0x21, true); // 1980-01-01
    view.setUint32(at + 14, p.entry.crc, true);
    view.setUint32(at + 18, p.data.length, true);
    view.setUint32(at + 22, p.size, true);
    view.setUint16(at + 26, p.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(p.name, at + 30);
    out.set(p.data, at + 30 + p.name.length);
    at += 30 + p.name.length + p.data.length;
  }
  const dirAt = at;
  named.forEach((p, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x800, true);
    view.setUint16(at + 10, p.entry.method, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, 0x21, true);
    view.setUint32(at + 16, p.entry.crc, true);
    view.setUint32(at + 20, p.data.length, true);
    view.setUint32(at + 24, p.size, true);
    view.setUint16(at + 28, p.name.length, true);
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, named.length, true);
  view.setUint16(at + 10, named.length, true);
  view.setUint32(at + 12, at - dirAt, true);
  view.setUint32(at + 16, dirAt, true);
  return out;
}

/**
 * A package with some of its XML parts changed: each part `edit` returns new
 * text for is replaced, the rest kept as they are, all inflated within the
 * limits (`unzipOffice`). For a preview that must clean what a document says
 * before a parser draws it.
 */
export function editOfficePackage(bytes: Uint8Array, edit: (name: string, xml: string) => string | null, limits: ZipLimits = OFFICE_ZIP_LIMITS): Uint8Array | string {
  const parts = unzipOffice(bytes, () => true, limits);
  if (typeof parts === 'string') return parts;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const out: Zippable = {};
  for (const [name, data] of Object.entries(parts)) {
    const changed = /\.(xml|rels)$/i.test(name) ? edit(name, decoder.decode(data)) : null;
    out[name] = changed === null ? [data, { level: 0 }] : [encoder.encode(changed), { level: 6 }];
  }
  return zipSync(out);
}
