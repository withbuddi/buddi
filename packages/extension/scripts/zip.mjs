/*
 * The Chrome Web Store upload: `dist/` as a zip, manifest at the root.
 *
 * Two differences from the unpacked folder the tarball ships. The `key` is
 * dropped, because the store assigns its own id and refuses an upload that
 * pins one. And the version is stamped from the release, the same mapping the
 * build uses (`version.mjs`).
 *
 * The zip is written here rather than by a `zip` binary so the release does not
 * depend on one being installed, and so the test can read it back. Deflate
 * from node:zlib, the rest is the format's own few headers.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { stampManifest } from './version.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A zip of the given entries, deflated, with a fixed timestamp so the same
 * folder always makes the same bytes.
 * @param {Array<{ name: string, data: Buffer }>} entries
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 1980-01-01 00:00, the earliest DOS date: reproducible, and nobody reads it.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const file = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, file, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, file);
    offset += local.length + file.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** @param {string} dir @param {string} [prefix] @returns {Promise<string[]>} */
async function walk(dir, prefix = '') {
  const found = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(path.join(dir, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/**
 * The store build of a built `dist/`: every file, the manifest first and
 * without its `key`, stamped with `version`.
 * @param {string} dist
 * @param {string} version
 */
export async function storeZip(dist, version) {
  const files = await walk(dist);
  if (!files.includes('manifest.json')) throw new Error(`${dist} has no manifest.json. Build the extension first.`);
  const manifest = stampManifest(JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8')), version);
  delete manifest.key;
  const entries = [{ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }];
  for (const file of files) {
    if (file === 'manifest.json' || file.endsWith('.DS_Store')) continue;
    entries.push({ name: file, data: await readFile(path.join(dist, file)) });
  }
  return zip(entries);
}
