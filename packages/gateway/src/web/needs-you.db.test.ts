/**
 * The Needs you count past a page of approvals. Skipped unless DATABASE_URL
 * is set; a throwaway database of its own.
 */
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, ToolRegistry, createAction, createPool, migrate } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readNeedsYou } from './needs-you.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_needs_you_${process.pid}`;

suite('needs you (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${DB}`);
      await admin.end();
    }
  });

  it('counts every pending approval, and an agent accept past the first fifty still covers its offer', async () => {
    for (let i = 0; i < 55; i += 1) {
      await createAction(pool, {
        tool: 'mail.send',
        toolVersion: '1.0.0',
        agentId: 'postman',
        canonicalArgs: { to: `a${i}@b.c` },
        envelope: { to: [`a${i}@b.c`] },
        preview: `Send to a${i}@b.c`,
      });
    }
    await createAction(pool, {
      tool: 'platform.accept_plugin_agent',
      toolVersion: '1.0.0',
      agentId: 'buddi',
      canonicalArgs: { plugin: 'finance', agent: 'ledger' },
      envelope: {},
      preview: 'Set up Ledger',
    });
    const needs = await readNeedsYou({
      pool,
      registry: new ToolRegistry(),
      now: new Date(),
      agentOffers: async () => [
        { plugin: 'finance', agent: 'ledger' },
        { plugin: 'weather', agent: 'tempo' },
      ],
    });
    expect(needs.approvals).toBe(56);
    expect(needs.agentsToSetUp).toBe(1);
    expect(needs.total).toBe(57);
  });
});
