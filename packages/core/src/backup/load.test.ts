/**
 * The pure half of the load: which schemas this build can rebuild, and the
 * sequence reset that decides what id the first insert after a restore gets.
 */
import { describe, expect, it } from 'vitest';
import { planSchemas, schemaDropProblem, schemasToDrop, setvalFor } from './load.js';
import type { DumpedMigrations } from './manifest.js';

const dumped = (plugins: Record<string, string[]>): DumpedMigrations => ({
  core: ['001_init.sql'],
  plugins: Object.fromEntries(
    Object.entries(plugins).map(([schema, filenames]) => [schema, { schema, filenames }]),
  ),
});

describe('which schemas a restore can rebuild', () => {
  it('rebuilds a plugin whose migrations this build has, at the dump’s level', () => {
    const plan = planSchemas(dumped({ finance: ['001_a.sql', '002_b.sql'] }), [
      { schema: 'finance', dir: '/pkg/finance/migrations' },
    ]);
    expect(plan.rebuild).toEqual([
      { schema: 'finance', dir: '/pkg/finance/migrations', upTo: '002_b.sql' },
    ]);
    expect(plan.missing).toEqual([]);
  });

  it('reports a plugin that is not installed here rather than failing', () => {
    const plan = planSchemas(dumped({ finance: ['001_a.sql'] }), []);
    expect(plan.rebuild).toEqual([]);
    expect(plan.missing).toEqual(['finance']);
  });

  it('treats a plugin that owns no migrations directory as absent', () => {
    const plan = planSchemas(dumped({ finance: ['001_a.sql'] }), [{ schema: 'finance', dir: '  ' }]);
    expect(plan.missing).toEqual(['finance']);
  });

  it('is deterministic with several plugins', () => {
    const plan = planSchemas(dumped({ zed: ['001.sql'], finance: ['001.sql'] }), [
      { schema: 'zed', dir: '/z' },
      { schema: 'finance', dir: '/f' },
    ]);
    expect(plan.rebuild.map((r) => r.schema)).toEqual(['finance', 'zed']);
  });
});

describe('which schemas a restore may drop', () => {
  it('drops core, what this build ships, and what the target says it migrated', () => {
    expect(
      schemasToDrop([{ schema: 'finance', dir: '/f' }], ['weather']),
    ).toEqual(['core', 'finance', 'weather']);
  });

  it('never drops a schema only the archive names', () => {
    // The archive is the untrusted half of a restore. A schema it names that
    // this build cannot rebuild is reported as missing, never dropped.
    expect(schemasToDrop([], [])).toEqual(['core']);
  });

  it('refuses the schemas that are not buddi’s', () => {
    expect(schemaDropProblem('public')).toContain('not buddi');
    expect(schemaDropProblem('information_schema')).toContain('not buddi');
    expect(schemaDropProblem('pg_catalog')).toContain('not buddi');
    expect(schemaDropProblem('pg_toast')).toContain('not buddi');
    expect(schemaDropProblem('drill"; drop database x --')).toContain('refusing to use');
    expect(schemaDropProblem('finance')).toBeNull();
    expect(schemaDropProblem('core')).toBeNull();
  });
});

describe('resetting a sequence', () => {
  it('carries the last value as text and keeps is_called', () => {
    const { sql, params } = setvalFor({
      schema: 'core',
      name: 'events_id_seq',
      lastValue: '9007199254740993',
      isCalled: true,
    });
    expect(sql).toContain('setval');
    // Text, not a number: 9007199254740993 does not survive a JS number.
    expect(params).toEqual(['"core"."events_id_seq"', '9007199254740993', true]);
  });

  it('keeps a sequence nothing has drawn from yet as not called', () => {
    expect(setvalFor({ schema: 'a', name: 's', lastValue: '1', isCalled: false }).params[2]).toBe(
      false,
    );
  });
});
