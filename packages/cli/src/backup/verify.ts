/**
 * `buddi backup verify` — prove an archive is good without a database.
 *
 * This is the command that makes a backup worth having. It needs no Postgres,
 * no Docker and no network: it unpacks the archive to a temp directory, hashes
 * every member, compares each against the manifest, reads the manifest's shape,
 * and checks that the dump is really a `pg_dump` custom-format archive rather
 * than a zero-byte file or an error message that got redirected into one.
 *
 * What it deliberately does NOT do is restore. An owner must be able to check a
 * backup on a Tuesday afternoon without risking anything.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAll, listMembers, readMember, sha256File, walkFiles } from './archive.js';
import {
  DUMP_NAME,
  MANIFEST_NAME,
  formatBytes,
  isCustomFormatDump,
  manifestProblems,
  type BackupManifest,
} from './manifest.js';

export interface VerifyResult {
  archive: string;
  bytes: number;
  ok: boolean;
  manifest: BackupManifest | null;
  /** One line per check, in the order they ran. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  problems: string[];
}

/** The manifest, read straight out of the archive without unpacking it. */
export async function readManifest(archive: string): Promise<BackupManifest> {
  const raw = await readMember(archive, MANIFEST_NAME);
  return JSON.parse(raw.toString('utf8')) as BackupManifest;
}

export async function verifyArchive(archive: string): Promise<VerifyResult> {
  const abs = path.resolve(archive);
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

  /* 1. is it a tar we can read at all? ------------------------------- */
  let members: string[];
  try {
    members = await listMembers(abs);
    pass('archive', `${members.length} member(s), ${formatBytes(bytes)}`);
  } catch (err) {
    fail('archive', err instanceof Error ? err.message : String(err));
    return { archive: abs, bytes, ok: false, manifest: null, checks, problems };
  }

  /* 2. the manifest -------------------------------------------------- */
  try {
    const raw = JSON.parse((await readMember(abs, MANIFEST_NAME)).toString('utf8'));
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

  /* 3. every member, hashed ------------------------------------------ */
  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-verify-'));
  try {
    await extractAll(abs, stage);
    const onDisk = new Map((await walkFiles(stage)).map((f) => [f.rel, f]));

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
          problems.push(`corrupt: ${member.path} hashes ${sha.slice(0, 12)}…, manifest says ${member.sha256.slice(0, 12)}…`);
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
        problems.push(`unlisted: ${extra.length} file(s) in the archive are not in the manifest (${extra.slice(0, 3).join(', ')})`);
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

    /* 4. the dump's own header --------------------------------------- */
    const dump = onDisk.get(DUMP_NAME);
    if (!dump) {
      fail('pg_dump', `${DUMP_NAME} is not in the archive`);
    } else if (dump.bytes === 0) {
      fail('pg_dump', `${DUMP_NAME} is empty`);
    } else {
      const handle = await open(dump.abs, 'r');
      try {
        const head = Buffer.alloc(8);
        await handle.read(head, 0, 8, 0);
        if (isCustomFormatDump(head)) {
          pass('pg_dump', `custom-format archive, ${formatBytes(dump.bytes)}`);
        } else {
          fail(
            'pg_dump',
            `${DUMP_NAME} does not start with PGDMP — this is not a pg_dump custom-format archive`,
          );
        }
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    fail('extract', err instanceof Error ? err.message : String(err));
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }

  return {
    archive: abs,
    bytes,
    ok: problems.length === 0,
    manifest,
    checks,
    problems,
  };
}
