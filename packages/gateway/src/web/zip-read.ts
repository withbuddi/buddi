/**
 * Reading a `.zip` the owner uploaded, without trusting it.
 *
 * Written here rather than with fflate's `unzipSync` because the checks a
 * skill bundle needs live in the central directory, which that API does not
 * show: the Unix mode (a symbolic link, an executable bit), the encryption
 * flag, the declared sizes. Inflating goes through fflate's streaming
 * `Inflate`, counted as it goes, so a member that inflates past what it
 * declared — a zip bomb — stops at the first byte over.
 */
import { Inflate } from 'fflate';

export interface ZipEntry {
  name: string;
  /** Ends in `/`. */
  directory: boolean;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  /** The Unix mode when the archive was made on Unix, else null. */
  mode: number | null;
  /** Where the member's local header starts. */
  offset: number;
}

export class ZipFormatError extends Error {
  override readonly name = 'ZipFormatError';
}

export class ZipLimitError extends Error {
  override readonly name = 'ZipLimitError';
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The central directory, entry by entry. Throws `ZipFormatError` on anything that is not a plain zip. */
export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipFormatError('It is not a zip file (no central directory).');
  const count = view.getUint16(end + 10, true);
  const cdSize = view.getUint32(end + 12, true);
  const cdOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipFormatError('It is a zip64 archive, which a skill bundle never needs.');
  if (cdOffset + cdSize > zip.length) throw new ZipFormatError('Its central directory runs past the end of the file.');
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let at = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL) throw new ZipFormatError('Its central directory is damaged.');
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const offset = view.getUint32(at + 42, true);
    if (at + 46 + nameLength > zip.length) throw new ZipFormatError('Its central directory is damaged.');
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const unix = madeBy >> 8 === 3 || madeBy >> 8 === 19;
    const mode = unix ? (external >>> 16) & 0xffff : null;
    entries.push({ name, directory: name.endsWith('/'), method, encrypted: (flags & 1) === 1, compressedSize, size, mode: mode === 0 ? null : mode, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The mode's file type is a symbolic link. */
export function isSymlink(entry: Pick<ZipEntry, 'mode'>): boolean {
  return entry.mode !== null && (entry.mode & 0o170000) === 0o120000;
}

/** The mode has an executable bit, on a file. */
export function isExecutableMode(entry: Pick<ZipEntry, 'mode' | 'directory'>): boolean {
  return !entry.directory && entry.mode !== null && (entry.mode & 0o170000) !== 0o040000 && (entry.mode & 0o111) !== 0;
}

/**
 * One member's bytes. `limit` caps what it may inflate to (its declared size,
 * and what is left of the bundle's allowance); one byte more is a `ZipLimitError`.
 */
export function readZipMember(zip: Uint8Array, entry: ZipEntry, limit: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (entry.offset + 30 > zip.length || view.getUint32(entry.offset, true) !== LOCAL) throw new ZipFormatError(`"${entry.name}" is damaged.`);
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipFormatError(`"${entry.name}" runs past the end of the file.`);
  const cap = Math.min(limit, entry.size);
  if (entry.method === 0) {
    if (data.length > cap) throw new ZipLimitError(`"${entry.name}" is larger than it says.`);
    return data.slice();
  }
  if (entry.method !== 8) throw new ZipFormatError(`"${entry.name}" uses a compression buddi does not read (method ${entry.method}).`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) over = true;
    else chunks.push(chunk);
  });
  // Fed in slices, so a bomb is noticed after one slice's output, not after all of it.
  const SLICE = 16 * 1024;
  try {
    for (let i = 0; i < data.length && !over; i += SLICE) inflate.push(data.subarray(i, i + SLICE), i + SLICE >= data.length);
  } catch (err) {
    throw new ZipFormatError(`"${entry.name}" could not be inflated: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (over) throw new ZipLimitError(`"${entry.name}" inflates to more than it says (${entry.size} bytes).`);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
