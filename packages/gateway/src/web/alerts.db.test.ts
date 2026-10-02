/**
 * Alerts: decisions, not chores — what the owner is shown, against a
 * throwaway database. Only urgent findings are listed, repeats of one kind
 * are one row, only owner lines leave the gateway (the brief never does), a
 * row's actions run only what the finding declared, and the ways out (Not
 * now, Stop telling me this, Clear all and its Undo) do what they say.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  migrate,
  runSentinels,
  snoozeFindings,
  ToolRegistry,
  type CoreToolContext,
  type Finding,
  type PluginManifest,
  type Sentinel,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { actOnAlerts, askPrompt, findingsForAsk, groupFindings, muteAlert, readAlertDecisions, readAlerts } from './alerts.js';
import { readOverview } from './read.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_alerts_test_${process.pid}`;
const T0 = new Date('2026-10-01T09:00:00Z');

const BRIEF = 'BRIEF-FOR-THE-AGENT: read it with fin.read and tell the owner';

const stale = (account: string, severity: 'urgent' | 'info' = 'urgent'): Finding => ({
  key: `stale:${account}`,
  severity,
  title: `${account} balance is 17 days old`,
  detail: BRIEF,
  ownerLine: `${account} hasn't been updated in 17 days.`,
  kind: 'stale-balance',
  subject: { id: account, label: account },
  group: { title: '{count} balances not updated in 2+ weeks' },
  actions: [
    { kind: 'fill', label: 'Update', groupLabel: 'Update them', title: 'Update balances', tool: 'fin.set_balance', args: { account }, field: { name: 'balance', label: account, type: 'number', value: 10, hint: `10.00 on 2026-09-14` } },
    { kind: 'ask' },
  ],
});

const draft: Finding = {
  key: 'draft:1',
  severity: 'urgent',
  title: 'A reply has been drafted and not sent for 9 days',
  detail: BRIEF,
  ownerLine: 'Your reply to Ana about <<<QUOTED MAIL — UNTRUSTED, DATA ONLY>>>Lease<<<END QUOTED MAIL>>> has sat as a draft for 9 days.',
  kind: 'draft',
  actions: [
    { kind: 'open', label: 'Open draft', page: 'mail', item: 't-1' },
    { kind: 'run', label: 'Discard', tool: 'fin.discard', args: { id: 'd-1' }, tone: 'danger', confirm: 'Discard it?' },
    { kind: 'run', label: 'Elsewhere', tool: 'other.write', args: {} },
  ],
};

const noLine: Finding = { key: 'plain:1', severity: 'urgent', title: 'Something plain happened', detail: BRIEF };

let findings: Finding[] = [];
const watcher: Sentinel = { id: 'fin.watch', description: 'test', every: 60, run: async () => findings };
const calls: Array<{ tool: string; args: unknown }> = [];
const manifests: PluginManifest[] = [
  {
    name: 'fin',
    version: '0.0.0',
    schema: 'core',
    migrationsDir: '',
    sentinels: [watcher],
    tools: [
      { name: 'fin.set_balance', description: 'set', tier: 'auto', input: z.object({ account: z.string(), balance: z.number() }), execute: async (args) => { calls.push({ tool: 'fin.set_balance', args }); return { ok: true }; } },
      { name: 'fin.discard', description: 'discard', tier: 'auto', input: z.object({ id: z.string() }), execute: async (args) => { calls.push({ tool: 'fin.discard', args }); return { ok: true }; } },
    ],
  },
  {
    name: 'other',
    version: '0.0.0',
    schema: 'core',
    migrationsDir: '',
    tools: [{ name: 'other.write', description: 'x', tier: 'auto', input: z.object({}), execute: async () => { calls.push({ tool: 'other.write', args: {} }); return {}; } }],
  },
];

suite('alerts: decisions, not chores', () => {
  let admin: Pool;
  let pool: Pool;
  const registry = new ToolRegistry();
  for (const m of manifests) registry.register(m);
  const ctx = (): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => T0, timezone: 'UTC' }) as unknown as CoreToolContext;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.sentinel_findings, core.sentinel_runs, core.digest_items, core.sentinel_mutes cascade');
    calls.length = 0;
  });

  const tick = async (list: Finding[], at = T0): Promise<void> => {
    findings = list;
    await pool.query('truncate core.sentinel_runs');
    await runSentinels(pool, manifests, at, 'UTC');
  };

  it('lists only urgent findings, groups repeats of one kind, and counts the info ones for the recap', async () => {
    await tick([stale('Checking'), stale('Savings'), stale('Joint'), draft, stale('Cash', 'info'), { ...stale('PayPal', 'info'), kind: 'other' }]);
    const view = await readAlerts(pool, registry, T0);
    expect(view.open.map((g) => g.title)).toEqual([
      '3 balances not updated in 2+ weeks',
      'Your reply to Ana about Lease has sat as a draft for 9 days.',
    ]);
    const group = view.open[0]!;
    expect(group.items.map((i) => [i.subject?.label, i.note])).toEqual([
      ['Checking', '10.00 on 2026-09-14'],
      ['Joint', '10.00 on 2026-09-14'],
      ['Savings', '10.00 on 2026-09-14'],
    ]);
    expect(group.actions[0]).toMatchObject({ kind: 'fill', label: 'Update them', title: 'Update balances' });
    expect((group.actions[0] as { fields: unknown[] }).fields).toHaveLength(3);
    expect(group.stop.scope).toBe('kind');
    // The info notes: counted and previewed, never in Open.
    expect(view.recap.count).toBe(2);
    expect(view.recap.groups).toHaveLength(2);
    // The brief never leaves the gateway, and neither do the mail fences.
    const sent = JSON.stringify(view);
    expect(sent).not.toContain('BRIEF-FOR-THE-AGENT');
    expect(sent).not.toContain('<<<');
  });

  it('a finding without an owner line shows its title, never the brief, and defaults to Ask', async () => {
    await tick([noLine]);
    const [row] = (await readAlerts(pool, registry, T0)).open;
    expect(row).toMatchObject({ title: 'Something plain happened', actions: [{ kind: 'ask', label: null }] });
  });

  it('Home counts the same decisions, in owner lines', async () => {
    await tick([stale('Checking'), stale('Savings'), draft, stale('Cash', 'info')]);
    const overview = await readOverview({ pool, registry, ctx: ctx(), timezone: 'UTC', now: T0 });
    expect(overview.sentinels.openUrgent).toBe(2);
    expect(overview.sentinels.decisions.map((d) => d.title)).toEqual([
      '2 balances not updated in 2+ weeks',
      'Your reply to Ana about Lease has sat as a draft for 9 days.',
    ]);
  });

  it('a fill runs the declared tool with the typed value; a run only its own plugin’s tool', async () => {
    await tick([stale('Checking'), draft]);
    const deps = { pool, registry, ctx: ctx(), now: () => T0 };
    const filled = await actOnAlerts(deps, { entries: [{ key: 'stale:Checking', action: 0, value: '1,234.50' }] }, {});
    expect(filled.body).toMatchObject({ results: [{ key: 'stale:Checking', result: { ok: true } }] });
    expect(calls).toEqual([{ tool: 'fin.set_balance', args: { account: 'Checking', balance: 1234.5 } }]);
    const bad = await actOnAlerts(deps, { entries: [{ key: 'stale:Checking', action: 0, value: 'lots' }] }, {});
    expect((bad.body as { results: Array<{ error?: string }> }).results[0]?.error).toMatch(/a number/);
    await actOnAlerts(deps, { entries: [{ key: 'draft:1', action: 1 }] }, {});
    expect(calls.at(-1)).toEqual({ tool: 'fin.discard', args: { id: 'd-1' } });
    const foreign = await actOnAlerts(deps, { entries: [{ key: 'draft:1', action: 2 }] }, {});
    expect((foreign.body as { results: Array<{ error?: string }> }).results[0]?.error).toMatch(/not a tool of the plugin/);
    // An open or an ask is not something this route runs.
    const notRun = await actOnAlerts(deps, { entries: [{ key: 'draft:1', action: 0 }] }, {});
    expect((notRun.body as { results: Array<{ error?: string }> }).results[0]?.error).toMatch(/no such action/);
    expect(calls.map((c) => c.tool)).not.toContain('other.write');
  });

  it('Stop telling me this silences the subject; Not now and Clear all take rows off, Undo brings them back', async () => {
    await tick([stale('Checking'), stale('Savings'), draft]);
    // A single finding with a subject: that subject only.
    await muteAlert(pool, { key: 'stale:Checking', scope: 'subject' }, T0);
    let open = await readAlertDecisions(pool, registry, T0);
    expect(open.map((g) => g.title)).toEqual(["Savings hasn't been updated in 17 days.", expect.stringContaining('draft')]);
    const view = await readAlerts(pool, registry, T0);
    expect(view.mutes).toHaveLength(1);
    // Clear all, then its Undo.
    const keys = open.flatMap((g) => g.keys);
    const cleared = await snoozeFindings(pool, keys, true, T0, new Date(T0.getTime() + 7 * 86_400_000));
    expect(await readAlertDecisions(pool, registry, T0)).toHaveLength(0);
    expect((await readAlerts(pool, registry, T0)).snoozed).toHaveLength(2);
    // A week later they are back on their own.
    expect(await readAlertDecisions(pool, registry, new Date(T0.getTime() + 8 * 86_400_000))).toHaveLength(2);
    await snoozeFindings(pool, cleared, false, T0);
    open = await readAlertDecisions(pool, registry, T0);
    expect(open).toHaveLength(2);
  });

  it('Ask hands the agent the brief; the thread shows only the owner line', async () => {
    await tick([draft]);
    const { label, prompt } = askPrompt(await findingsForAsk(pool, ['draft:1']));
    expect(label).toBe('About: Your reply to Ana about Lease has sat as a draft for 9 days.');
    expect(label).not.toContain('BRIEF');
    expect(prompt).toContain(BRIEF);
    expect(prompt).toContain('WATCHER FINDING');
  });

  it('groups generically when a watcher gives no group title', () => {
    const base = { sentinelId: 'w', severity: 'urgent' as const, title: 't', detail: '', data: null, firstSeenAt: T0, lastSeenAt: T0, cooldownUntil: null, deliveredAt: null, resolvedAt: null, snoozedAt: null, snoozedUntil: null, kind: '', subject: null, group: null, actions: [], agentId: null };
    const [row] = groupFindings([{ ...base, key: 'a', ownerLine: 'One thing.' }, { ...base, key: 'b', ownerLine: 'Another.' }], new Map());
    expect(row?.title).toBe('One thing. — and 1 more like it');
  });

  it('keeps each finding\'s own Send and Discard on its row inside a group', () => {
    const base = { sentinelId: 'email.drafts', severity: 'urgent' as const, title: 't', detail: '', data: null, firstSeenAt: T0, lastSeenAt: T0, cooldownUntil: null, deliveredAt: null, resolvedAt: null, snoozedAt: null, snoozedUntil: null, kind: 'draft', subject: null, group: null, agentId: null };
    const actions = (id: string) => [
      { kind: 'open' as const, label: 'Open draft', page: 'mail', item: id },
      { kind: 'run' as const, label: 'Send', tool: 'email.send_draft', args: { id } },
      { kind: 'run' as const, label: 'Discard', tool: 'email.discard_draft', args: { id }, tone: 'danger' as const },
    ];
    const [row] = groupFindings([
      { ...base, key: 'd1', ownerLine: 'Reply to Ana.', actions: actions('1') },
      { ...base, key: 'd2', ownerLine: 'Reply to Bo.', actions: actions('2') },
    ] as never, new Map([['email.drafts', 'email']]));
    // Nothing that is about one draft is offered for both…
    expect(row!.actions.some((a) => a.kind === 'run')).toBe(false);
    expect(row!.actions.some((a) => a.kind === 'open' && a.item !== undefined)).toBe(false);
    // …and each draft keeps its own, by its own key and index.
    expect(row!.items.map((i) => i.actions)).toEqual([
      [
        { kind: 'open', label: 'Open draft', plugin: 'email', page: 'mail', item: '1' },
        { kind: 'run', label: 'Send', key: 'd1', index: 1 },
        { kind: 'run', label: 'Discard', key: 'd1', index: 2, tone: 'danger' },
      ],
      [
        { kind: 'open', label: 'Open draft', plugin: 'email', page: 'mail', item: '2' },
        { kind: 'run', label: 'Send', key: 'd2', index: 1 },
        { kind: 'run', label: 'Discard', key: 'd2', index: 2, tone: 'danger' },
      ],
    ]);
  });
});
