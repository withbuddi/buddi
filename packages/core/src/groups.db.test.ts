/**
 * Editing a group against real Postgres: the id survives a rename, the
 * membership is replaced whole, and a member taken out of the room keeps every
 * turn it spoke there. The database is created by this suite, named after this
 * process, and dropped again — the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from './db.js';
import {
  archiveGroup,
  createGroup,
  createGroupConversation,
  getGroup,
  listGroups,
  readGroupTurns,
  updateGroup,
} from './groups.js';
import { urlForDatabase } from './backup/restore.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_group_edit_${process.pid}`;
const roster = [
  { id: 'concierge', roles: ['front-desk'] },
  { id: 'ledger', roles: [] },
  { id: 'garage', roles: [] },
];

suite('editing a group', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  it('renames without moving the id, and replaces the membership whole', async () => {
    const group = await createGroup(pool, { name: 'Test room', coordinator: 'concierge', members: ['ledger'] });
    const renamed = await updateGroup(pool, group.id, { name: 'Money' }, roster);
    expect(renamed?.id).toBe(group.id);
    expect(renamed?.name).toBe('Money');
    expect(renamed?.members).toEqual(['concierge', 'ledger']);

    const after = await updateGroup(
      pool,
      group.id,
      { coordinator: 'ledger', members: ['ledger', 'garage'] },
      roster,
    );
    expect(after?.coordinator).toBe('ledger');
    expect(after?.members).toEqual(['ledger', 'garage']);
    expect((await getGroup(pool, group.id))?.members).toEqual(['ledger', 'garage']);
  });

  it('keeps a removed member\'s turns in the room', async () => {
    const group = await createGroup(pool, { name: 'The move', coordinator: 'concierge', members: ['ledger', 'garage'] });
    const conversationId = await createGroupConversation(pool, group);
    await pool.query(
      `insert into core.messages (conversation_id, role, content, speaker) values ($1::uuid, 'assistant', $2::jsonb, 'garage')`,
      [conversationId, JSON.stringify([{ type: 'text', text: 'The van is booked.' }])],
    );
    await updateGroup(pool, group.id, { members: ['concierge', 'ledger'] }, roster);
    expect((await getGroup(pool, group.id))?.members).toEqual(['concierge', 'ledger']);
    const turns = await readGroupTurns(pool, conversationId);
    expect(turns.map((t) => t.speaker)).toEqual(['garage']);
  });

  it('answers null for a group that was archived, and archiving keeps the rows', async () => {
    const group = await createGroup(pool, { name: 'Tax season', coordinator: 'concierge', members: ['ledger'] });
    expect(await archiveGroup(pool, group.id)).toBe(true);
    expect(await updateGroup(pool, group.id, { name: 'Tax' }, roster)).toBeNull();
    expect((await listGroups(pool)).some((g) => g.id === group.id)).toBe(false);
    const { rows } = await pool.query('select id from core.groups where id = $1::uuid', [group.id]);
    expect(rows).toHaveLength(1);
  });
});
