/**
 * The pure half of the dump: the order tables are written in, how the migration
 * ledger is split, and reading the server's major version.
 */
import { describe, expect, it } from 'vitest';
import { DumpError, orderTables, postgresMajorFrom, quote, splitMigrations } from './dump.js';
import type { MigrationRecord } from './manifest.js';

const t = (schema: string, table: string): { schema: string; table: string } => ({ schema, table });

describe('dump order', () => {
  it('puts a parent before the table that references it', () => {
    const order = orderTables(
      [t('drill', 'entries'), t('drill', 'accounts')],
      [{ from: t('drill', 'entries'), to: t('drill', 'accounts') }],
    );
    expect(order.map((r) => r.table)).toEqual(['accounts', 'entries']);
  });

  it('orders a chain of three, whatever order they arrive in', () => {
    const order = orderTables(
      [t('a', 'c'), t('a', 'a'), t('a', 'b')],
      [
        { from: t('a', 'c'), to: t('a', 'b') },
        { from: t('a', 'b'), to: t('a', 'a') },
      ],
    );
    expect(order.map((r) => r.table)).toEqual(['a', 'b', 'c']);
  });

  it('is stable: the same input gives the same order', () => {
    const tables = [t('b', 'x'), t('a', 'y'), t('a', 'x')];
    expect(orderTables(tables, [])).toEqual(orderTables([...tables].reverse(), []));
  });

  it('survives a cycle rather than dropping a table', () => {
    const order = orderTables(
      [t('a', 'one'), t('a', 'two')],
      [
        { from: t('a', 'one'), to: t('a', 'two') },
        { from: t('a', 'two'), to: t('a', 'one') },
      ],
    );
    expect(order).toHaveLength(2);
  });

  it('ignores a self-reference and a parent outside the dump', () => {
    const order = orderTables(
      [t('a', 'tree')],
      [
        { from: t('a', 'tree'), to: t('a', 'tree') },
        { from: t('a', 'tree'), to: t('other', 'thing') },
      ],
    );
    expect(order).toEqual([t('a', 'tree')]);
  });

  it('keeps every table exactly once', () => {
    const tables = [t('a', 'one'), t('a', 'two'), t('a', 'three')];
    const order = orderTables(tables, [
      { from: t('a', 'three'), to: t('a', 'one') },
      { from: t('a', 'two'), to: t('a', 'one') },
    ]);
    expect(order).toHaveLength(3);
    expect(new Set(order.map((r) => r.table)).size).toBe(3);
    expect(order[0]).toEqual(t('a', 'one'));
  });
});

describe('the migration ledger, as the archive carries it', () => {
  const record = (schema: string, filename: string): MigrationRecord => ({
    schema,
    filename,
    appliedAt: null,
    sha256: null,
  });

  it('separates core from each plugin schema', () => {
    const split = splitMigrations([
      record('core', '002_events.sql'),
      record('core', '001_init.sql'),
      record('finance', '001_accounts.sql'),
    ]);
    expect(split.core).toEqual(['001_init.sql', '002_events.sql']);
    expect(split.plugins).toEqual({
      finance: { schema: 'finance', filenames: ['001_accounts.sql'] },
    });
  });

  it('is empty for a database nothing has migrated', () => {
    expect(splitMigrations([])).toEqual({ core: [], plugins: {} });
  });
});

describe('identifiers and versions', () => {
  it('quotes what it will interpolate and refuses what it will not', () => {
    expect(quote('core')).toBe('"core"');
    expect(() => quote('drop table x; --')).toThrow(DumpError);
  });

  it('reads the major out of select version()', () => {
    expect(postgresMajorFrom('PostgreSQL 16.4 on aarch64-apple-darwin')).toBe(16);
    expect(postgresMajorFrom('nothing like it')).toBe(0);
  });
});
