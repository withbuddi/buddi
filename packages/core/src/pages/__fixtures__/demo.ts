/**
 * The synthetic plugin the page engine is tested against.
 *
 * `docs/specs/plugin-pages.md` §7 step 1: the proof that the engine is generic
 * is a plugin that is not email using every component once. It ships two pages
 * — a rail place and a settings tab — a query per read and a tool per write,
 * and nothing behind them but constants, so the same fixture serves core's
 * validation tests, the gateway's route tests and (as a shape) the dashboard's
 * page tests.
 *
 * It lives in the package rather than in a test file because three suites in
 * two packages need the same descriptor, and a second copy is a second thing
 * to keep in step. It is exported from `@buddi/core/testing/pages`; nothing in
 * a running installation imports it.
 */
import { z } from 'zod';
import type { PluginManifest, ToolContext } from '../../tools.js';
import type { PageDescriptor, PageQuery } from '../../pages.js';

/** What the demo plugin's queries answer with. Constants, deliberately. */
export const DEMO_DATA = {
  counts: { items: 3, open: 1 },
  items: {
    items: [
      { id: 'a1', title: 'The first thing', sub: 'one@example.com', state: 'open', pinned: false },
      { id: 'a2', title: 'The second thing', sub: 'two@example.com', state: 'done', pinned: true },
    ],
    older: [{ id: 'a0', title: 'An older thing', sub: 'zero@example.com', state: 'done', pinned: false }],
  },
  item: {
    id: 'a1',
    title: 'The first thing',
    state: 'open',
    at: '2026-09-22T09:00:00.000Z',
    approvalId: null as string | null,
  },
  body: { text: 'The body of the first thing.', attachmentId: 'artifact-1' },
  draft: { id: 'd1', subject: 'A reply', body: 'Nearly done.', updatedAt: '2026-09-22T09:05:00.000Z' },
  accounts: { accounts: [{ id: 'acc-1', address: 'owner@example.com', state: 'ready' }] },
  settings: { everyMinutes: 15, keepDays: 30 },
} as const;

const ID = z.object({ id: z.string().min(1) }).strict();

export const demoQueries: PageQuery[] = [
  { name: 'counts', params: z.object({}).strict(), produce: async () => DEMO_DATA.counts },
  {
    name: 'items',
    params: z.object({ state: z.string().optional() }).strict(),
    produce: async (params) => {
      const { state } = params as { state?: string };
      if (!state) return DEMO_DATA.items;
      return { items: DEMO_DATA.items.items.filter((i) => i.state === state), older: [] };
    },
  },
  {
    name: 'search',
    params: z.object({ q: z.string().min(1) }).strict(),
    produce: async (params) => {
      const { q } = params as { q: string };
      return { items: DEMO_DATA.items.items.filter((i) => i.title.includes(q)) };
    },
  },
  { name: 'item', params: ID, produce: async () => DEMO_DATA.item },
  { name: 'body', params: ID, produce: async () => DEMO_DATA.body },
  { name: 'draft', params: ID, produce: async () => DEMO_DATA.draft },
  { name: 'accounts', params: z.object({}).strict(), produce: async () => DEMO_DATA.accounts },
  {
    name: 'settings',
    params: z.object({}).strict(),
    produce: async () => DEMO_DATA.settings,
    result: z.object({ everyMinutes: z.number(), keepDays: z.number() }).strict(),
  },
  /**
   * A query that actually reads the database, so a suite can prove the pool a
   * query is handed is the real one and answers.
   */
  {
    name: 'probe',
    params: z.object({}).strict(),
    produce: async (_params, ctx: ToolContext) => {
      const rows = await ctx.db.query<{ n: number }>('select 1 as n');
      return { n: rows.rows[0]?.n ?? 0 };
    },
  },
  /**
   * A query that tries to write. It is never referenced by a page: it exists
   * so a suite can prove that a plugin which tried this gets a refusal rather
   * than a write nobody approved.
   */
  {
    name: 'naughty',
    params: z.object({}).strict(),
    produce: async (_params, ctx: ToolContext) => {
      await ctx.db.query('update core.system_flags set value = \'true\'::jsonb where key = $1', ['paused']);
      return { wrote: true };
    },
  },
];

/** What each write did, for the suites to read back. */
export const demoWrites: Array<{ tool: string; args: unknown }> = [];

const demoTools: PluginManifest['tools'] = [
  {
    name: 'demo.keep',
    description: 'Keep one thing.',
    tier: 'auto',
    input: z.object({ id: z.string() }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.keep', args });
      return { kept: (args as { id: string }).id };
    },
  },
  {
    name: 'demo.keep_many',
    description: 'Keep several things at once.',
    tier: 'auto',
    input: z.object({ ids: z.array(z.string()).min(1) }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.keep_many', args });
      return { kept: (args as { ids: string[] }).ids.length };
    },
  },
  {
    name: 'demo.save',
    description: 'Save the draft.',
    tier: 'auto',
    input: z.object({ id: z.string(), subject: z.string(), body: z.string(), version: z.string() }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.save', args });
      return { saved: true };
    },
  },
  {
    name: 'demo.discard',
    description: 'Discard the draft.',
    tier: 'auto',
    input: z.object({ id: z.string() }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.discard', args });
      return { discarded: true };
    },
  },
  {
    // Gated: the page draws the approval card in place, choices and all.
    name: 'demo.send',
    description: 'Send the draft.',
    tier: 'gated',
    input: z.object({ id: z.string() }).strict(),
    describe: (args) => ({
      envelope: { id: (args as { id: string }).id },
      preview: `Send draft ${(args as { id: string }).id}`,
      choices: [{ key: 'as', label: 'Send as', options: ['owner@example.com'], default: 'owner@example.com' }],
    }),
    async execute(args) {
      demoWrites.push({ tool: 'demo.send', args });
      return { sent: true };
    },
  },
  {
    // The first of its kind: it stores a secret, so no model ever sees it.
    name: 'demo.add_account',
    description: 'Add an account, with its password.',
    tier: 'auto',
    ownerOnly: true,
    input: z.object({ address: z.string(), password: z.string() }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.add_account', args: { address: (args as { address: string }).address } });
      return { added: true };
    },
  },
  {
    name: 'demo.remove_account',
    description: 'Remove an account.',
    tier: 'auto',
    ownerOnly: true,
    input: z.object({ id: z.string() }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.remove_account', args });
      return { removed: true };
    },
  },
  {
    name: 'demo.set_settings',
    description: 'Write the watcher settings.',
    tier: 'auto',
    input: z.object({ everyMinutes: z.number(), keepDays: z.number() }).strict(),
    async execute(args) {
      demoWrites.push({ tool: 'demo.set_settings', args });
      return { saved: true };
    },
  },
];

/** The rail page: search, a list with a URL per item, and one item's detail. */
const board: PageDescriptor = {
  id: 'board',
  title: 'Demo board',
  place: 'rail',
  icon: 'chart',
  order: 10,
  body: [
    { kind: 'notice', text: 'Everything the demo plugin knows, drawn from descriptors.' },
    {
      kind: 'stats',
      title: 'Where things stand',
      query: { query: 'counts' },
      items: [
        { label: 'Things', value: { path: 'items' }, unit: 'number' },
        { label: 'Open', value: { path: 'open' }, unit: 'number', tone: 'warning' },
      ],
    },
    {
      kind: 'search',
      title: 'Find a thing',
      fields: [{ name: 'q', label: 'Words', type: 'text', required: true }],
      query: { query: 'search', params: { q: { param: 'q' } } },
      results: { title: { path: 'title' }, sub: { path: 'sub' }, to: { page: 'board', item: { path: 'id' } } },
      empty: 'Nothing matches those words.',
    },
    {
      kind: 'list-detail',
      param: 'item',
      list: {
        kind: 'list',
        title: 'Things',
        query: { query: 'items' },
        rows: 'items',
        item: {
          title: { path: 'title' },
          sub: { path: 'sub' },
          meta: [{ path: 'state' }],
          pill: { value: { path: 'state' } },
          to: { page: 'board', item: { path: 'id' } },
        },
        select: { key: 'id', disabledWhen: { path: 'pinned', equals: true } },
        actions: [{ tool: 'demo.keep', label: 'Keep', args: { id: { row: 'id' } } }],
        bulk: [{ tool: 'demo.keep_many', label: 'Keep selected', args: { ids: { selected: true } } }],
        groupBy: { key: 'state', labels: { open: 'Open', done: 'Done' } },
        collapsed: { label: 'Older things', rows: 'older' },
        empty: 'Nothing here yet.',
      },
      detail: [
        {
          kind: 'detail',
          title: 'The thing',
          query: { query: 'item', params: { id: { param: 'item' } } },
          fields: [
            { label: 'State', value: { path: 'state' } },
            { label: 'Seen', value: { path: 'at' }, unit: 'date' },
          ],
          body: [
            { kind: 'approval', path: 'approvalId', when: { path: 'state', equals: 'open' } },
            {
              kind: 'expand',
              label: 'Show the body',
              query: { query: 'body', params: { id: { param: 'item' } } },
              body: [
                { kind: 'notice', text: 'Fetched when you opened it.' },
                { kind: 'artifact', path: 'attachmentId', label: 'Download the attachment' },
              ],
            },
          ],
        },
        {
          kind: 'editor',
          title: 'The draft',
          query: { query: 'draft', params: { id: { param: 'item' } } },
          version: 'updatedAt',
          fields: [
            { name: 'subject', label: 'Subject', type: 'text', from: 'subject', required: true },
            { name: 'body', label: 'Body', type: 'textarea', from: 'body' },
          ],
          save: {
            tool: 'demo.save',
            label: 'Save',
            tone: 'accent',
            args: {
              id: { param: 'item' },
              subject: { field: 'subject' },
              body: { field: 'body' },
              version: { field: 'version' },
            },
          },
          actions: [
            {
              tool: 'demo.discard',
              label: 'Discard',
              tone: 'danger',
              confirm: 'Discard this draft?',
              args: { id: { param: 'item' } },
            },
            { tool: 'demo.send', label: 'Send', args: { id: { param: 'item' } }, then: 'refresh' },
          ],
        },
      ],
    },
    { kind: 'link', label: 'Accounts and rules', to: { page: 'settings' } },
  ],
};

/** The settings tab: the accounts table, the drawer that adds one, the numbers. */
const settings: PageDescriptor = {
  id: 'settings',
  title: 'Demo',
  place: 'settings',
  body: [
    {
      kind: 'section',
      title: 'Accounts',
      note: 'What this installation reads.',
      body: [
        {
          kind: 'table',
          query: { query: 'accounts' },
          rows: 'accounts',
          columns: [
            { key: 'address', label: 'Address' },
            { key: 'state', label: 'State' },
          ],
          actions: [
            {
              tool: 'demo.remove_account',
              label: 'Remove',
              tone: 'danger',
              confirm: 'Remove this account?',
              args: { id: { row: 'id' } },
            },
          ],
          empty: 'No accounts yet.',
        },
        {
          kind: 'form',
          drawer: { title: 'Add an account', button: 'Add an account' },
          fields: [
            { name: 'address', label: 'Address', type: 'email', required: true },
            { name: 'password', label: 'Password', type: 'secret', required: true, hint: 'Kept in the vault.' },
          ],
          submit: {
            tool: 'demo.add_account',
            label: 'Add',
            tone: 'accent',
            args: { address: { field: 'address' }, password: { field: 'password' } },
            then: 'close',
          },
        },
      ],
    },
    {
      kind: 'form',
      title: 'Watchers',
      initial: { query: 'settings' },
      fields: [
        { name: 'everyMinutes', label: 'Check every', type: 'number', from: 'everyMinutes', min: 1, max: 240 },
        { name: 'keepDays', label: 'Keep for', type: 'number', from: 'keepDays', min: 1, max: 365 },
      ],
      submit: {
        tool: 'demo.set_settings',
        label: 'Save',
        tone: 'accent',
        args: { everyMinutes: { field: 'everyMinutes' }, keepDays: { field: 'keepDays' } },
      },
    },
  ],
};

export const demoPages: PageDescriptor[] = [board, settings];

/** The whole plugin, ready to `register()`. */
export const demoPagesManifest: PluginManifest = {
  name: 'demo',
  version: '1.0.0',
  schema: 'demo',
  migrationsDir: '',
  tools: demoTools,
  pages: demoPages,
  queries: demoQueries,
};
