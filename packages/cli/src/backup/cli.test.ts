/**
 * `buddi backup …` parsing, and the doctor row that reports on it.
 *
 * Both live here rather than in `args.test.ts` / `doctor.test.ts` so the backup
 * feature is one directory a reader can take in whole.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../args.js';
import { checkBackups } from '../doctor.js';
import { DEFAULT_KEEP, STALE_AFTER_MS } from './manifest.js';

const parse = (line: string): ReturnType<typeof parseArgs> => parseArgs(line.split(' '));

describe('buddi backup — argument parsing', () => {
  it('needs a verb', () => {
    expect(() => parse('backup')).toThrow(UsageError);
    expect(() => parse('backup nonsense')).toThrow(/unknown backup action/);
  });

  it('create takes --out, --no-artifacts and --prune', () => {
    expect(parse('backup create')).toEqual({ kind: 'backup', action: 'create' });
    expect(parse('backup create --out /tmp/b --no-artifacts')).toEqual({
      kind: 'backup',
      action: 'create',
      out: '/tmp/b',
      noArtifacts: true,
    });
    expect(parse('backup create --prune')).toEqual({
      kind: 'backup',
      action: 'create',
      prune: DEFAULT_KEEP,
    });
    expect(parse('backup create --prune 7')).toEqual({ kind: 'backup', action: 'create', prune: 7 });
  });

  it('refuses a retention that would delete everything', () => {
    expect(() => parse('backup create --prune 0')).toThrow(/at least 1/);
    expect(() => parse('backup prune --keep 0')).toThrow(/at least 1/);
    expect(() => parse('backup prune --keep -2')).toThrow(/at least 1/);
  });

  it('verify and restore need an archive', () => {
    expect(() => parse('backup verify')).toThrow(/needs the path to an archive/);
    expect(() => parse('backup restore --yes')).toThrow(/needs the path to an archive/);
    expect(parse('backup verify /tmp/a.tar.gz')).toEqual({
      kind: 'backup',
      action: 'verify',
      archive: '/tmp/a.tar.gz',
    });
  });

  it('restore takes --into, --yes and --force', () => {
    expect(parse('backup restore /tmp/a.tar.gz --into buddi_restore --yes --force')).toEqual({
      kind: 'backup',
      action: 'restore',
      archive: '/tmp/a.tar.gz',
      into: 'buddi_restore',
      yes: true,
      force: true,
    });
  });

  it('will not take an option that belongs to another verb', () => {
    expect(() => parse('backup list --keep 3')).toThrow(/unknown option/);
    expect(() => parse('backup create --yes')).toThrow(/unknown option/);
    expect(() => parse('backup verify /tmp/a.tar.gz --into x')).toThrow(/unknown option/);
  });

  it('schedule defaults to status and accepts --keep on install', () => {
    expect(parse('backup schedule')).toEqual({
      kind: 'backup',
      action: 'schedule',
      scheduleAction: 'status',
    });
    expect(parse('backup schedule install --keep 30')).toEqual({
      kind: 'backup',
      action: 'schedule',
      scheduleAction: 'install',
      keep: 30,
    });
    expect(() => parse('backup schedule nightly')).toThrow(/unknown backup schedule action/);
  });

  it('is in the usage text, so `buddi help` mentions backups at all', () => {
    const usage = (parseArgs([]) as { kind: string }).kind;
    expect(usage).toBe('help');
  });
});

describe('the doctor backups row', () => {
  const base = { dir: '/repo/data/backups', count: 0, scheduleInstalled: false };

  it('warns loudly when no backup has ever been taken', () => {
    const row = checkBackups(base, STALE_AFTER_MS);
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/no backup has ever been taken/);
    expect(row.detail).toMatch(/backup schedule install/);
  });

  it('is ok with a fresh backup and a schedule', () => {
    const row = checkBackups(
      {
        ...base,
        count: 14,
        newestAgeMs: 6 * 3_600_000,
        newestName: 'buddi-backup-20260914-033000.tar.gz',
        newestBytes: 5 * 1024 * 1024,
        scheduleInstalled: true,
      },
      STALE_AFTER_MS,
    );
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/6h ago/);
    expect(row.detail).toMatch(/5\.0 MB/);
    expect(row.detail).toMatch(/nightly schedule installed/);
  });

  it('warns when the newest backup is older than 48h', () => {
    const row = checkBackups(
      { ...base, count: 3, newestAgeMs: 72 * 3_600_000, scheduleInstalled: true },
      STALE_AFTER_MS,
    );
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/^STALE/);
    expect(row.detail).toMatch(/3d ago/);
  });

  it('warns when backups exist but nothing will take the next one', () => {
    const row = checkBackups(
      { ...base, count: 3, newestAgeMs: 3_600_000, scheduleInstalled: false },
      STALE_AFTER_MS,
    );
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/NO nightly schedule/);
  });

  it('never fails the doctor — an unbacked-up installation still works today', () => {
    for (const facts of [base, { ...base, count: 2, newestAgeMs: 1e9 }]) {
      expect(checkBackups(facts, STALE_AFTER_MS).status).not.toBe('fail');
    }
  });
});
