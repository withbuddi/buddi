/**
 * What these tests are really about is the promise made in `crypt.ts`: an
 * encrypted backup is a real age file, and a damaged one says so before
 * anybody types a passphrase. The last test in the file is the important one —
 * if the `age` CLI is installed, it must be able to open what we wrote.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENVELOPE_FORMAT,
  PassphraseError,
  decryptFile,
  encryptFile,
  envelopePath,
  envelopeProblems,
  readEnvelope,
  verifyEncryptedArchive,
  verifyEnvelope,
  writeEnvelope,
} from './crypt.js';
import { generatePassphrase } from './passphrase.js';

/** scrypt at the age default costs about a second each way. */
const SLOW = 60_000;

const PASSPHRASE = generatePassphrase();

let dir: string;

/** Big enough that it goes through the stream in more than one chunk. */
const PLAINTEXT = Buffer.concat([
  Buffer.from('buddi backup\n'),
  Buffer.alloc(200_000, 0x61),
  Buffer.from('\nend\n'),
]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-crypt-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freshArchive(name: string): Promise<{ plain: string; cipher: string }> {
  const plain = path.join(dir, `${name}.tar.gz`);
  const cipher = `${plain}.age`;
  await writeFile(plain, PLAINTEXT);
  await encryptFile(plain, cipher, PASSPHRASE);
  return { plain, cipher };
}

describe('encryptFile / decryptFile', () => {
  it(
    'round trips the bytes and writes an age file',
    async () => {
      const { cipher } = await freshArchive('round-trip');
      const header = (await readFile(cipher)).subarray(0, 40).toString('utf8');
      expect(header.startsWith('age-encryption.org/v1\n-> scrypt ')).toBe(true);

      const back = path.join(dir, 'round-trip.out');
      await decryptFile(cipher, back, PASSPHRASE);
      expect(await readFile(back)).toEqual(PLAINTEXT);
      expect((await stat(back)).mode & 0o777).toBe(0o600);
    },
    SLOW,
  );

  it(
    'opens with the same passphrase typed with sloppy spacing',
    async () => {
      const { cipher } = await freshArchive('spacing');
      const back = path.join(dir, 'spacing.out');
      await decryptFile(cipher, back, `  ${PASSPHRASE.replace(/ /g, '  ')} \n`);
      expect(await readFile(back)).toEqual(PLAINTEXT);
    },
    SLOW,
  );

  it(
    'says plainly that the passphrase is wrong',
    async () => {
      const { cipher } = await freshArchive('wrong');
      await expect(
        decryptFile(cipher, path.join(dir, 'wrong.out'), generatePassphrase()),
      ).rejects.toThrow(PassphraseError);
      await expect(
        decryptFile(cipher, path.join(dir, 'wrong.out'), generatePassphrase()),
      ).rejects.toThrow('That passphrase does not open this backup');
    },
    SLOW,
  );
});

describe('the envelope', () => {
  it(
    'is written beside the archive and matches it',
    async () => {
      const { cipher } = await freshArchive('envelope');
      const written = await writeEnvelope(cipher);

      expect(written.path).toBe(envelopePath(cipher));
      expect(written.path.endsWith('.tar.gz.json')).toBe(true);
      expect(written.envelope.format).toBe(ENVELOPE_FORMAT);
      expect(written.envelope.bytes).toBe((await stat(cipher)).size);
      expect(written.envelope.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Date.parse(written.envelope.createdAt)).not.toBeNaN();
      expect(written.envelope.buddiVersion).toMatch(/^\d+\.\d+\.\d+/);

      expect(await readEnvelope(cipher)).toEqual(written.envelope);
      expect(await verifyEnvelope(cipher)).toEqual({ ok: true, present: true });
    },
    SLOW,
  );

  it(
    'fails when the ciphertext was tampered with',
    async () => {
      const { cipher } = await freshArchive('tampered');
      await writeEnvelope(cipher);

      const bytes = await readFile(cipher);
      const last = bytes.length - 1;
      bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last);
      await writeFile(cipher, bytes);

      const check = await verifyEnvelope(cipher);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain('hash');
    },
    SLOW,
  );

  it(
    'fails when the ciphertext was truncated',
    async () => {
      const { cipher } = await freshArchive('truncated');
      await writeEnvelope(cipher);
      await writeFile(cipher, (await readFile(cipher)).subarray(0, 200));

      const check = await verifyEnvelope(cipher);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain('bytes');
    },
    SLOW,
  );

  it(
    'says the check could not run, rather than failing, when there is no envelope',
    async () => {
      // An uploaded `.age` arrives alone: the owner picked one file in a file
      // dialog and the `.json` stayed behind. Treating that as a failed backup
      // is what made every uploaded archive unrestorable.
      const { cipher } = await freshArchive('no-envelope');
      expect(await readEnvelope(cipher)).toBeNull();

      const check = await verifyEnvelope(cipher);
      expect(check.present).toBe(false);
      expect(check.ok).toBe(true);
      expect(check.reason).toContain('age authentication and the manifest');
    },
    SLOW,
  );
});

describe('the envelope against the manifest inside the archive', () => {
  const envelope = {
    format: ENVELOPE_FORMAT,
    createdAt: '2026-09-14T03:30:10.000Z',
    buddiVersion: '1.4.0',
    bytes: 4096,
    sha256: 'a'.repeat(64),
  };
  const manifest = { createdAt: '2026-09-14T03:30:00.000Z', buddiVersion: '1.4.0' };

  it('agrees when the envelope was written just after the archive', () => {
    expect(envelopeProblems(envelope, manifest, 4096)).toEqual([]);
  });

  it('catches a size the file does not have', () => {
    expect(envelopeProblems(envelope, manifest, 4097).join()).toContain('4096 bytes');
  });

  it('catches an envelope from another buddi', () => {
    expect(envelopeProblems({ ...envelope, buddiVersion: '1.3.0' }, manifest, 4096).join()).toContain(
      'the archive inside says 1.4.0',
    );
  });

  it('refuses an envelope written before the archive it describes', () => {
    const stale = { ...envelope, createdAt: '2026-09-01T00:00:00.000Z' };
    expect(envelopeProblems(stale, manifest, 4096).join()).toContain('before the archive');
  });

  it('refuses an envelope written a week after the archive', () => {
    const late = { ...envelope, createdAt: '2026-09-21T03:30:00.000Z' };
    expect(envelopeProblems(late, manifest, 4096).join()).toContain('after the archive');
  });
});

describe('verifyEncryptedArchive', () => {
  it(
    'decrypts into the temp directory and reports the envelope check',
    async () => {
      const { cipher } = await freshArchive('hook');
      await writeEnvelope(cipher);

      const out = await mkdtemp(path.join(dir, 'hook-tmp-'));
      const result = await verifyEncryptedArchive(cipher, PASSPHRASE, out);

      expect(result.envelope).toEqual({ ok: true, present: true });
      expect(result.record?.buddiVersion).toBeTypeOf('string');
      expect(path.dirname(result.plaintextPath)).toBe(out);
      expect(path.basename(result.plaintextPath)).toBe('hook.tar.gz');
      expect(await readFile(result.plaintextPath)).toEqual(PLAINTEXT);
      expect((await stat(result.plaintextPath)).mode & 0o777).toBe(0o600);
    },
    SLOW,
  );

  it(
    'still decrypts when the envelope is missing, and says the check did not run',
    async () => {
      const { cipher } = await freshArchive('hook-no-envelope');
      const out = await mkdtemp(path.join(dir, 'hook-tmp-'));
      const result = await verifyEncryptedArchive(cipher, PASSPHRASE, out);

      expect(result.envelope.present).toBe(false);
      expect(result.envelope.ok).toBe(true);
      expect(result.record).toBeNull();
      expect(await readFile(result.plaintextPath)).toEqual(PLAINTEXT);
    },
    SLOW,
  );

  it(
    'refuses the wrong passphrase',
    async () => {
      const { cipher } = await freshArchive('hook-wrong');
      const out = await mkdtemp(path.join(dir, 'hook-tmp-'));
      await expect(verifyEncryptedArchive(cipher, generatePassphrase(), out)).rejects.toThrow(
        PassphraseError,
      );
    },
    SLOW,
  );
});

/**
 * The point of choosing age: the reference tool opens what we wrote.
 *
 * `age` takes a passphrase only from a terminal, never from a pipe, so the run
 * goes through a pty. `python3` is the one pty allocator present on both macOS
 * and Linux without a native module; the test is skipped when it or `age` is
 * missing, which is the honest outcome rather than a silent pass.
 */
const has = (bin: string): boolean => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
const canRunAgeCli = has('age') && has('python3');

describe.skipIf(!canRunAgeCli)('the age CLI', () => {
  it(
    'decrypts our archive',
    async () => {
      const { cipher } = await freshArchive('age-cli');
      const out = path.join(dir, 'age-cli.out');
      const run = spawnSync(
        'python3',
        [
          '-c',
          'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]))',
          'age',
          '--decrypt',
          '-o',
          out,
          cipher,
        ],
        { input: `${PASSPHRASE}\n`, encoding: 'utf8', timeout: 60_000 },
      );
      expect(`${run.status} ${run.stdout ?? ''}${run.stderr ?? ''}`).toMatch(/^0 /);
      expect(await readFile(out)).toEqual(PLAINTEXT);
    },
    SLOW,
  );
});
