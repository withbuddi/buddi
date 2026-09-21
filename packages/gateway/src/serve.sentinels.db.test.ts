/**
 * Who a finding is addressed to, end to end: a plugin asks for a *role*, the
 * gateway's tick answers from the roster, and the wake occurrence carries an
 * id that names an agent this installation can actually run — or no id at all.
 *
 * The finance plugin's watchers are written this way (`ctx.agentForRole
 * ('credit') ?? ctx.agentForRole('overview')`), so the sentinel below is a
 * stand-in for them. Against a throwaway database; skipped without one.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  migrate,
  runSentinels,
  SENTINEL_WAKE_MISSION_ID,
  upsertMission,
  type Finding,
  type PluginManifest,
  type Sentinel,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sentinelAgentForRole, type RoleRoster } from './serve.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_sentinels_test_${process.pid}`;

const T0 = new Date('2026-09-21T09:00:00Z');

/** An agent as the roster sees it: an id, and whether it can run. */
const agent = (id: string, ok = true): { id: string; availability: { ok: boolean } } => ({
  id,
  availability: { ok },
});

/** A roster stub: role → the agents claiming it, in declaration order. */
const roster = (roles: Record<string, { id: string; availability: { ok: boolean } }[]>): RoleRoster => ({
  agentsWithRole: (role) => roles[role] ?? [],
});

/** The finance pattern: credit first, whoever gives the overview after it. */
const creditWatcher: Sentinel = {
  id: 'test.credit',
  description: 'a watcher that addresses its finding by role',
  every: 60,
  async run(ctx): Promise<Finding[]> {
    const agentId = ctx.agentForRole('credit') ?? ctx.agentForRole('overview');
    return [
      {
        key: 'test.credit:2026-09-21',
        severity: 'urgent',
        title: 'The card balance is above the limit',
        detail: '2 400 EUR against a 2 000 EUR limit.',
        ...(agentId === undefined ? {} : { agentId }),
      },
    ];
  },
};

const manifests: PluginManifest[] = [
  {
    name: 'test',
    version: '0.0.0',
    schema: 'core',
    migrationsDir: '',
    tools: [],
    sentinels: [creditWatcher],
  },
];

suite('the sentinel tick resolves a finding‘s agent by role', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
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
    await pool.query(
      'truncate core.sentinel_findings, core.sentinel_runs, core.digest_items cascade',
    );
    await pool.query(
      'truncate core.occurrences, core.last_materialized, core.schedule_specs, core.missions cascade',
    );
    await pool.query('truncate core.events cascade');
    await upsertMission(pool, {
      id: SENTINEL_WAKE_MISSION_ID,
      name: 'Sentinel wake',
      agentId: 'buddi',
      prompt: 'Verify the finding.',
    });
  });

  /** The agentId the one wake occurrence carries. */
  const addressee = async (): Promise<string | null> => {
    const { rows } = await pool.query<{ payload: { finding: { agentId: string | null } } }>(
      `select payload from core.occurrences where mission_id = $1 order by scheduled_at`,
      [SENTINEL_WAKE_MISSION_ID],
    );
    expect(rows).toHaveLength(1);
    return (rows[0] as { payload: { finding: { agentId: string | null } } }).payload.finding.agentId;
  };

  it('names the advisor when it holds the role', async () => {
    const catalog = roster({ credit: [agent('finance-advisor')], overview: [agent('buddi')] });
    const [outcome] = await runSentinels(pool, manifests, T0, 'UTC', sentinelAgentForRole(catalog));

    expect(outcome?.error).toBeUndefined();
    expect(outcome?.fired).toBe(1);
    expect(await addressee()).toBe('finance-advisor');
  });

  it('names nobody when nobody holds it — the wake mission‘s agent speaks', async () => {
    const [outcome] = await runSentinels(pool, manifests, T0, 'UTC', sentinelAgentForRole(roster({})));

    expect(outcome?.error).toBeUndefined();
    expect(outcome?.fired).toBe(1);
    expect(await addressee()).toBeNull();
  });

  it('passes over an agent this installation cannot run', async () => {
    // First in roster order, held back for a missing plugin: naming it would
    // address the finding to somebody who cannot answer.
    const catalog = roster({
      credit: [agent('credit-coach', false), agent('finance-advisor')],
    });
    await runSentinels(pool, manifests, T0, 'UTC', sentinelAgentForRole(catalog));

    expect(await addressee()).toBe('finance-advisor');
  });

  it('is undefined when the only agent holding the role cannot run', async () => {
    const catalog = roster({ credit: [agent('credit-coach', false)] });
    await runSentinels(pool, manifests, T0, 'UTC', sentinelAgentForRole(catalog));

    expect(await addressee()).toBeNull();
  });
});
