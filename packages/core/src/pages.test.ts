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
  }).pages;

describe('page descriptors', () => {
  it('accepts the fixture plugin, which uses every component once', () => {
    const parsed = parsePageContributions({
      plugin: 'demo',
      pages: demoPages,
      queries: demoQueries,
      tools: demoPagesManifest.tools.map((t) => t.name),
    }).pages;
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
        'button',
        'detail',
        'editor',
        'expand',
        'form',
        'link',
        'list',
        'list-detail',
        'notice',
        'repeat',
        'search',
        'section',
        'stats',
        'table',
      ].sort(),
    );
  });

  it('names the plugin, the page and the field when a descriptor is wrong', () => {
    expect(() =>
      parse([page({ body: [{ kind: 'list', query: { query: 'items' }, key: 'id', rows: 'items are here', item: { title: { path: 'title' } } }] })], {
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

  it('knows which tools the pages actually name — and no others', () => {
    const registry = new ToolRegistry();
    registry.register(demoPagesManifest);
    const named = registry.pageTools('demo');
    expect(named).toContain('demo.keep');
    expect(named).toContain('demo.add_account');
    // A tool of this plugin that no page writes through: an agent's business,
    // not a button's, and therefore not something the act route may invoke.
    expect(named).not.toContain('demo.quiet');
    expect(registry.has('demo.quiet')).toBe(true);
    expect(registry.pageTools('other')).toEqual([]);
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

describe('what a descriptor may not be', () => {
  it('refuses a list with nothing to key a row by', () => {
    expect(() =>
      parse([page({ body: [{ kind: 'list', query: { query: 'items' }, rows: 'items', item: { title: { path: 't' } } }] })], {
        queries: ['items'],
      }),
    ).toThrow(/page board, body\[0\]: a list needs `key`/);
  });

  it('refuses a condition that asks nothing', () => {
    expect(() =>
      parse([page({ body: [{ kind: 'notice', text: 'Hi.', when: { path: 'state' } }] })]),
    ).toThrow(/body\.0\.when: a condition needs `equals` or `in`/);
  });

  it('refuses a descriptor that refers to itself', () => {
    const cyclic: Record<string, unknown> = { id: 'board', title: 'Board', place: 'rail' };
    cyclic.body = [{ kind: 'notice', text: 'Hi.', me: cyclic }];
    expect(() => parse([cyclic])).toThrow(/page descriptor board refers to itself/);
  });

  it('refuses one that is deeper than a screen', () => {
    let body: unknown[] = [{ kind: 'notice', text: 'The bottom.' }];
    for (let i = 0; i < 12; i += 1) body = [{ kind: 'section', body }];
    expect(() => parse([page({ body })])).toThrow(/nests deeper than 12|has more than 400 nodes/);
  });

  it('refuses one that is bigger than a screen', () => {
    // Within every other limit — 290 nodes, three deep — and still 100 KB of
    // JSON, which is not a screen.
    const body = Array.from({ length: 16 }, () => ({
      kind: 'section',
      body: Array.from({ length: 16 }, () => ({ kind: 'notice', text: 'x'.repeat(400) })),
    }));
    expect(() => parse([page({ body })])).toThrow(/is \d+ bytes; a descriptor is a screen/);
  });

  it('reads a group label called `page` as a label, not as a route', () => {
    expect(() =>
      parse(
        [
          page({
            body: [
              {
                kind: 'list',
                query: { query: 'items' },
                rows: 'items',
                key: 'id',
                item: { title: { path: 't' } },
                // Keys here come from the *data*, not from the grammar.
                groupBy: { key: 'state', labels: { page: 'Page', tool: 'Tool', query: 'Query' } },
              },
            ],
          }),
        ],
        { queries: ['items'] },
      ),
    ).not.toThrow();
  });

  it('reads a select option called `tool` as an option', () => {
    expect(() =>
      parse(
        [
          page({
            body: [
              {
                kind: 'form',
                fields: [
                  {
                    name: 'a',
                    label: 'A',
                    type: 'select',
                    options: [{ value: 'tool', label: 'Tool' }],
                  },
                ],
                submit: { tool: 'demo.write', label: 'Go' },
              },
            ],
          }),
        ],
        { tools: ['demo.write'] },
      ),
    ).not.toThrow();
  });

  it('checks the page\'s own read like any other', () => {
    expect(() => parse([page({ data: { query: 'nope' } })], { queries: ['counts'] })).toThrow(
      /page board, data\.query: no query called nope/,
    );
  });
});

describe('what a query must be', () => {
  const query = (over: Record<string, unknown>): unknown =>
    ({ name: 'q', params: z.object({}), produce: async () => ({}), ...over });

  it('refuses one whose params are not an object schema', () => {
    expect(() =>
      parsePageContributions({ plugin: 'demo', queries: [query({ params: z.string() }) as never] }),
    ).toThrow(/page query q must declare `params` as a zod object schema/);
  });

  it('makes a plain object schema strict, so the framework refuses unknown keys', () => {
    const { queries } = parsePageContributions({
      plugin: 'demo',
      queries: [query({ params: z.object({ id: z.string() }) }) as never],
    });
    const parsed = queries[0]!.params.safeParse({ id: 'a', sneaky: '1' });
    expect(parsed.success).toBe(false);
  });

  it('leaves an already strict schema alone', () => {
    const strict = z.object({ id: z.string() }).strict();
    const { queries } = parsePageContributions({ plugin: 'demo', queries: [query({ params: strict }) as never] });
    expect(queries[0]!.params).toBe(strict);
  });

  it('refuses one with no `produce`, or a `result` that is not a schema', () => {
    expect(() => parsePageContributions({ plugin: 'demo', queries: [query({ produce: 'soon' }) as never] })).toThrow(
      /page query q has no `produce` function/,
    );
    expect(() => parsePageContributions({ plugin: 'demo', queries: [query({ result: {} }) as never] })).toThrow(
      /page query q declares a `result` that is not a zod schema/,
    );
  });
});

describe('the read-only pre-filter', () => {
  it('lets a read through, whatever its columns are called', () => {
    // The keyword list is gone: these are ordinary column names, and the old
    // scanner refused every one of them.
    expect(isReadOnlyStatement('select comment from t')).toBe(true);
    expect(isReadOnlyStatement('select * from comments where comment = 1')).toBe(true);
    expect(isReadOnlyStatement('select set, copy, execute, lock from t')).toBe(true);
    expect(isReadOnlyStatement('select deleted_at, updated_at, offset_days from t')).toBe(true);
    expect(isReadOnlyStatement('with recent as (select 1) select * from recent')).toBe(true);
    expect(isReadOnlyStatement('select 1 limit 10 offset 5')).toBe(true);
  });

  it('refuses what is plainly not a read before it costs a connection', () => {
    for (const sql of [
      'update demo.things set state = 1',
      'insert into demo.things (id) values (1)',
      'delete from demo.things',
      'explain analyze update demo.things set a = 1',
      'select 1; delete from demo.things',
      'select * from demo.things for update',
      'select * from demo.things for no key update',
      'select * into evil from core.secrets',
      'select 1 into new_table',
      'with x as (select 1) select * into t from x',
      'do $$ begin end $$',
      '',
    ]) {
      expect([sql, isReadOnlyStatement(sql)]).toEqual([sql, false]);
    }
  });

  it('is not fooled by a comment or a literal', () => {
    expect(isReadOnlyStatement("/* update */ select 'delete from x' as t")).toBe(true);
    expect(isReadOnlyStatement('-- select\nupdate demo.things set a = 1')).toBe(false);
    expect(isReadOnlyStatement("select 1 where x = '; drop table y'")).toBe(true);
    expect(isReadOnlyStatement("select * from t where note = 'for update'")).toBe(true);
  });

  it('blanks comments, literals and dollar quotes when it reads a statement', () => {
    expect(stripSqlNoise("select 'a' /* b */ -- c\nfrom t").replace(/ +/g, ' ')).toBe('select \nfrom t');
    expect(stripSqlNoise('select $tag$ delete from t $tag$').includes('delete')).toBe(false);
  });

  it('refuses a client, because a transaction is a write', () => {
    const pool = readOnlyPool({} as unknown as Pool);
    expect(() => pool.connect()).toThrow(ReadOnlyRefusal);
    expect(() => pool.end()).toThrow(ReadOnlyRefusal);
  });

  it('says nothing about the statement it refused', async () => {
    const pool = readOnlyPool({} as unknown as Pool);
    await expect(pool.query('update core.secrets set token = 1')).rejects.toThrow(
      /^a page query may only read: this statement is not a select\.$/,
    );
  });
});
