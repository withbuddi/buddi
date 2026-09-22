/**
 * The page contract: what a descriptor may say, and what a query may do.
 *
 * Two properties are worth a test here and the rest is the browser's problem:
 * a bad descriptor must fail *at load*, naming the plugin, the page and the
 * field — an installation that starts with a broken screen has already lost
 * the argument — and a query must not be able to write, because "reads are
 * queries, writes are tools" is the sentence the whole approval trail hangs
 * from.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isReadOnlyStatement,
  parsePageContributions,
  readOnlyPool,
  stripSqlNoise,
  ReadOnlyRefusal,
  type PageDescriptor,
} from './pages.js';
import { ToolRegistry } from './registry.js';
import { demoPagesManifest, demoPages, demoQueries } from './pages/__fixtures__/demo.js';
import type { Pool } from 'pg';
import type { PluginManifest, ToolContext } from './tools.js';

/** A descriptor, with whatever is wrong with it today. Deliberately untyped:
 *  the point of these tests is what happens to a descriptor the types would
 *  have refused — the one a plugin written in JavaScript can still ship. */
const page = (over: Record<string, unknown> = {}): unknown => ({
  id: 'board',
  title: 'Board',
  place: 'rail',
  body: [{ kind: 'notice', text: 'Hello.' }],
  ...over,
});

const parse = (pages: unknown[], opts: { queries?: string[]; tools?: string[] } = {}): PageDescriptor[] =>
  parsePageContributions({
    plugin: 'demo',
    pages,
    queries: (opts.queries ?? []).map((name) => ({ name, params: z.object({}), produce: async () => ({}) })),
    tools: opts.tools ?? [],
  });

describe('page descriptors', () => {
  it('accepts the fixture plugin, which uses every component once', () => {
    const parsed = parsePageContributions({
      plugin: 'demo',
      pages: demoPages,
      queries: demoQueries,
      tools: demoPagesManifest.tools.map((t) => t.name),
    });
    expect(parsed.map((p) => p.id)).toEqual(['board', 'settings']);
    const kinds = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record.kind === 'string') kinds.add(record.kind);
      Object.values(record).forEach(walk);
    };
    walk(parsed);
    expect([...kinds].sort()).toEqual(
      [
        'approval',
        'artifact',
        'detail',
        'editor',
        'expand',
        'form',
        'link',
        'list',
        'list-detail',
        'notice',
        'search',
        'section',
        'stats',
        'table',
      ].sort(),
    );
  });

  it('names the plugin, the page and the field when a descriptor is wrong', () => {
    expect(() =>
      parse([page({ body: [{ kind: 'list', query: { query: 'items' }, rows: 'items are here', item: { title: { path: 'title' } } }] })], {
        queries: ['items'],
      }),
    ).toThrow(/plugin demo: invalid page descriptor board — body\.0\.rows: a view path/);
  });

  it('refuses a component kind it does not have', () => {
    expect(() => parse([page({ body: [{ kind: 'chart', query: { query: 'x' } }] })])).toThrow(
      /invalid page descriptor board — body\.0\.kind/,
    );
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(() => parse([page({ body: [{ kind: 'notice', text: 'Hi.', colour: 'red' }] })])).toThrow(
      /body\.0: Unrecognized key\(s\) in object: 'colour'/,
    );
  });

  it('refuses a page id that is not a page id', () => {
    expect(() => parse([page({ id: 'Board Two' })])).toThrow(/invalid page descriptor Board Two — id/);
  });

  it('refuses two pages with the same id', () => {
    expect(() => parse([page(), page()])).toThrow('plugin demo: two pages are called board');
  });

  it('refuses a query the plugin does not contribute, saying which it has', () => {
    expect(() =>
      parse([page({ body: [{ kind: 'stats', query: { query: 'totals' }, items: [{ label: 'n', value: { path: 'n' } }] }] })], {
        queries: ['counts'],
      }),
    ).toThrow('plugin demo: page board, body[0].query.query: no query called totals — this plugin contributes counts');
  });

  it('refuses a tool the plugin does not contribute', () => {
    expect(() =>
      parse(
        [
          page({
            body: [
              {
                kind: 'form',
                fields: [{ name: 'a', label: 'A', type: 'text' }],
                submit: { tool: 'other.write', label: 'Go' },
              },
            ],
          }),
        ],
        { tools: ['demo.write'] },
      ),
    ).toThrow('plugin demo: page board, body[0].submit.tool: names other.write, which this plugin does not contribute');
  });

  it('refuses a link to a page that is not this plugin\'s', () => {
    expect(() => parse([page({ body: [{ kind: 'link', label: 'Away', to: { page: 'elsewhere' } }] })])).toThrow(
      'plugin demo: page board, body[0].to.page: links to elsewhere, which is not a page of this plugin',
    );
  });

  it('refuses a select field with no options', () => {
    expect(() =>
      parse(
        [
          page({
            body: [
              {
                kind: 'form',
                fields: [{ name: 'a', label: 'A', type: 'select' }],
                submit: { tool: 'demo.write', label: 'Go' },
              },
            ],
          }),
        ],
        { tools: ['demo.write'] },
      ),
    ).toThrow(/a select field needs `options`/);
  });

  it('refuses a list-detail whose list is not a list', () => {
    expect(() =>
      parse([
        page({
          body: [
            {
              kind: 'list-detail',
              param: 'item',
              list: { kind: 'notice', text: 'no' },
              detail: [],
            },
          ],
        }),
      ]),
    ).toThrow(/body\.0\.list/);
  });

  it('refuses two queries with the same name', () => {
    expect(() =>
      parsePageContributions({
        plugin: 'demo',
        queries: [
          { name: 'counts', params: z.object({}), produce: async () => ({}) },
          { name: 'counts', params: z.object({}), produce: async () => ({}) },
        ],
      }),
    ).toThrow('plugin demo: two page queries are called counts');
  });

  it('refuses a query name that is not one', () => {
    expect(() =>
      parsePageContributions({
        plugin: 'demo',
        queries: [{ name: 'Counts!', params: z.object({}), produce: async () => ({}) }],
      }),
    ).toThrow(/invalid page query name "Counts!"/);
  });
});

describe('the registry', () => {
  it('parses pages at register, so a bad one fails the plugin load', () => {
    const registry = new ToolRegistry();
    const broken: PluginManifest = {
      ...demoPagesManifest,
      pages: [page({ body: [{ kind: 'notice' }] }) as PageDescriptor],
    };
    expect(() => registry.register(broken)).toThrow(/plugin demo: invalid page descriptor board — body\.0\.text/);
    // Nothing was kept: the registry is exactly as it was.
    expect(registry.manifests()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('serves the pages and the queries with the plugin they came from', () => {
    const registry = new ToolRegistry();
    registry.register(demoPagesManifest);
    expect(registry.pages().map((p) => [p.plugin, p.id, p.place])).toEqual([
      ['demo', 'board', 'rail'],
      ['demo', 'settings', 'settings'],
    ]);
    expect(registry.queries().every((q) => q.plugin === 'demo')).toBe(true);
    expect(registry.queries().map((q) => q.name)).toContain('counts');
    expect(registry.pluginOf('demo.keep')).toBe('demo');
    expect(registry.pluginOf('other.keep')).toBeUndefined();
  });

  it('never lists an ownerOnly tool to a model', () => {
    const registry = new ToolRegistry();
    registry.register(demoPagesManifest);
    const listed = registry.list().map((t) => t.name);
    expect(listed).toContain('demo.keep');
    expect(listed).not.toContain('demo.add_account');
    expect(listed).not.toContain('demo.remove_account');
    // Still registered, and still executable by the one path that may.
    expect(registry.has('demo.add_account')).toBe(true);
  });

  it('invokes an ownerOnly tool for the owner and for nobody else', async () => {
    const registry = new ToolRegistry();
    registry.register(demoPagesManifest);
    const base = { db: null as unknown as Pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    const args = { address: 'a@example.com', password: 'x' };
    const asOwner = await registry.invoke('demo.add_account', args, { ...base, agentId: 'owner' } as ToolContext);
    expect(asOwner).toEqual({ ok: true, output: { added: true } });
    const asAgent = await registry.invoke('demo.add_account', args, { ...base, agentId: 'scribe' } as ToolContext);
    expect(asAgent).toEqual({ ok: false, reason: 'unknown-tool', message: 'unknown tool: demo.add_account' });
  });
});

describe('the read-only pool', () => {
  const statements: string[] = [];
  const fake = {
    query: (sql: unknown) => {
      statements.push(String(sql));
      return Promise.resolve({ rows: [] });
    },
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  } as unknown as Pool;

  it('lets a select through, statement and values alike', async () => {
    statements.length = 0;
    const pool = readOnlyPool(fake);
    await pool.query('select id from demo.things where id = $1', ['a1']);
    await pool.query({ text: 'with recent as (select 1) select * from recent' });
    expect(statements).toHaveLength(2);
  });

  it('refuses everything that is not a read', async () => {
    const pool = readOnlyPool(fake);
    for (const sql of [
      'update demo.things set state = 1',
      'insert into demo.things (id) values (1)',
      'delete from demo.things',
      'truncate demo.things',
      'create table demo.x (a int)',
      'select 1; delete from demo.things',
      'select * from demo.things for update',
      'select * from demo.things for no key update',
      'with moved as (delete from demo.things returning *) select * from moved',
      'do $$ begin end $$',
      '',
    ]) {
      await expect(pool.query(sql)).rejects.toThrow(ReadOnlyRefusal);
    }
  });

  it('is not fooled by a comment or a literal', () => {
    expect(isReadOnlyStatement("/* update */ select 'delete from x' as t")).toBe(true);
    expect(isReadOnlyStatement('-- select\nupdate demo.things set a = 1')).toBe(false);
    expect(isReadOnlyStatement("select 1 where x = '; drop table y'")).toBe(true);
    expect(isReadOnlyStatement("select * from t where note = 'for update'")).toBe(true);
    // Column names that merely start with a forbidden word are still fine.
    expect(isReadOnlyStatement('select deleted_at, updated_at, offset_days from t')).toBe(true);
  });

  it('blanks comments, literals and dollar quotes when it reads a statement', () => {
    expect(stripSqlNoise("select 'a' /* b */ -- c\nfrom t").replace(/ +/g, ' ')).toBe('select \nfrom t');
    expect(stripSqlNoise('select $tag$ delete from t $tag$').includes('delete')).toBe(false);
  });

  it('refuses a client, because a transaction is a write', () => {
    const pool = readOnlyPool(fake);
    expect(() => pool.connect()).toThrow(ReadOnlyRefusal);
    expect(() => pool.end()).toThrow(ReadOnlyRefusal);
  });
});
