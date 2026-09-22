/**
 * What buddi will and will not put in the owner's library (docs/specs/email.md §10).
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

/** Where a ZIP's End Of Central Directory record starts, or -1. */
function eocdOffset(bytes: Buffer): number {
  // The EOCD is at the end, after a comment of at most 64 KiB.
  const from = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= from; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * The names in a ZIP's central directory.
 *
 * Read properly rather than by searching the whole buffer for a string,
 * because a `.docx` may perfectly well *contain* the text `vbaProject.bin`
 * inside a compressed part and a substring search would refuse it. Returns an
 * empty list when the directory cannot be read, which is a reason to fall back
 * to the declared type rather than to guess.
 */
export function zipEntryNames(bytes: Buffer): string[] {
  const eocd = eocdOffset(bytes);
  if (eocd < 0 || eocd + 22 > bytes.length) return [];
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count && at + 46 <= bytes.length; i += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) break;
    const nameLen = bytes.readUInt16LE(at + 28);
    const extraLen = bytes.readUInt16LE(at + 30);
    const commentLen = bytes.readUInt16LE(at + 32);
    if (at + 46 + nameLen > bytes.length) break;
    names.push(bytes.toString('utf8', at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
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

/**
 * Why these bytes are refused, or null.
 *
 * The last layer, and the only one that cannot be lied to by renaming a file.
 */
export function bytesRefusal(bytes: Buffer): string | null {
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
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    const names = zipEntryNames(bytes);
    if (names.some((n) => n.toLowerCase().endsWith('vbaproject.bin'))) {
      return refusal('this attachment is an Office document carrying macros');
    }
    if (names.some((n) => n.toUpperCase() === 'META-INF/MANIFEST.MF')) {
      return refusal('this attachment is a Java archive, whatever it is called');
    }
  }
  return null;
}
