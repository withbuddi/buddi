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
import type { PluginManifest, CoreToolContext } from './tools.js';

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
        'chart',
        'detail',
        'editor',
        'expand',
        'form',
        'link',
        'list',
        'list-detail',
        'notice',
        'progress',
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
    expect(() => parse([page({ body: [{ kind: 'map', query: { query: 'x' } }] })])).toThrow(
      /invalid page descriptor board — body\.0\.kind/,
    );
  });

  it('takes a chart of one series or several, and refuses one that says how it looks', () => {
    const chart = { kind: 'chart', query: { query: 'series' }, rows: 'points', x: 'at', y: 'value', label: 'Weight', target: { path: 'target' } };
    expect(parse([page({ body: [chart] })], { queries: ['series'] })[0]!.body[0]).toMatchObject({ kind: 'chart', y: 'value' });
    expect(parse([page({ body: [{ ...chart, y: ['a', 'b'], type: 'bar' }] })], { queries: ['series'] })[0]!.body[0]).toMatchObject({ y: ['a', 'b'], type: 'bar' });
    expect(() => parse([page({ body: [{ ...chart, type: 'pie' }] })], { queries: ['series'] })).toThrow(/body\.0\.type/);
    expect(() => parse([page({ body: [{ ...chart, colour: 'red' }] })], { queries: ['series'] })).toThrow(/Unrecognized key\(s\) in object: 'colour'/);
    expect(() => parse([page({ body: [{ ...chart, y: [] }] })], { queries: ['series'] })).toThrow(/body\.0\.y/);
    expect(() => parse([page({ body: [{ ...chart, query: { query: 'other' } }] })], { queries: ['series'] })).toThrow(/no query called other/);
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

  it('takes a gated action\'s pending sentence, and refuses one that is not a sentence', () => {
    const withPending = (pending: unknown): unknown =>
      page({ body: [{ kind: 'button', action: { tool: 'demo.write', label: 'Send', pending } }] });
    const [parsed] = parse([withPending('Nothing has been sent.')], { tools: ['demo.write'] });
    expect((parsed!.body[0] as { action: { pending?: string } }).action.pending).toBe('Nothing has been sent.');
    expect(() => parse([withPending('')], { tools: ['demo.write'] })).toThrow(/body\.0\.action\.pending/);
    expect(() => parse([withPending(42)], { tools: ['demo.write'] })).toThrow(/body\.0\.action\.pending/);
    expect(() => parse([withPending('x'.repeat(401))], { tools: ['demo.write'] })).toThrow(/body\.0\.action\.pending/);
  });

  it('takes the words and tones a pill gives its values, and refuses a tone it does not have', () => {
    const withPill = (pill: Record<string, unknown>): unknown =>
      page({
        body: [
          {
            kind: 'list',
            query: { query: 'rows' },
            rows: 'rows',
            key: 'id',
            item: { title: { path: 'title' }, pills: [{ value: { path: 'state' }, ...pill }] },
          },
          {
            kind: 'table',
            query: { query: 'rows' },
            rows: 'rows',
            columns: [{ key: 'state', label: 'State', pill: { labels: { 'on-track': 'On track' } } }],
          },
        ],
      });
    const [parsed] = parse([withPill({ labels: { 'waiting-on-me': 'Waiting on you', page: 'A page' }, tones: { 'waiting-on-me': 'warning' } })], {
      queries: ['rows'],
    });
    const list = parsed!.body[0] as { item: { pills: Array<{ labels?: Record<string, string>; tones?: Record<string, string> }> } };
    expect(list.item.pills[0]!.labels).toEqual({ 'waiting-on-me': 'Waiting on you', page: 'A page' });
    expect(list.item.pills[0]!.tones).toEqual({ 'waiting-on-me': 'warning' });
    expect(() => parse([withPill({ tones: { open: 'loud' } })], { queries: ['rows'] })).toThrow(/tones/);
    expect(() => parse([withPill({ labels: { open: '' } })], { queries: ['rows'] })).toThrow(/labels/);
  });

  it('takes how a column fits and the tooltip behind it, and refuses a fit it does not know', () => {
    const withColumn = (column: Record<string, unknown>): unknown =>
      page({
        body: [
          {
            kind: 'table',
            query: { query: 'rows' },
            rows: 'rows',
            columns: [{ key: 'address', label: 'Address', ...column }],
          },
        ],
      });
    const [parsed] = parse([withColumn({ fit: 'wrap' })], { queries: ['rows'] });
    expect((parsed!.body[0] as { columns: Array<{ fit?: string }> }).columns[0]!.fit).toBe('wrap');
    const [cut] = parse([withColumn({ fit: 'truncate', hint: 'secretName' })], { queries: ['rows'] });
    expect((cut!.body[0] as { columns: Array<{ fit?: string; hint?: string }> }).columns[0]).toMatchObject({
      fit: 'truncate',
      hint: 'secretName',
    });
    expect(() => parse([withColumn({ fit: 'squeeze' })], { queries: ['rows'] })).toThrow(/fit/);
    expect(() => parse([withColumn({ wrap: true })], { queries: ['rows'] })).toThrow();
    expect(() => parse([withColumn({ hint: '' })], { queries: ['rows'] })).toThrow(/hint/);
  });

  it('takes a row action that asks for a field first, and refuses a field it does not ask for', () => {
    const withAction = (action: Record<string, unknown>): unknown =>
      page({
        body: [
          {
            kind: 'table',
            query: { query: 'rows' },
            rows: 'rows',
            columns: [{ key: 'address', label: 'Address' }],
            actions: [{ tool: 'demo.set_secret', label: 'Set password', ...action }],
          },
        ],
      });
    const form = {
      title: 'Set the password for {address}',
      fields: [{ name: 'password', label: 'Password', type: 'secret', required: true }],
      submit: 'Test and save',
      openWhen: { account: { row: 'id' }, set: 'password' },
    };
    const opts = { queries: ['rows'], tools: ['demo.set_secret'] };
    const [parsed] = parse([withAction({ form, args: { id: { row: 'id' }, password: { field: 'password' } } })], opts);
    const action = (parsed!.body[0] as { actions: Array<{ form?: { openWhen?: unknown } }> }).actions[0]!;
    expect(action.form?.openWhen).toEqual({ account: { row: 'id' }, set: 'password' });
    // A field argument with no form, or naming a field the form does not have.
    expect(() => parse([withAction({ args: { password: { field: 'password' } } })], opts)).toThrow(/field/);
    expect(() => parse([withAction({ form, args: { other: { field: 'other' } } })], opts)).toThrow(/field/);
    expect(() => parse([withAction({ form: { ...form, openWhen: {} }, args: {} })], opts)).toThrow(/openWhen/);
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
    ).toThrow(/a select field needs `options` or `optionsFrom`/);
  });

  it('takes a select whose options are a query instead of a list', () => {
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
                    optionsFrom: { query: { query: 'items' }, rows: 'items', value: 'id', label: 'title' },
                  },
                ],
                submit: { tool: 'demo.write', label: 'Go' },
              },
            ],
          }),
        ],
        { tools: ['demo.write'], queries: ['items'] },
      ),
    ).not.toThrow();
  });

  it('takes a form laid out three to a row, and no other count', () => {
    const form = (columns: unknown) => [
      page({ body: [{ kind: 'form', columns, fields: [{ name: 'a', label: 'A', type: 'text' }], submit: { tool: 'demo.write', label: 'Go' } }] }),
    ];
    expect(() => parse(form(3) as never, { tools: ['demo.write'] })).not.toThrow();
    expect(() => parse(form(2) as never, { tools: ['demo.write'] })).not.toThrow();
    expect(() => parse(form(4) as never, { tools: ['demo.write'] })).toThrow();
  });

  it('takes a select with several choices, and `multiple` on nothing else', () => {
    const form = (field: Record<string, unknown>) => [
      page({ body: [{ kind: 'form', fields: [field], submit: { tool: 'demo.write', label: 'Go' } }] }),
    ];
    const options = [{ value: 'en', label: 'English' }, { value: 'fr', label: 'French' }];
    expect(() => parse(form({ name: 'a', label: 'A', type: 'select', multiple: true, options }) as never, { tools: ['demo.write'] })).not.toThrow();
    expect(() => parse(form({ name: 'a', label: 'A', type: 'text', multiple: true }) as never, { tools: ['demo.write'] })).toThrow(
      /`multiple` is for a select field only/,
    );
  });

  it('takes an action beside a single select, names its tool, and refuses it anywhere else', () => {
    const options = [{ value: 'alloy', label: 'Alloy' }];
    const form = (field: Record<string, unknown>) => [
      page({ body: [{ kind: 'form', fields: [field], submit: { tool: 'demo.write', label: 'Go' } }] }),
    ];
    const action = { tool: 'demo.preview', label: 'Play a sample', icon: 'play', args: { voice: { field: 'voice' } } };
    const tools = { tools: ['demo.write', 'demo.preview'] };
    expect(() => parse(form({ name: 'voice', label: 'Voice', type: 'select', options, action }) as never, tools)).not.toThrow();
    // The act route may invoke it: a page names it.
    expect(
      parsePageContributions({
        plugin: 'demo',
        pages: form({ name: 'voice', label: 'Voice', type: 'select', options, action }),
        tools: tools.tools,
      }).tools,
    ).toContain('demo.preview');
    expect(() => parse(form({ name: 'voice', label: 'Voice', type: 'text', action }) as never, tools)).toThrow(
      /a field `action` sits beside a single select/,
    );
    expect(() =>
      parse(form({ name: 'voice', label: 'Voice', type: 'select', multiple: true, options, action }) as never, tools),
    ).toThrow(/a field `action` sits beside a single select/);
    expect(() =>
      parse(form({ name: 'voice', label: 'Voice', type: 'select', options, action: { ...action, icon: 'rocket' } }) as never, tools),
    ).toThrow(/icon/);
    expect(() =>
      parse(form({ name: 'voice', label: 'Voice', type: 'select', options, action }) as never, { tools: ['demo.write'] }),
    ).toThrow(/names demo\.preview, which this plugin does not contribute/);
  });

  it('checks the query a select reads its options from', () => {
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
                    optionsFrom: { query: { query: 'nope' }, rows: 'items', value: 'id', label: 'title' },
                  },
                ],
                submit: { tool: 'demo.write', label: 'Go' },
              },
            ],
          }),
        ],
        { tools: ['demo.write'], queries: ['items'] },
      ),
    ).toThrow(/no query called nope/);
  });

  it('refuses a section header action that is not a link or a button', () => {
    expect(() =>
      parse([page({ body: [{ kind: 'section', actions: [{ kind: 'notice', text: 'No.' }], body: [] }] })]),
    ).toThrow(/header actions are links and buttons/);
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

  it('takes a calendar whose query takes the range, and refuses one that does not', () => {
    const calendar = (over: Record<string, unknown> = {}): unknown =>
      page({
        body: [
          {
            kind: 'calendar',
            query: { query: 'agenda', params: { calendars: { param: 'calendars' } } },
            events: 'events',
            map: { id: 'id', title: 'title', start: 'start', end: 'end', allDay: 'allDay', calendar: 'calendar', tone: 'tone', location: 'location' },
            views: ['week', 'month', 'list'],
            default: 'week',
            hours: [7, 21],
            ...over,
          },
        ],
      });
    const ranged = (params: z.AnyZodObject) =>
      (pages: unknown[]) =>
        parsePageContributions({ plugin: 'demo', pages, queries: [{ name: 'agenda', params, produce: async () => ({}) }] }).pages;
    const withRange = ranged(z.object({ from: z.string().optional(), to: z.string().optional(), calendars: z.string().optional() }));
    expect(withRange([calendar()])[0]!.body[0]).toMatchObject({ kind: 'calendar', views: ['week', 'month', 'list'] });
    expect(withRange([calendar({ views: undefined, default: undefined, hours: undefined })])).toHaveLength(1);
    // The query must take the days the page asks for.
    expect(() => ranged(z.object({ calendars: z.string().optional() }))([calendar()])).toThrow(
      /page board, body\[0\]: the calendar's query agenda must take `from` and `to`/,
    );
    // It opens on a view it offers.
    expect(() => withRange([calendar({ views: ['month', 'list'], default: 'week' })])).toThrow(/opens on week, which is not one of its views/);
    // No view it does not have, none twice, and a map that names its start.
    expect(() => withRange([calendar({ views: ['day'] })])).toThrow(/body\.0\.views\.0/);
    expect(() => withRange([calendar({ views: ['week', 'week'] })])).toThrow(/names each view once/);
    expect(() => withRange([calendar({ map: { id: 'id', title: 'title', end: 'end' } })])).toThrow(/body\.0\.map\.start/);
    expect(() => withRange([calendar({ map: { id: 'id', title: 'title', start: 'start', end: 'end', colour: 'c' } })])).toThrow(/body\.0\.map/);
    // Hours are a part of a day, in order, and at least four of them.
    expect(() => withRange([calendar({ hours: [21, 7] })])).toThrow(/at least four hours/);
    expect(() => withRange([calendar({ hours: [7, 25] })])).toThrow(/body\.0\.hours/);
    // A calendar names a query like anything else that reads.
    expect(() => parse([calendar()], { queries: ['items'] })).toThrow(/no query called agenda/);
  });

  it('takes tabs with a pick over a hero, tiles and a two-kind chart, and refuses what they cannot mean', () => {
    const q = ['places', 'today', 'days', 'hours'];
    const tabs = (over: Record<string, unknown> = {}, today: unknown[] = []): unknown =>
      page({
        icon: 'cloud',
        body: [
          {
            kind: 'tabs',
            pick: { param: 'place', label: 'Place', optionsFrom: { query: { query: 'places' }, rows: 'places', value: 'id', label: 'label' } },
            default: 'today',
            tabs: [
              {
                id: 'today',
                label: 'Today',
                body: [
                  { kind: 'hero', query: { query: 'today', params: { place: { param: 'place' } } }, icon: { path: 'icon' }, value: 'now', title: 'sky', facts: [{ label: 'Wind', path: 'wind' }] },
                  { kind: 'chart', query: { query: 'hours' }, rows: 'hours', x: 'time', series: [{ y: 'temp', type: 'line', label: 'Temperature' }, { y: 'rain', type: 'bar', label: 'Rain', unit: 'percent' }] },
                  ...today,
                ],
              },
              {
                id: 'week',
                label: 'Week',
                body: [{ kind: 'tiles', query: { query: 'days' }, items: 'days', icon: { const: 'sun' }, value: 'value', label: 'label', lines: ['rain', 'wind'], layout: 'row', select: { param: 'date', key: 'date' } }],
              },
            ],
            ...over,
          },
        ],
      });
    const [parsed] = parse([tabs()], { queries: q });
    expect(parsed!.icon).toBe('cloud');
    expect(parsed!.body[0]).toMatchObject({ kind: 'tabs', tabs: [{ id: 'today' }, { id: 'week' }] });
    // A tab bar opens on a tab it has; ids are its own; at least two tabs.
    expect(() => parse([tabs({ default: 'month' })], { queries: q })).toThrow(/opens on month, which is not one of its tabs \(today, week\)/);
    expect(() => parse([tabs({ tabs: [{ id: 'a', label: 'A', body: [] }, { id: 'a', label: 'B', body: [] }] })], { queries: q })).toThrow(/each tab has its own id/);
    expect(() => parse([tabs({ tabs: [{ id: 'a', label: 'A', body: [] }] })], { queries: q })).toThrow(/body\.0\.tabs/);
    // A pick's choices come from one place, and its query is checked like any other.
    expect(() => parse([tabs({ pick: { param: 'place', label: 'Place' } })], { queries: q })).toThrow(/`options` or from `optionsFrom`/);
    expect(() => parse([tabs()], { queries: ['today', 'days', 'hours'] })).toThrow(/no query called places/);
    // A chart takes `y` or `series`, and with `series` each says its type.
    const chart = (over: Record<string, unknown>) => tabs({}, [{ kind: 'chart', query: { query: 'hours' }, x: 'time', ...over }]);
    expect(() => parse([chart({})], { queries: q })).toThrow(/a chart takes `y` or `series`, one of the two/);
    expect(() => parse([chart({ y: 'temp', series: [{ y: 'rain', type: 'bar', label: 'Rain' }] })], { queries: q })).toThrow(/one of the two/);
    expect(() => parse([chart({ type: 'bar', series: [{ y: 'rain', type: 'bar', label: 'Rain' }] })], { queries: q })).toThrow(/each series says its own type/);
    expect(() => parse([chart({ series: [{ y: 'rain', type: 'area', label: 'Rain' }] })], { queries: q })).toThrow(/series\.0\.type/);
    // Tiles: a pinned glyph or a path, a known layout, two lines at most.
    const tile = (over: Record<string, unknown>) => tabs({}, [{ kind: 'tiles', query: { query: 'days' }, items: 'days', icon: { const: 'sun' }, value: 'v', label: 'l', ...over }]);
    expect(() => parse([tile({ icon: { const: 'rocket' } })], { queries: q })).toThrow(/icon/);
    expect(() => parse([tile({ layout: 'carousel' })], { queries: q })).toThrow(/layout/);
    expect(() => parse([tile({ lines: ['a', 'b', 'c'] })], { queries: q })).toThrow(/lines/);
    expect(() => parse([tile({ select: { param: 'date' } })], { queries: q })).toThrow(/select\.key/);
    // A hero's facts are labelled paths.
    expect(() => parse([tabs({}, [{ kind: 'hero', query: { query: 'today' }, icon: { path: 'icon' }, value: 'now', title: 'sky', facts: [{ path: 'wind' }] }])], { queries: q })).toThrow(/facts\.0\.label/);
  });

  it('takes a series panel, and refuses what it cannot mean', () => {
    const panel = (over: Record<string, unknown> = {}): unknown =>
      page({
        body: [
          {
            kind: 'series-panel',
            title: 'Today',
            query: { query: 'hours', params: { place: { param: 'place' } } },
            points: 'hours',
            x: 'time',
            series: [
              { id: 'temp', label: 'Temperature', y: 'temp', unit: 'temp', kind: 'area' },
              { id: 'rain', label: 'Rain', y: 'chance', unit: 'percent', kind: 'bars' },
              { id: 'wind', label: 'Wind', y: 'wind', unit: 'speed', kind: 'area' },
            ],
            tiles: { icon: { path: 'icon' }, value: 'value', label: 'time', lines: ['rain'] },
            labelEvery: 3,
            ...over,
          },
        ],
      });
    const [parsed] = parse([panel()], { queries: ['hours'] });
    expect(parsed!.body[0]).toMatchObject({ kind: 'series-panel', series: [{ id: 'temp' }, { id: 'rain' }, { id: 'wind' }] });
    expect(() => parse([panel()], { queries: ['days'] })).toThrow(/no query called hours/);
    const one = (s: Record<string, unknown>) => panel({ series: [{ id: 'temp', label: 'T', y: 'temp', kind: 'area', ...s }] });
    expect(() => parse([one({ kind: 'line' })], { queries: ['hours'] })).toThrow(/series\.0\.kind/);
    expect(() => parse([one({ unit: 'kelvin' })], { queries: ['hours'] })).toThrow(/series\.0\.unit/);
    expect(() => parse([panel({ series: [] })], { queries: ['hours'] })).toThrow(/series/);
    expect(() =>
      parse([panel({ series: [{ id: 'a', label: 'A', y: 'a', kind: 'area' }, { id: 'a', label: 'B', y: 'b', kind: 'bars' }] })], { queries: ['hours'] }),
    ).toThrow(/each series has its own id/);
    expect(() => parse([panel({ labelEvery: 0 })], { queries: ['hours'] })).toThrow(/labelEvery/);
    expect(() => parse([panel({ tiles: { icon: { const: 'rocket' }, value: 'v', label: 'l' } })], { queries: ['hours'] })).toThrow(/tiles\.icon/);
    expect(() => parse([panel({ tiles: { icon: { path: 'icon' }, value: 'v', label: 'l', lines: ['a', 'b', 'c'] } })], { queries: ['hours'] })).toThrow(/tiles\.lines/);
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
    const asOwner = await registry.invoke('demo.add_account', args, { ...base, agentId: 'owner' } as CoreToolContext);
    expect(asOwner).toEqual({ ok: true, output: { added: true } });
    const asAgent = await registry.invoke('demo.add_account', args, { ...base, agentId: 'scribe' } as CoreToolContext);
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

  it('refuses a descriptor that contains itself', () => {
    const cyclic: Record<string, unknown> = { id: 'board', title: 'Board', place: 'rail' };
    cyclic.body = [{ kind: 'notice', text: 'Hi.', me: cyclic }];
    expect(() => parse([cyclic])).toThrow(/page descriptor board contains itself/);
  });

  it('lets a descriptor use the same object twice: reuse is not a cycle', () => {
    // The same action on two rows, written once. Nothing here contains
    // itself, and a walk that only remembers "seen" would call it a cycle.
    const keep = { tool: 'demo.keep', label: 'Keep', args: { id: { row: 'id' } } };
    const list = (title: string): unknown => ({
      kind: 'list',
      title,
      query: { query: 'items' },
      rows: 'items',
      key: 'id',
      item: { title: { path: 'title' } },
      actions: [keep],
    });
    expect(() =>
      parse([page({ body: [list('One'), list('Two')] })], { queries: ['items'], tools: ['demo.keep'] }),
    ).not.toThrow();
  });

  it('counts components, not the arrays and objects that hold them', () => {
    /*
     * The one-block attachment shape the email port writes: a list-detail
     * holding a repeat holding an expand holding a repeat holding a button
     * whose argument is a path. Five components deep, and every array, arg map
     * and `{ path }` between them is not nesting.
     */
    const attachment = {
      kind: 'list-detail',
      param: 'thread',
      list: {
        kind: 'list',
        query: { query: 'items' },
        rows: 'items',
        key: 'id',
        item: { title: { path: 'title' } },
      },
      detail: [
        {
          kind: 'repeat',
          query: { query: 'items' },
          rows: 'items',
          key: 'id',
          body: [
            {
              kind: 'expand',
              label: { path: 'from' },
              query: { query: 'items' },
              body: [
                {
                  kind: 'repeat',
                  query: { query: 'items' },
                  rows: 'items',
                  key: 'id',
                  body: [
                    {
                      kind: 'button',
                      when: { path: 'artifactId', equals: null },
                      action: { tool: 'demo.keep', label: 'Fetch', args: { id: { path: 'id' } } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => parse([page({ body: [attachment] })], { queries: ['items'], tools: ['demo.keep'] })).not.toThrow();
  });

  it('does not count a value that merely looks like a component', () => {
    /*
     * `when: { in: [{ kind: 'weird' }] }` is the owner's *data* — a row whose
     * field happens to hold an object with a `kind`. Counting it as nesting
     * made the ordinary page one level deeper than it is.
     */
    let body: unknown[] = [
      {
        kind: 'notice',
        text: 'The bottom.',
        when: { path: 'state', in: [{ kind: 'weird', body: [{ kind: 'weirder' }] }] },
      },
    ];
    for (let i = 0; i < 11; i += 1) body = [{ kind: 'section', body }];
    expect(() => parse([page({ body })])).not.toThrow();
  });

  it('refuses one that is deeper than a screen', () => {
    let body: unknown[] = [{ kind: 'notice', text: 'The bottom.' }];
    for (let i = 0; i < 12; i += 1) body = [{ kind: 'section', body }];
    expect(() => parse([page({ body })])).toThrow(/nests components deeper than 12/);
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

describe('a sensitive query', () => {
  const query = (over: Record<string, unknown>): unknown =>
    ({ name: 'q', params: z.object({}), produce: async () => ({}), ...over });

  it('keeps the flag, and leaves it off when unsaid', () => {
    const { queries } = parsePageContributions({ plugin: 'demo', queries: [query({ sensitive: true }) as never, query({ name: 'r' }) as never] });
    expect(queries.map((q) => [q.name, q.sensitive])).toEqual([['q', true], ['r', undefined]]);
  });

  it('refuses a flag that is not true or false', () => {
    expect(() => parsePageContributions({ plugin: 'demo', queries: [query({ sensitive: 'yes' }) as never] })).toThrow(
      /page query q declares `sensitive` that is not true or false/,
    );
  });
});

describe('the pool a query is handed', () => {
  /** A pool that never answers: the installation is busy, not broken. */
  const busy = { connect: () => new Promise<never>(() => {}) } as unknown as Pool;

  it('gives up waiting for a connection rather than hanging', async () => {
    const pool = readOnlyPool(busy, { acquireMs: 20 });
    await expect(pool.query('select 1')).rejects.toThrow(/could not get a database connection in time/);
  });

  it('releases a client whose rollback failed with the error, so the pool drops it', async () => {
    const released: unknown[] = [];
    const client = {
      query: (sql: string) => {
        if (sql === 'rollback') return Promise.reject(new Error('connection went away'));
        return Promise.resolve({ rows: [] });
      },
      release: (err?: unknown) => released.push(err),
    };
    const pool = readOnlyPool({ connect: async () => client } as unknown as Pool);
    await pool.query('select 1');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
    expect((released[0] as Error).message).toBe('connection went away');
  });

  it('releases the client plainly when the rollback worked', async () => {
    const released: unknown[] = [];
    const client = {
      query: async () => ({ rows: [] }),
      release: (err?: unknown) => released.push(err),
    };
    const pool = readOnlyPool({ connect: async () => client } as unknown as Pool);
    await pool.query('select 1');
    expect(released).toEqual([undefined]);
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
