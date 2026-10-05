/**
 * The edition origin's one query, against real Postgres: today's delivered
 * edition is found from core's own record (a `mission.report` with an
 * `?edition=` link, in a run with a `mission.delivered` event), and nothing
 * else is — not another report, not yesterday's edition.
 *
 * The database is created by this suite, named after this process, and
 * dropped again: the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { findEditionOrigin } from './edition-origin.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_edition_origin_${process.pid}`;
const NOW = new Date('2026-10-05T10:00:00.000Z');

function urlFor(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const EDITION = "Morning edition · Mon 5 Oct\n\nINTERNATIONAL\nSpain's parliament rejects two housing bills\nFrance 24 says lawmakers voted them down.\nFrance 24 and 2 more · https://www.france24.com/x";

suite('edition origin (db)', () => {
  let admin: Pool;
  let pool: Pool;

  async function delivered(agentId: string, at: Date, input: Record<string, unknown>): Promise<void> {
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ($1) returning id`, [agentId]);
    const id = rows[0].id as string;
    await pool.query(
      `insert into core.messages (conversation_id, role, content, created_at) values ($1, 'assistant', $2::jsonb, $3)`,
      [id, JSON.stringify([{ type: 'tool_use', id: 'tu_1', name: 'mission.report', input }]), at],
    );
    await pool.query(`insert into core.events (kind, conversation_id, payload, created_at) values ('mission.delivered', $1, '{}'::jsonb, $2)`, [id, at]);
  }

  beforeAll(async () => {
    admin = createPool(urlFor(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlFor(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  it("finds today's edition story and ignores other reports and yesterday's edition", async () => {
    const ctx: Pick<CoreToolContext, 'db' | 'now' | 'timezone'> = { db: pool, now: () => NOW, timezone: 'Europe/Paris' };
    const ask = "tell me more about spain's parliament rejects two housing bills";
    expect(await findEditionOrigin(ctx, ask)).toBeNull();

    await delivered('anchor', new Date('2026-10-04T05:00:00Z'), { urgency: 'normal', text: EDITION, link: '#/p/news/stories?edition=e_old' });
    await delivered('weatherman', new Date('2026-10-05T05:00:00Z'), { urgency: 'normal', text: EDITION, link: '#/p/weather/now' });
    expect(await findEditionOrigin(ctx, ask)).toBeNull();

    await delivered('anchor', new Date('2026-10-05T05:00:00Z'), { urgency: 'normal', text: EDITION, link: '#/p/news/stories?edition=e_new' });
    expect(await findEditionOrigin(ctx, ask)).toEqual({ headline: "Spain's parliament rejects two housing bills", agentId: 'anchor', plugin: 'news' });
  });
});
