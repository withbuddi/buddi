/**
 * Encryption for a backup archive, and the envelope that sits beside it.
 *
 * A backup holds the whole installation, so an archive that leaves the machine
 * leaves it encrypted. The format is age with a passphrase (scrypt) recipient,
 * produced by the `age-encryption` package, which is the reference
 * implementation's sibling: `age -d backup.tar.gz.age` opens what we write,
 * from any machine, years from now, with no buddi installed. That property is
 * the whole point of choosing age over something of our own, so nothing here
 * may wrap, frame or post-process the ciphertext.
 *
 * Everything streams. An archive is gigabytes on a real installation and must
 * never be held in memory, so the plaintext goes through a web stream into the
 * encrypter and out to disk a chunk at a time.
 *
 * Beside `<name>.tar.gz.age` we write `<name>.json`, the envelope: size, hash
 * and when it was made, in the clear. It is a convenience, not a proof — it is
 * unsigned and anyone who can edit the archive can edit it too. It catches the
 * truncated copy and the half-finished upload before a passphrase is typed;
 * after decryption the manifest inside the archive is what is authoritative.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Decrypter, Encrypter } from 'age-encryption';
import { sha256File } from './archive.js';
import { ENCRYPTED_SUFFIX } from './manifest.js';
import { normalizePassphrase } from './passphrase.js';
import { buddiVersion } from './version.js';

/** Bumped only when an older envelope would be read wrongly by this code. */
export const ENVELOPE_FORMAT = 2;

/** A backup is the whole installation: nothing it writes is world-readable. */
const FILE_MODE = 0o600;

/** What `age-encryption` says when no passphrase opened the header. */
const NO_MATCH = 'no identity matched';

/**
 * The passphrase did not open the archive.
 *
 * Its own class because the caller has to tell it apart from a corrupt file:
 * one means "try again", the other means "this copy is gone".
 */
export class PassphraseError extends Error {
  constructor(message = 'That passphrase does not open this backup') {
    super(message);
    this.name = 'PassphraseError';
  }
}

export interface BackupEnvelope {
  format: number;
  /** ISO 8601, when the ciphertext was written. */
  createdAt: string;
  buddiVersion: string;
  /** Size of the ciphertext in bytes. */
  bytes: number;
  /** sha256 of the ciphertext, hex. */
  sha256: string;
}

export interface EnvelopeCheck {
  ok: boolean;
  /**
   * False when there is no envelope beside the archive at all.
   *
   * That is the ordinary case for an uploaded backup: an owner picks one file
   * in a file dialog, and the `.json` stays on the machine it was written on.
   * An absent envelope is therefore not a failure — the archive's own age
   * authentication and its inner manifest are the real proof — it is a check
   * that could not be run, and the caller says so in those words.
   */
  present: boolean;
  /** Plain words for the owner: why it failed, or why it could not run. */
  reason?: string;
}

/** What the envelope claims, checked against the archive it came with. */
export const ENVELOPE_ABSENT_NOTE =
  'no envelope beside the archive; age authentication and the manifest were checked instead';

/** How far after the manifest an envelope may have been written. */
const ENVELOPE_SKEW_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Encrypt and decrypt
 * ------------------------------------------------------------------ */

/**
 * Encrypt `input` to `output`, streaming, with an age passphrase recipient.
 *
 * The scrypt work factor is the library default (2^18), which is what the age
 * CLI writes and takes about a second here: slow enough to matter to someone
 * guessing, fast enough that verifying a backup is not a coffee break.
 */
export async function encryptFile(
  input: string,
  output: string,
  passphrase: string,
): Promise<void> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(normalizePassphrase(passphrase));

  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const plaintext = Readable.toWeb(
    createReadStream(input),
  ) as unknown as ReadableStream<Uint8Array>;
  const ciphertext = await encrypter.encrypt(plaintext);

  await pipeline(
    Readable.fromWeb(ciphertext as never),
    createWriteStream(output, { mode: FILE_MODE }),
  );
  await chmod(output, FILE_MODE);
}

/**
 * Decrypt `input` to `output`, streaming.
 *
 * The header is read before the body flows, so a wrong passphrase is known
 * before a byte is written and is reported as a `PassphraseError`. Anything
 * that goes wrong after that is damage to the file and is reported as itself.
 */
export async function decryptFile(
  input: string,
  output: string,
  passphrase: string,
): Promise<void> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(normalizePassphrase(passphrase));

  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const ciphertext = Readable.toWeb(
    createReadStream(input),
  ) as unknown as ReadableStream<Uint8Array>;

  let plaintext: ReadableStream<Uint8Array>;
  try {
    plaintext = (await decrypter.decrypt(ciphertext)) as unknown as ReadableStream<Uint8Array>;
  } catch (err) {
    throw asPassphraseError(err);
  }

  try {
    await pipeline(
      Readable.fromWeb(plaintext as never),
      createWriteStream(output, { mode: FILE_MODE }),
    );
  } catch (err) {
    // The body's authentication tag fails here, not in the header, when a file
    // was truncated or edited after it was written.
    throw asPassphraseError(err);
  }
  await chmod(output, FILE_MODE);
}

function asPassphraseError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(NO_MATCH)) return new PassphraseError();
  return err instanceof Error ? err : new Error(message);
}

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

/** `<name>.tar.gz.age` -> `<name>.tar.gz.json`; a path without `.age` keeps its stem. */
export function envelopePath(ciphertextPath: string): string {
  const abs = path.resolve(ciphertextPath);
  const stem = abs.endsWith(ENCRYPTED_SUFFIX) ? abs.slice(0, -ENCRYPTED_SUFFIX.length) : abs;
  return `${stem}.json`;
}

/** Measure the ciphertext and write the envelope beside it. */
export async function writeEnvelope(
  ciphertextPath: string,
): Promise<{ path: string; envelope: BackupEnvelope }> {
  const abs = path.resolve(ciphertextPath);
  const envelope: BackupEnvelope = {
    format: ENVELOPE_FORMAT,
    createdAt: new Date().toISOString(),
    buddiVersion: buddiVersion(),
    bytes: (await stat(abs)).size,
    sha256: await sha256File(abs),
  };
  const target = envelopePath(abs);
  await writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, { mode: FILE_MODE });
  return { path: target, envelope };
}

/** The envelope beside `ciphertextPath`, or null when there is none. */
export async function readEnvelope(ciphertextPath: string): Promise<BackupEnvelope | null> {
  try {
    const raw = await readFile(envelopePath(ciphertextPath), 'utf8');
    const parsed = JSON.parse(raw) as BackupEnvelope;
    if (typeof parsed?.sha256 !== 'string' || typeof parsed?.bytes !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Does the ciphertext still match the envelope written beside it?
 *
 * Size first, because it is free and catches the interrupted copy, then the
 * hash. A missing envelope is not a pass: the owner asked for a check and
 * there is nothing to check against.
 */
export async function verifyEnvelope(ciphertextPath: string): Promise<EnvelopeCheck> {
  const abs = path.resolve(ciphertextPath);
  const envelope = await readEnvelope(abs);
  if (!envelope) {
    return { ok: true, present: false, reason: ENVELOPE_ABSENT_NOTE };
  }

  let bytes: number;
  try {
    bytes = (await stat(abs)).size;
  } catch {
    return { ok: false, present: true, reason: `${path.basename(abs)} is not there` };
  }
  if (bytes !== envelope.bytes) {
    return {
      ok: false,
      present: true,
      reason: `the archive is ${bytes} bytes, the envelope says ${envelope.bytes}`,
    };
  }

  const digest = await sha256File(abs);
  if (digest !== envelope.sha256) {
    return { ok: false, present: true, reason: 'the archive does not hash to what the envelope says' };
  }
  return { ok: true, present: true };
}

/**
 * Does the envelope describe the archive that came out of it?
 *
 * The envelope is written outside the ciphertext by whoever wrote the file; the
 * manifest is inside it, under age's authentication tag, and cannot be edited
 * without the passphrase. So once the archive is open, the manifest is the
 * witness and the envelope is the claim, and a claim that disagrees with the
 * witness means the two files are not a pair — the usual cause being an
 * envelope left behind from an earlier backup with the same name.
 *
 * Pure, so the awkward cases are testable: an envelope cannot have been written
 * before the archive it describes, and a day is more than enough slack for the
 * minute or two an encryption of a large archive takes.
 */
export function envelopeProblems(
  envelope: BackupEnvelope,
  manifest: { createdAt: string; buddiVersion: string },
  ciphertextBytes: number,
): string[] {
  const problems: string[] = [];
  if (envelope.bytes !== ciphertextBytes) {
    problems.push(`the envelope says ${envelope.bytes} bytes, the file is ${ciphertextBytes}`);
  }
  if (envelope.buddiVersion !== manifest.buddiVersion) {
    problems.push(
      `the envelope says buddi ${envelope.buddiVersion}, the archive inside says ${manifest.buddiVersion}`,
    );
  }
  const outer = Date.parse(envelope.createdAt);
  const inner = Date.parse(manifest.createdAt);
  if (Number.isNaN(outer) || Number.isNaN(inner)) {
    problems.push('the envelope or the manifest has no readable createdAt');
  } else if (outer < inner) {
    problems.push(`the envelope was written before the archive it describes (${envelope.createdAt})`);
  } else if (outer - inner > ENVELOPE_SKEW_MS) {
    problems.push(
      `the envelope was written ${Math.round((outer - inner) / 3_600_000)}h after the archive inside it`,
    );
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * The hook `verifyBackup` calls
 * ------------------------------------------------------------------ */

export interface EncryptedArchiveCheck {
  /** The decrypted archive, mode 0600, inside `tmpDir`. The caller deletes it. */
  plaintextPath: string;
  envelope: EnvelopeCheck;
  /** The envelope as it was read, for the check against the inner manifest. */
  record: BackupEnvelope | null;
  /** The ciphertext's size on disk, so the caller need not stat it again. */
  bytes: number;
}

/**
 * Check the envelope and decrypt, so the rest of `verifyBackup` can work on a
 * plain `.tar.gz` and know nothing about encryption.
 *
 * A bad envelope does not stop the decryption: the envelope is unsigned, so
 * the archive itself is the better witness, and the caller is told both. A
 * wrong passphrase does stop it, as a `PassphraseError`.
 */
export async function verifyEncryptedArchive(
  ciphertextPath: string,
  passphrase: string,
  tmpDir: string,
): Promise<EncryptedArchiveCheck> {
  const abs = path.resolve(ciphertextPath);
  const envelope = await verifyEnvelope(abs);
  const record = await readEnvelope(abs);
  const bytes = await stat(abs)
    .then((s) => s.size)
    .catch(() => 0);

  const base = path.basename(abs).endsWith(ENCRYPTED_SUFFIX)
    ? path.basename(abs).slice(0, -ENCRYPTED_SUFFIX.length)
    : `${path.basename(abs)}.plain`;
  const plaintextPath = path.join(path.resolve(tmpDir), base);

  await decryptFile(abs, plaintextPath, passphrase);
  return { plaintextPath, envelope, record, bytes };
}
