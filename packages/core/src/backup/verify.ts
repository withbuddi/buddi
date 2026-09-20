/**
 * `verifyBackup` — prove an archive is good without a database.
 *
 * This is the function that makes a backup worth having. It needs no Postgres
 * and no network: it unpacks the archive to a temp directory, hashes every
 * member, compares each against the manifest, reads the manifest's shape, and
 * checks that every table the manifest claims has a COPY file whose lines match
 * the column count and row count recorded for it — the check that catches an
 * error message or a truncated transfer sitting where table data should be.
 *
 * What it deliberately does NOT do is restore. An owner must be able to check a
 * backup on a Tuesday afternoon without risking anything.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAll, listMembers, readMember, sha256File, walkFiles } from './archive.js';
import { verifyEncryptedArchive } from './crypt.js';
import {
  DB_MIGRATIONS_NAME,
  ENCRYPTED_SUFFIX,
  MANIFEST_NAME,
  SEQUENCES_NAME,
  TABLES_NAME,
  copyFileName,
  copyFileProblem,
  formatBytes,
  manifestProblems,
  type BackupManifest,
  type DumpedTable,
} from './manifest.js';
import { PHASE } from './phases.js';
import type { OnProgress } from './create.js';

export interface VerifyOptions {
  archive: string;
  /** Required for a `.age` archive; ignored for a plain one. */
  passphrase?: string | undefined;
  onProgress?: OnProgress | undefined;
}

export interface VerifyResult {
  archive: string;
  bytes: number;
  ok: boolean;
  manifest: BackupManifest | null;
  /** One line per check, in the order they ran. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  problems: string[];
}

/** The manifest, read straight out of a plain archive without unpacking it. */
export async function readManifest(archive: string): Promise<BackupManifest> {
  const raw = await readMember(archive, MANIFEST_NAME);
  return JSON.parse(raw.toString('utf8')) as BackupManifest;
}

/**
 * Decrypt first when the archive is an encrypted one, so everything below this
 * line works on a plain `.tar.gz` and knows nothing about encryption.
 */
export async function openArchive(
  archive: string,
  passphrase: string | undefined,
  tmpDir: string,
): Promise<{ path: string; envelope?: { ok: boolean; reason?: string }; problem?: string }> {
  if (!archive.endsWith(ENCRYPTED_SUFFIX)) return { path: archive };
  if (passphrase === undefined || passphrase === '') {
    return { path: archive, problem: `${path.basename(archive)} is encrypted and no passphrase was given` };
  }
  const opened = await verifyEncryptedArchive(archive, passphrase, tmpDir);
  return { path: opened.plaintextPath, envelope: opened.envelope };
}

export async function verifyBackup(opts: VerifyOptions): Promise<VerifyResult> {
  const abs = path.resolve(opts.archive);
  const progress = opts.onProgress ?? ((): void => {});
  const checks: VerifyResult['checks'] = [];
  const problems: string[] = [];
  const bytes = (await stat(abs)).size;
  let manifest: BackupManifest | null = null;

  const fail = (name: string, detail: string): void => {
    checks.push({ name, ok: false, detail });
    problems.push(`${name}: ${detail}`);
  };
  const pass = (name: string, detail: string): void => {
    checks.push({ name, ok: true, detail });
  };

  progress({ phase: PHASE.verify, detail: path.basename(abs) });
  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-verify-'));
  try {
    /* 0. decryption, when the archive is an encrypted one ------------- */
    const opened = await openArchive(abs, opts.passphrase, stage);
    if (opened.problem !== undefined) {
      fail('encryption', opened.problem);
      return { archive: abs, bytes, ok: false, manifest: null, checks, problems };
    }
    if (opened.envelope) {
      if (opened.envelope.ok) pass('envelope', 'the outer envelope matches the ciphertext');
      else fail('envelope', opened.envelope.reason ?? 'the outer envelope does not match the ciphertext');
    }
    const tarball = opened.path;

    /* 1. is it a tar we can read at all? ----------------------------- */
    let members: string[];
    try {
      members = await listMembers(tarball);
      pass('archive', `${members.length} member(s), ${formatBytes(bytes)}`);
    } catch (err) {
      fail('archive', err instanceof Error ? err.message : String(err));
      return { archive: abs, bytes, ok: false, manifest: null, checks, problems };
    }

    /* 2. the manifest ------------------------------------------------ */
    try {
      const raw = JSON.parse((await readMember(tarball, MANIFEST_NAME)).toString('utf8'));
      const shape = manifestProblems(raw);
      if (shape.length > 0) {
        fail('manifest', shape.join('; '));
      } else {
        manifest = raw as BackupManifest;
        pass(
          'manifest',
          `format ${manifest.format}, buddi ${manifest.buddiVersion}, created ${manifest.createdAt}`,
        );
      }
    } catch (err) {
      fail('manifest', err instanceof Error ? err.message : String(err));
    }

    /* 3. every member, hashed ---------------------------------------- */
    await extractAll(tarball, path.join(stage, 'x'));
    const onDisk = new Map((await walkFiles(path.join(stage, 'x'))).map((f) => [f.rel, f]));

    if (manifest) {
      let matched = 0;
      for (const member of manifest.members) {
        const found = onDisk.get(member.path);
        if (!found) {
          problems.push(`missing: ${member.path} is in the manifest but not in the archive`);
          continue;
        }
        const sha = await sha256File(found.abs);
        if (sha !== member.sha256) {
          problems.push(
            `corrupt: ${member.path} hashes ${sha.slice(0, 12)}…, manifest says ${member.sha256.slice(0, 12)}…`,
          );
          continue;
        }
        if (found.bytes !== member.bytes) {
          problems.push(`size: ${member.path} is ${found.bytes} bytes, manifest says ${member.bytes}`);
          continue;
        }
        matched += 1;
      }
      const extra = [...onDisk.keys()].filter(
        (rel) => rel !== MANIFEST_NAME && !manifest?.members.some((m) => m.path === rel),
      );
      if (extra.length > 0) {
        problems.push(
          `unlisted: ${extra.length} file(s) in the archive are not in the manifest (${extra.slice(0, 3).join(', ')})`,
        );
      }
      if (matched === manifest.members.length && extra.length === 0) {
        pass('checksums', `${matched} member(s) match their sha256`);
      } else {
        checks.push({
          name: 'checksums',
          ok: false,
          detail: `${matched}/${manifest.members.length} matched`,
        });
      }
    }

    /* 4. the database files, read as what they claim to be ----------- */
    const tablesFile = onDisk.get(TABLES_NAME);
    if (!tablesFile) {
      fail('database', `${TABLES_NAME} is not in the archive`);
    } else {
      try {
        const tables = JSON.parse(await readFile(tablesFile.abs, 'utf8')) as DumpedTable[];
        const found: string[] = [];
        for (const table of tables) {
          const copy = onDisk.get(copyFileName(table.schema, table.table));
          if (!copy) {
            found.push(`${table.schema}.${table.table}: its COPY file is not in the archive`);
            continue;
          }
          const problem = copyFileProblem(await readFile(copy.abs, 'utf8'), table);
          if (problem !== null) found.push(problem);
        }
        for (const name of [SEQUENCES_NAME, DB_MIGRATIONS_NAME]) {
          const file = onDisk.get(name);
          if (!file) found.push(`${name} is not in the archive`);
          else JSON.parse(await readFile(file.abs, 'utf8'));
        }
        if (found.length > 0) {
          fail('database', found.slice(0, 3).join('; '));
        } else {
          const rows = tables.reduce((sum, t) => sum + t.rows, 0);
          pass('database', `${tables.length} table(s), ${rows} row(s), every COPY file readable`);
        }
      } catch (err) {
        fail('database', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    fail('extract', err instanceof Error ? err.message : String(err));
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }

  return { archive: abs, bytes, ok: problems.length === 0, manifest, checks, problems };
}
