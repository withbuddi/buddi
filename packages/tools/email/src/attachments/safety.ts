/**
 * What buddi will and will not put in the owner's library (docs/email.md §10).
 *
 * Three layers, in the order they can be applied:
 *
 *  1. **The name**, normalised once and then used for everything — the check,
 *     the artifact row, the download header. A check that reads one string and
 *     a save that writes another is not a check.
 *  2. **The declared type**, which the sender wrote and which is therefore a
 *     hint rather than a fact.
 *  3. **The first bytes**, once they are here. This is the only layer that
 *     knows anything: a PE renamed `invoice.pdf` passes the first two and dies
 *     on `MZ`.
 *
 * None of this is a virus scanner and it is not trying to be. It is the line
 * between "a document arrived in the post" and "a program the owner can now
 * double-click out of their own file library", and mail is exactly where the
 * second one turns up wearing the first one's name.
 */

/**
 * A well-formed IMAP body part id: `2`, `1.3`, `4.1.2`.
 *
 * Checked at ingest and again immediately before the download. It goes into a
 * `FETCH BODY.PEEK[<part>]` command, and while the adapters here pass it as a
 * value rather than splicing it into a command line, a part id is a position
 * in a MIME tree and anything that is not one cannot be a position. A stored
 * row holding something else is a row to refuse, not to send to a server.
 */
export const PART_PATTERN = /^[1-9]\d*(?:\.[1-9]\d*)*$/;

export function isPartId(value: string | null | undefined): value is string {
  return typeof value === 'string' && PART_PATTERN.test(value);
}

/** Bidi and invisible formatting characters. `invoice\u202Efdp.exe` reads as a PDF. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A filename is a name, not a path, and 255 bytes is every filesystem's wall. */
export const MAX_FILENAME = 255;

/**
 * One filename, as everything downstream should see it.
 *
 * Applied **once**, before the refusal check and before `saveArtifact`, so the
 * string that was judged is the string that is stored. The trailing strip is
 * the one that matters most: Windows removes trailing dots and spaces before
 * it executes, so `invoice.exe ` and `invoice.exe.` are both `invoice.exe` to
 * the thing that runs it and were both invisible to a `/\.([a-z0-9]{1,8})$/`
 * that read the raw name.
 */
export function safeFilename(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let name = String(raw).normalize('NFC').replace(INVISIBLE, '');
  // A name, never a path: take the last segment under either separator, so a
  // sender cannot propose `../../x` or `C:\\windows\\y` as a filename.
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (cut >= 0) name = name.slice(cut + 1);
  // Windows strips these before executing; so does this, before judging.
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (name.length > MAX_FILENAME) name = name.slice(0, MAX_FILENAME);
  return name === '' ? null : name;
}

/** The extension of an already-`safeFilename`d name, lowercase, without the dot. */
export function extensionOf(filename: string | null): string {
  return (filename ?? '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '';
}

/**
 * Extensions that name a program, a script, an installer, a mountable image or
 * a macro-carrying document.
 *
 * The macro formats are here because `.xlsm` is a spreadsheet that runs code
 * on open, which is the same problem in a friendlier wrapper — and because
 * "the invoice is in the attached spreadsheet" is the single most worn path
 * into a small business.
 */
export const REFUSED_EXTENSIONS = [
  // Windows executables and shortcuts
  'exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'msp', 'cpl', 'msc', 'scf', 'lnk', 'url',
  'reg', 'chm', 'hta', 'appx',
  // Scripting hosts
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'sh', 'py', 'command',
  // Bundles and packages that mount or install
  'jar', 'apk', 'dmg', 'pkg', 'app', 'iso', 'img', 'vhd', 'vhdx',
  // Office documents that carry macros
  'docm', 'xlsm', 'pptm', 'xlam', 'dotm',
] as const;

export const REFUSED_MIMES = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-ms-shortcut',
  'application/java-archive',
  'application/x-apple-diskimage',
  'application/hta',
  'application/x-sh',
  'application/x-shellscript',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/vnd.android.package-archive',
] as const;

/** `application/vnd.ms-word.document.macroEnabled.12` and its whole family. */
const MACRO_MIME = /^application\/vnd\.ms-[a-z0-9-]+\.[a-z0-9.-]*macroenabled(\.\d+)?$/;

/** The bare type, without the parameters a sender may hang off it. */
export function bareMime(mime: string | null | undefined): string {
  return (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
}

/** The sentence that says no, in the owner's terms. One shape, three reasons. */
function refusal(what: string): string {
  return (
    `${what}; buddi does not put programs in the owner's library, because mail is ` +
    'exactly where one arrives pretending to be an invoice'
  );
}

/**
 * Why this file is refused on its name or its declared type, or null.
 *
 * `filename` must already have been through `safeFilename`.
 */
export function declaredRefusal(filename: string | null, mime: string): string | null {
  const ext = extensionOf(filename);
  if ((REFUSED_EXTENSIONS as readonly string[]).includes(ext)) {
    return refusal(`this attachment is a .${ext} file, which runs code rather than being read`);
  }
  const declared = bareMime(mime);
  if ((REFUSED_MIMES as readonly string[]).includes(declared) || MACRO_MIME.test(declared)) {
    return refusal(`this attachment is declared as ${declared}, which runs code rather than being read`);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The bytes themselves
 * ------------------------------------------------------------------ */

function startsWith(bytes: Buffer, ...prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/** Mach-O, thin and fat, both endians. `CAFEBABE` is also a Java class file. */
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

/* ---- ZIP containers, which is where a macro or a jar actually hides ---- */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** The ZIP64 End Of Central Directory *Locator*, which sits just before the EOCD. */
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

/** EOCD is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_MIN = 22;
const EOCD_SEARCH = 0xffff + EOCD_MIN;

/**
 * What could be learned about a ZIP.
 *
 * Three answers rather than two, and the third is the point: "this is a ZIP
 * and I could not read its index" is not the same as "this is not a ZIP", and
 * treating it as the latter is how a ZIP64 archive or a deliberately truncated
 * one walks past a check that only ever looks at entry names.
 */
export type ZipInspection =
  | { kind: 'not-zip' }
  | { kind: 'entries'; names: string[] }
  | { kind: 'uninspectable'; why: string };

/** Is there an EOCD signature anywhere it could legally be? Cheap, no parsing. */
export function looksLikeZip(bytes: Buffer): boolean {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_SIG) return true;
  const from = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let i = bytes.length - EOCD_MIN; i >= from; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) return true;
  }
  return false;
}

/** Every EOCD *candidate*, newest first. A comment may contain the signature. */
function eocdCandidates(bytes: Buffer): number[] {
  const out: number[] = [];
  if (bytes.length < EOCD_MIN) return out;
  const from = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let i = bytes.length - EOCD_MIN; i >= from; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) out.push(i);
  }
  return out;
}

/**
 * Where this archive's central directory really starts, or -1.
 *
 * Two ways, because both are legal and the second is the one that matters
 * here. `cdOffset` is relative to the start of the *archive*, which is not the
 * start of the file when something is prepended — a self-extracting stub, or a
 * hundred bytes of padding put there precisely so a checker that reads byte 0
 * decides this is not a ZIP. The directory always ends immediately before the
 * EOCD, so `eocd - cdSize` finds it whatever the preamble; `cdOffset` is the
 * fallback. Whichever is used is only accepted when the central-directory
 * signature is actually there.
 */
function centralDirectoryStart(bytes: Buffer, eocd: number, cdSize: number, cdOffset: number): number {
  const candidates = [eocd - cdSize, cdOffset];
  for (const at of candidates) {
    if (at < 0 || at + 4 > bytes.length || at > eocd) continue;
    if (bytes.readUInt32LE(at) === CENTRAL_SIG) return at;
  }
  return -1;
}

/**
 * The names in a ZIP's central directory, read properly.
 *
 * Properly, and not by searching the whole buffer for `vbaProject.bin`,
 * because a perfectly ordinary `.docx` may *contain* that text inside a
 * compressed part and a substring search would refuse it.
 *
 * Every loop here is bounded by the buffer: a declared entry count is a number
 * an attacker writes, and a parser that trusts it is a parser that hangs.
 */
export function inspectZip(bytes: Buffer): ZipInspection {
  const candidates = eocdCandidates(bytes);
  if (candidates.length === 0) {
    // Local header but no end record: a ZIP whose index we cannot reach.
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_SIG) {
      return { kind: 'uninspectable', why: 'its index is missing or truncated' };
    }
    return { kind: 'not-zip' };
  }

  let truncated = false;
  for (const eocd of candidates) {
    const entries = bytes.readUInt16LE(eocd + 8);
    const total = bytes.readUInt16LE(eocd + 10);
    const cdSize = bytes.readUInt32LE(eocd + 12);
    const cdOffset = bytes.readUInt32LE(eocd + 16);

    /*
     * ZIP64. The 32-bit fields saturate, and the real ones live in a record
     * this parser does not read — so the honest answer is "I cannot inspect
     * this", not "there is nothing in it". A ZIP64 locator sitting just before
     * the EOCD says the same thing.
     */
    const zip64 =
      total === 0xffff ||
      entries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff ||
      (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) ||
      (eocd >= 56 && bytes.readUInt32LE(eocd - 56) === ZIP64_EOCD_SIG);
    if (zip64) {
      return { kind: 'uninspectable', why: 'it is a ZIP64 archive, whose index this build cannot read' };
    }

    const start = centralDirectoryStart(bytes, eocd, cdSize, cdOffset);
    if (start < 0) {
      // A fake signature inside a comment lands here and the *real* EOCD,
      // further back, is tried next.
      continue;
    }
    if (start + cdSize > bytes.length || eocd + EOCD_MIN > bytes.length) {
      truncated = true;
      continue;
    }

    const names: string[] = [];
    let at = start;
    // Bounded twice over: by the declared count *and* by the buffer.
    for (let i = 0; i < total && i < 0xffff; i += 1) {
      if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIG) {
        return { kind: 'uninspectable', why: 'its index is truncated or malformed' };
      }
      const nameLen = bytes.readUInt16LE(at + 28);
      const extraLen = bytes.readUInt16LE(at + 30);
      const commentLen = bytes.readUInt16LE(at + 32);
      const nameEnd = at + 46 + nameLen;
      if (nameEnd > bytes.length) {
        return { kind: 'uninspectable', why: 'its index is truncated or malformed' };
      }
      names.push(bytes.toString('utf8', at + 46, nameEnd));
      const next = nameEnd + extraLen + commentLen;
      // A zero-or-backwards step would be an infinite loop on hostile input.
      if (next <= at) {
        return { kind: 'uninspectable', why: 'its index is malformed' };
      }
      at = next;
    }
    return { kind: 'entries', names };
  }

  if (truncated) return { kind: 'uninspectable', why: 'its index is truncated' };
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_SIG) {
    return { kind: 'uninspectable', why: 'its index could not be read' };
  }
  return { kind: 'not-zip' };
}

/** Back-compatible view of `inspectZip`: the names, or none. */
export function zipEntryNames(bytes: Buffer): string[] {
  const found = inspectZip(bytes);
  return found.kind === 'entries' ? found.names : [];
}

/** What the first bytes say this is, when they say anything. */
export function sniffMime(bytes: Buffer): string | null {
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(bytes, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
  return null;
}

/** ZIP-based formats whose declared type is more precise than "a zip". */
const ZIP_FAMILIES = [
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
  'application/epub+zip',
];

/** Every type that says "there is a ZIP in here", precise or not. */
const ZIP_MIMES = [
  ...ZIP_FAMILIES,
  'application/zip',
  'application/x-zip-compressed',
  'application/java-archive',
  'application/vnd.android.package-archive',
];

/** Extensions that are ZIP containers, whatever the sender declared. */
const ZIP_EXTENSIONS = new Set([
  'zip', 'jar', 'apk', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'xlam', 'dotm',
  'odt', 'ods', 'odp', 'epub',
]);

function claimsZip(filename: string | null, mime: string): boolean {
  const bare = bareMime(mime);
  if (ZIP_MIMES.some((m) => bare === m || bare.startsWith(m))) return true;
  return ZIP_EXTENSIONS.has(extensionOf(filename));
}

/**
 * The mime to store: what the bytes say, unless the sender said something more
 * precise about the same thing.
 *
 * A `.docx` really is a ZIP, so sniffing it as `application/zip` and storing
 * that would be a downgrade — the declared type is kept when it is a member of
 * a ZIP-based family. Everything else prefers the bytes.
 */
export function mimeToStore(sniffed: string | null, declared: string): string {
  const bare = bareMime(declared) || 'application/octet-stream';
  if (!sniffed) return bare;
  if (sniffed === 'application/zip' && ZIP_FAMILIES.some((f) => bare.startsWith(f))) return bare;
  return sniffed;
}

/** What is inside a ZIP that this build will not keep, by entry name. */
function zipContentRefusal(names: readonly string[]): string | null {
  if (names.some((n) => n.toLowerCase().endsWith('vbaproject.bin'))) {
    return refusal('this attachment is an Office document carrying macros');
  }
  if (names.some((n) => n.toUpperCase() === 'META-INF/MANIFEST.MF')) {
    return refusal('this attachment is a Java archive, whatever it is called');
  }
  return null;
}

/**
 * Why these bytes are refused, or null.
 *
 * The last layer, and the only one that cannot be lied to by renaming a file.
 *
 * The name and the declared type are passed in — not to be *trusted*, but
 * because they are reasons to **look harder**. The ZIP inspection used to run
 * only when byte 0 was `PK`, so a hundred bytes of padding in front of an
 * archive skipped it entirely; now anything that calls itself a ZIP container,
 * or carries an end-of-directory record anywhere it could legally be, is
 * opened and read. And a ZIP that cannot be read — ZIP64, truncated, a
 * malformed index — is refused rather than waved through, because "I could not
 * see inside it" is not "there was nothing in it".
 */
export function bytesRefusal(
  bytes: Buffer,
  declared: { filename?: string | null; mime?: string } = {},
): string | null {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return refusal('the bytes of this attachment are a Windows program, whatever it is called');
  }
  if (startsWith(bytes, 0x7f, 0x45, 0x4c, 0x46)) {
    return refusal('the bytes of this attachment are a Linux program, whatever it is called');
  }
  if (bytes.length >= 4 && MACHO_MAGICS.has(bytes.readUInt32BE(0))) {
    return refusal('the bytes of this attachment are a macOS or Java program, whatever it is called');
  }
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) {
    return refusal('the bytes of this attachment are a script with a shebang line, whatever it is called');
  }
  /*
   * Look inside whenever there is a reason to: the sender called it a ZIP
   * container, it is named like one, or there is an end-of-directory record
   * where one would be. Each of those is cheap and none of them is trusted —
   * a file that turns out not to be a ZIP simply answers `not-zip`.
   */
  if (claimsZip(declared.filename ?? null, declared.mime ?? '') || looksLikeZip(bytes)) {
    const found = inspectZip(bytes);
    if (found.kind === 'uninspectable') {
      return refusal(
        `this attachment is an archive buddi cannot look inside — ${found.why} — and an archive nobody can read is not one to keep`,
      );
    }
    if (found.kind === 'entries') {
      const inside = zipContentRefusal(found.names);
      if (inside) return inside;
    }
  }
  return null;
}
