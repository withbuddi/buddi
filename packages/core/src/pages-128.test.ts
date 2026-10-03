/**
 * Host API 1.28's additions to the page grammar, at load: a row's choice, a
 * group head's actions, a list row's swatch, a menu (and the drawer it opens
 * by id), a polled repeat's `finish`, and `where`. A descriptor that misuses
 * one fails naming the field; every tool any of them names is one the act
 * route will run.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parsePageContributions } from './pages.js';

const TOOLS = ['calendar.set_access', 'calendar.google_sign_in', 'calendar.google_finish', 'calendar.remove_account', 'calendar.add'];
const queries = ['settings', 'sign_in'].map((name) => ({ name, params: z.object({}), produce: async () => ({}) }));
const parse = (body: unknown[], actions?: unknown[]) =>
  parsePageContributions({ plugin: 'calendar', pages: [{ id: 'settings', title: 'Calendar', place: 'settings', body, ...(actions ? { actions } : {}) }], queries, tools: TOOLS });

const choice = {
  tool: 'calendar.set_access',
  label: 'What agents may do with {name}',
  value: 'access',
  options: [
    { value: 'off', label: 'Not linked', when: { path: 'link', equals: false } },
    { value: 'read', label: 'Read' },
    { value: 'change', label: 'Read and change', disabledWhen: { path: 'readOnly', equals: true }, hint: 'Read-only in Google' },
  ],
  args: { id: { row: 'id' }, access: { choice: true } },
};
const list = (item: Record<string, unknown> = {}, groupBy: Record<string, unknown> = {}) => ({
  kind: 'list',
  query: { query: 'settings' },
  rows: 'calendars',
  key: 'id',
  item: { title: { path: 'name' }, swatch: 'color', choice, ...item },
  groupBy: {
    key: 'group',
    label: 'groupLabel',
    aside: 'groupAside',
    asideTone: 'groupTone',
    actions: [
      { tool: 'calendar.google_sign_in', label: 'Sign in again', tone: 'accent', when: { path: 'expired', equals: true }, args: { account: { row: 'account' } } },
      { tool: 'calendar.remove_account', label: 'Remove account…', tone: 'danger', menu: true, confirm: 'Remove {groupLabel}?', args: { id: { row: 'account' } } },
    ],
    ...groupBy,
  },
});
const drawer = (over: Record<string, unknown> = {}) => ({
  kind: 'form',
  drawer: { title: 'Paste a private link', id: 'paste' },
  fields: [{ name: 'link', label: 'Private link', type: 'secret', required: true }],
  submit: { tool: 'calendar.add', label: 'Add the calendar', args: { link: { field: 'link' } } },
  ...over,
});
const menu = (items: unknown[] = [{ label: 'Paste a private link', open: 'paste' }]) => ({ kind: 'menu', label: 'Add a calendar', tone: 'accent', items });
const card = {
  kind: 'repeat',
  query: { query: 'sign_in' },
  rows: 'rows',
  key: 'id',
  poll: {
    seconds: 2,
    while: { path: 'waiting', equals: true },
    finish: { when: { path: 'state', equals: 'received' }, action: { tool: 'calendar.google_finish', label: 'Finish signing in', busy: 'Reading your calendars…', args: { id: { row: 'id' } } } },
  },
  body: [{ kind: 'notice', text: 'Paste it.', where: 'remote' }],
};

describe('host API 1.28 in a descriptor', () => {
  it('loads Settings → Calendar’s shape, and every tool it names is one a page may run', () => {
    const parsed = parse([
      card,
      { kind: 'section', title: 'Calendars', actions: [menu([{ label: 'Sign in with Google', hint: 'Google', action: { tool: 'calendar.google_sign_in', label: 'Sign in with Google', args: {} } }, { label: 'Paste a private link', open: 'paste' }])], body: [list(), drawer()] },
    ]);
    expect(parsed.tools.sort()).toEqual([...TOOLS].sort());
  });

  it('takes a menu in a rail page’s head, and counts its tools', () => {
    const parsed = parsePageContributions({
      plugin: 'calendar',
      pages: [{ id: 'agenda', title: 'Agenda', place: 'rail', actions: [menu([{ label: 'Sign in', action: { tool: 'calendar.google_sign_in', label: 'Sign in', args: {} } }])], body: [{ kind: 'notice', text: 'Hi.' }] }],
      queries,
      tools: TOOLS,
    });
    expect(parsed.tools).toEqual(['calendar.google_sign_in']);
  });

  it('refuses a choice that does not send what was picked', () => {
    expect(() => parse([list({ choice: { ...choice, args: { id: { row: 'id' } } } })])).toThrow(/\{ choice: true \}/);
  });

  it('refuses a choice of one option, or two options with one value', () => {
    expect(() => parse([list({ choice: { ...choice, options: [{ value: 'read', label: 'Read' }] } })])).toThrow(/choice/);
    expect(() => parse([list({ choice: { ...choice, options: [{ value: 'read', label: 'Read' }, { value: 'read', label: 'Again' }] } })])).toThrow(
      /its own value/,
    );
  });

  it('refuses a choice that asks first: a pick is not a press', () => {
    expect(() => parse([list({ choice: { ...choice, confirm: 'Sure?' } })])).toThrow(/confirm/);
  });

  it('refuses a menu item that both runs a tool and opens a drawer, or does neither', () => {
    expect(() => parse([menu([{ label: 'Both', open: 'paste', action: { tool: 'calendar.add', label: 'Add', args: {} } }]), drawer()])).toThrow(/one of the two/);
    expect(() => parse([menu([{ label: 'Neither' }]), drawer()])).toThrow(/one of the two/);
  });

  it('refuses a menu item that opens a drawer the page does not have', () => {
    expect(() => parse([menu([{ label: 'Paste a private link', open: 'pasted' }]), drawer()])).toThrow(/opens pasted, which is no drawer on this page — it has paste/);
  });

  it('refuses two drawers by one id, and a drawer with neither a button nor an id', () => {
    expect(() => parse([drawer(), drawer()])).toThrow(/two drawers are called paste/);
    expect(() => parse([drawer({ drawer: { title: 'Paste a private link' } })])).toThrow(/its own `button`, or from a menu by its `id`/);
  });

  it('refuses `where` other than local or remote, and a finish with no row to read', () => {
    expect(() => parse([{ kind: 'notice', text: 'Hi.', where: 'tailnet' }])).toThrow(/where/);
    const finishing = { ...card, poll: { ...card.poll, finish: { when: card.poll.finish.when, action: { ...card.poll.finish.action, args: { id: { field: 'id' } } } } } };
    expect(() => parse([finishing])).toThrow(/finish/);
  });

  it('refuses a group action’s tool the plugin does not contribute', () => {
    expect(() =>
      parse([list({}, { actions: [{ tool: 'calendar.sign_out', label: 'Sign out', args: { id: { row: 'account' } } }] })]),
    ).toThrow(/names calendar\.sign_out, which this plugin does not contribute/);
  });
});
