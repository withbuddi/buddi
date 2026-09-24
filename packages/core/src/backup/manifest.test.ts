/**
 * The pure half of `buddi backup`, tested where it is worth testing: the rule
 * that keeps secrets out of an archive, the checks that make "verify" mean
 * something, the guard that stops a restore over a live database, and prune.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP,
  MANIFEST_FORMAT,
  archiveName,
  archiveTime,
  assertNoSecretValues,
  checkRestoreGuard,
  formatBytes,
  isArchiveName,
  isEncryptedArchiveName,
  copyFileProblem,
  memberPathProblem,
  isSecretName,
  manifestProblems,
  restoreCommandsFor,
  scrubEnv,
  secretValuesIn,
  selectForPrune,
  type BackupManifest,
} from './manifest.js';

const KNOWN = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'GMAIL_APP_PASSWORD',
];

describe('archive names', () => {
  it('stamps the local date and time', () => {
    expect(archiveName(new Date(2026, 8, 14, 3, 30, 5))).toBe('buddi-backup-20260914-033005.tar.gz');
  });

  it('round-trips through archiveTime', () => {
    const at = new Date(2026, 0, 2, 23, 59, 59);
    const parsed = archiveTime(archiveName(at));
    expect(parsed?.getTime()).toBe(new Date(2026, 0, 2, 23, 59, 59).getTime());
  });

  it('refuses a name that is not one of ours', () => {
    expect(isArchiveName('backup.tar.gz')).toBe(false);
    expect(isArchiveName('buddi-backup-nope.tar.gz')).toBe(false);
    expect(archiveTime('buddi-backup-nope.tar.gz')).toBeNull();
  });

  it('counts the encrypted form as an archive, stamp and all', () => {
    const name = `${archiveName(new Date(2026, 8, 14, 3, 30, 5))}.age`;
    expect(isArchiveName(name)).toBe(true);
    expect(isEncryptedArchiveName(name)).toBe(true);
    expect(archiveTime(name)?.getTime()).toBe(new Date(2026, 8, 14, 3, 30, 5).getTime());
    expect(isEncryptedArchiveName(archiveName(new Date()))).toBe(false);
  });
});

describe('paths inside an archive', () => {
  it('accepts the paths a buddi archive actually holds', () => {
    for (const ok of ['manifest.json', 'db/core.events.copy', 'private/agents/a.md', 'artifacts/2026/09/x']) {
      expect(memberPathProblem(ok)).toBeNull();
    }
  });

  it('refuses anything that could land outside the extraction directory', () => {
    expect(memberPathProblem('../evil')).toContain('climbs out');
    expect(memberPathProblem('private/../../evil')).toContain('climbs out');
    expect(memberPathProblem('/etc/passwd')).toContain('absolute');
    expect(memberPathProblem('C:\\Windows\\evil')).toContain('absolute');
    expect(memberPathProblem('private\\agents')).toContain('backslash');
    expect(memberPathProblem('~/.ssh/id_rsa')).toContain('home directory');
    expect(memberPathProblem('  ')).toContain('empty');
  });
});

describe('scrubbing .env', () => {
  it('replaces every known secret with the vault marker and names it', () => {
    const raw = [
      'DATABASE_URL=postgres://buddi:buddi@localhost:55433/buddi',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-REALSECRETVALUE',
      'TELEGRAM_BOT_TOKEN=123456:AAH-REALBOTTOKEN',
      'BUDDI_TZ=America/New_York',
    ].join('\n');

    const result = scrubEnv(raw, { known: KNOWN });

    expect(result.text).toContain('CLAUDE_CODE_OAUTH_TOKEN="<vault>"');
    expect(result.text).toContain('TELEGRAM_BOT_TOKEN="<vault>"');
    expect(result.text).toContain('BUDDI_TZ=America/New_York');
    expect(result.names).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'TELEGRAM_BOT_TOKEN']);
    expect(result.text).not.toContain('REALSECRETVALUE');
    expect(result.text).not.toContain('REALBOTTOKEN');
  });

  it('scrubs a quoted value that runs over several lines, whole', () => {
    const raw = [
      'BUDDI_TZ=America/New_York',
      'SERVICE_ACCOUNT_KEY="-----BEGIN PRIVATE KEY-----',
      'LINEONEOFTHEKEY',
      'LINETWOOFTHEKEY',
      '-----END PRIVATE KEY-----"',
      'AFTER=still here',
    ].join('\n');

    const result = scrubEnv(raw);

    expect(result.text).toContain('SERVICE_ACCOUNT_KEY="<vault>"');
    expect(result.text).toContain('BUDDI_TZ=America/New_York');
    expect(result.text).toContain('AFTER=still here');
    expect(result.text).not.toContain('LINEONEOFTHEKEY');
    expect(result.text).not.toContain('LINETWOOFTHEKEY');
    expect(result.names).toEqual(['SERVICE_ACCOUNT_KEY']);
    // And the proof stays a mechanism: the assertion sees the whole value and
    // every line of it, so a scrub that missed one would stop the backup.
    expect(secretValuesIn(raw)).toContain('LINETWOOFTHEKEY');
    assertNoSecretValues(result.text, secretValuesIn(raw));
  });

  it('does not swallow the rest of the file when a quote is never closed', () => {
    const raw = ['API_KEY="unterminated', 'BUDDI_TZ=America/New_York'].join('\n');
    const result = scrubEnv(raw);
    expect(result.text).toContain('API_KEY="<vault>"');
    expect(result.text).toContain('BUDDI_TZ=America/New_York');
  });

  it('scrubs a secret however oddly the line is written', () => {
    const raw = [
      `ANTHROPIC_API_KEY='single-quoted-SECRET-1'`,
      `  OPENAI_API_KEY = "spaced and quoted SECRET-2"  `,
      'export GMAIL_APP_PASSWORD=exported-SECRET-3',
      '# TELEGRAM_BOT_TOKEN=commented-out-SECRET-4',
      'BUDDI_VAULT_KEY=file-vault-SECRET-5',
    ].join('\n');

    const result = scrubEnv(raw, { known: KNOWN });

    for (const n of [1, 2, 3, 4, 5]) {
      expect(result.text).not.toContain(`SECRET-${n}`);
    }
    // The file-vault key is a secret by *shape*, not by name — and it is the
    // one that would unlock every other secret if it travelled in a backup.
    expect(result.names).toContain('BUDDI_VAULT_KEY');
    expect(() => assertNoSecretValues(result.text, secretValuesIn(raw, KNOWN))).not.toThrow();
  });

  it('a spaced-and-quoted value is still a value the scrub must claim', () => {
    const raw = `  OPENAI_API_KEY = "spaced SECRET"  `;
    expect(secretValuesIn(raw, KNOWN)).toEqual(['spaced SECRET']);
    expect(scrubEnv(raw, { known: KNOWN }).names).toEqual(['OPENAI_API_KEY']);
  });

  it('redacts a password embedded in a non-secret URL', () => {
    const result = scrubEnv('DATABASE_URL=postgres://buddi:hunter2@localhost:5432/buddi', {
      known: KNOWN,
    });
    expect(result.text).not.toContain('hunter2');
    expect(result.text).toContain('***');
    expect(result.redacted).toEqual(['DATABASE_URL']);
  });

  it('does not claim a name that had no value at all', () => {
    const result = scrubEnv('ANTHROPIC_API_KEY=\n', { known: KNOWN });
    expect(result.names).toEqual([]);
  });

  it('still claims a name that already moved to the vault', () => {
    // The normal installation: `buddi vault import-env` has run, so `.env`
    // holds markers. The secret exists — a manifest saying "none" would be
    // lying about the one thing it is for.
    const result = scrubEnv('OPENAI_API_KEY="<vault>"\nTELEGRAM_BOT_TOKEN=<vault>', {
      known: KNOWN,
    });
    expect(result.names).toEqual(['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(result.inVault).toEqual(['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(restoreCommandsFor(result.names)).toEqual([
      'buddi vault set OPENAI_API_KEY',
      'buddi vault set TELEGRAM_BOT_TOKEN',
    ]);
  });

  it('leaves comments and blank lines alone', () => {
    const raw = '# a comment\n\nBUDDI_OWNER_NAME=Amen\n';
    expect(scrubEnv(raw, { known: KNOWN }).text).toBe(raw);
  });

  it('assertNoSecretValues is the mechanism, not the promise', () => {
    expect(() => assertNoSecretValues('leftover SECRET-1 here', ['SECRET-1'])).toThrow(
      /survived scrubbing/,
    );
  });

  it('knows a secret by shape as well as by name', () => {
    expect(isSecretName('SOME_SERVICE_TOKEN')).toBe(true);
    expect(isSecretName('BUDDI_VAULT_KEY')).toBe(true);
    expect(isSecretName('STRIPE_SECRET')).toBe(true);
    expect(isSecretName('GMAIL_USER')).toBe(false);
    expect(isSecretName('BUDDI_TZ')).toBe(false);
    expect(isSecretName('ANTHROPIC_API_KEY', KNOWN)).toBe(true);
  });
});

describe('the manifest', () => {
  const good: BackupManifest = {
    format: MANIFEST_FORMAT,
    createdAt: '2026-09-14T07:30:00.000Z',
    timezone: 'America/New_York',
    buddiVersion: '0.1.0',
    postgresMajor: 16,
    host: 'laptop',
    database: { name: 'buddi', host: 'localhost', port: '55433', user: 'buddi' },
    migrations: [{ schema: 'core', filename: '001_init.sql', appliedAt: null, sha256: 'a'.repeat(64) }],
    tables: [{ table: 'core.events', rows: 12 }],
    plugins: [],
    artifacts: { included: true, count: 2, bytes: 100 },
    private: { agents: null, skills: null },
    secrets: {
      names: ['ANTHROPIC_API_KEY'],
      fromVault: ['ANTHROPIC_API_KEY'],
      redacted: [],
      note: 'n',
      restoreWith: ['buddi vault set ANTHROPIC_API_KEY'],
      ownerSecrets: [],
    },
    members: [{ path: 'db/core.events.copy', bytes: 10, sha256: 'b'.repeat(64) }],
  };

  it('accepts a manifest this build wrote', () => {
    expect(manifestProblems(good)).toEqual([]);
  });

  it('rejects a manifest from a newer format', () => {
    expect(manifestProblems({ ...good, format: MANIFEST_FORMAT + 1 })).toEqual([
      `format ${MANIFEST_FORMAT + 1} is newer than this build understands (${MANIFEST_FORMAT})`,
    ]);
  });

  it('rejects a manifest from an older format in plain words', () => {
    const problems = manifestProblems({ ...good, format: 1 });
    expect(problems.join()).toContain('older backup than this build can read');
  });

  it('rejects a member whose checksum is not a sha256', () => {
    const bad = { ...good, members: [{ path: 'x', bytes: 1, sha256: 'nope' }] };
    expect(manifestProblems(bad)).toContain('a member entry is malformed ("x")');
  });

  it('rejects anything that is not a manifest at all', () => {
    expect(manifestProblems(null)).toEqual(['manifest.json is not an object']);
    expect(manifestProblems({})).toContain('format is missing');
  });

  it('names the exact commands that put the secrets back', () => {
    expect(restoreCommandsFor(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'])).toEqual([
      'buddi vault set ANTHROPIC_API_KEY',
      'buddi vault set TELEGRAM_BOT_TOKEN',
    ]);
  });
});

describe('COPY file sanity', () => {
  const table = { schema: 'drill', table: 'accounts', columns: ['id', 'name'], rows: 2 };

  it('accepts a file whose lines match the columns and the row count', () => {
    expect(copyFileProblem('1\tchecking\n2\tsavings\n', table)).toBeNull();
  });

  it('accepts an empty file for an empty table, and refuses one for a full table', () => {
    expect(copyFileProblem('', { ...table, rows: 0 })).toBeNull();
    expect(copyFileProblem('', table)).toMatch(/the COPY file is empty/);
  });

  it('catches a truncated transfer and an error message in place of data', () => {
    expect(copyFileProblem('1\tchecking\n', table)).toMatch(/1 line\(s\), manifest says 2/);
    expect(copyFileProblem('Error: no such container\n', { ...table, rows: 1 })).toMatch(
      /has 1 field\(s\), not 2/,
    );
  });
});

describe('prune', () => {
  const entry = (name: string, at: number, bytes = 10): { name: string; at: number; bytes: number } => ({
    name,
    at,
    bytes,
  });

  it('keeps the newest n and removes the rest', () => {
    const entries = [entry('a', 1), entry('b', 5), entry('c', 3), entry('d', 4)];
    const { keep, remove } = selectForPrune(entries, 2);
    expect(keep.map((e) => e.name)).toEqual(['b', 'd']);
    expect(remove.map((e) => e.name)).toEqual(['c', 'a']);
  });

  it('removes nothing when there are fewer than n', () => {
    expect(selectForPrune([entry('a', 1)], DEFAULT_KEEP).remove).toEqual([]);
  });

  it('breaks ties on the name, so the result never depends on directory order', () => {
    const { keep } = selectForPrune([entry('a', 1), entry('b', 1)], 1);
    expect(keep[0]?.name).toBe('b');
  });

  it('refuses to keep zero — that is "delete every backup I have"', () => {
    expect(() => selectForPrune([entry('a', 1)], 0)).toThrow(/at least 1/);
    expect(() => selectForPrune([entry('a', 1)], -3)).toThrow(/at least 1/);
    expect(() => selectForPrune([entry('a', 1)], 1.5)).toThrow(/at least 1/);
  });
});

describe('the non-empty-database guard', () => {
  const base = { database: 'buddi', yes: false, existingTables: 0, existingRows: 0 };

  it('lets an empty database through with no ceremony', () => {
    expect(checkRestoreGuard(base)).toEqual({ ok: true, note: 'buddi is empty — restoring into it' });
  });

  it('lets a migrated-but-empty database through', () => {
    const guard = checkRestoreGuard({ ...base, existingTables: 20 });
    expect(guard.ok).toBe(true);
  });

  it('refuses a database with rows when --yes was not given', () => {
    const guard = checkRestoreGuard({ ...base, existingTables: 20, existingRows: 4_000 });
    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.message).toMatch(/Refusing to restore over it/);
  });

  it('refuses when --yes was given but nothing was typed', () => {
    const guard = checkRestoreGuard({ ...base, existingTables: 20, existingRows: 4_000, yes: true });
    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.message).toMatch(/never confirmed/);
  });

  it('refuses when the wrong name is typed, and says nothing changed', () => {
    const guard = checkRestoreGuard({
      ...base,
      existingTables: 20,
      existingRows: 4_000,
      yes: true,
      typed: 'yes',
    });
    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.message).toMatch(/Nothing was changed/);
  });

  it('proceeds only with --yes AND the database name typed back', () => {
    const guard = checkRestoreGuard({
      ...base,
      existingTables: 20,
      existingRows: 4_000,
      yes: true,
      typed: ' buddi ',
    });
    expect(guard.ok).toBe(true);
    expect(guard.ok === true && guard.note).toMatch(/4000 row\(s\) will be replaced/);
  });
});

describe('formatBytes', () => {
  it('reads like a file listing', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
  });
});
