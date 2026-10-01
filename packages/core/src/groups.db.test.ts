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
  GROUP_UNDO_MS,
  archiveGroup,
  appendRoomNote,
  clearGroupHistory,
  createGroup,
  deleteGroup,
  groupHistorySize,
  purgeDeletedGroups,
  restoreGroup,
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

  it('deletes softly: gone from every read at once, back as it was on undo', async () => {
    const group = await createGroup(pool, { name: 'Soft', coordinator: 'concierge', members: ['ledger'] });
    const at = new Date('2026-10-01T12:00:00Z');
    expect(await deleteGroup(pool, group.id, at)).toBe(true);
    expect(await getGroup(pool, group.id)).toBeNull();
    expect((await listGroups(pool)).some((g) => g.id === group.id)).toBe(false);
    // A second delete has nothing to delete.
    expect(await deleteGroup(pool, group.id, at)).toBe(false);
    const back = await restoreGroup(pool, group.id, new Date(at.getTime() + 5_000));
    expect(back).toMatchObject({ id: group.id, name: 'Soft', coordinator: 'concierge', members: ['concierge', 'ledger'] });
    expect(await getGroup(pool, group.id)).not.toBeNull();
  });

  it('is too late to undo once the window has passed, and the purge then removes the group and its history', async () => {
    const group = await createGroup(pool, { name: 'Hard', coordinator: 'concierge', members: ['ledger'] });
    const conversation = await createGroupConversation(pool, group);
    await appendRoomNote(pool, conversation, 'Ledger has finished.');
    const at = new Date('2026-10-01T12:00:00Z');
    await deleteGroup(pool, group.id, at);
    const later = new Date(at.getTime() + GROUP_UNDO_MS + 1);
    // Inside the window the purge leaves it alone.
    expect(await purgeDeletedGroups(pool, new Date(at.getTime() + 1_000))).not.toContain(group.id);
    expect(await restoreGroup(pool, group.id, later)).toBeNull();
    expect(await purgeDeletedGroups(pool, later)).toContain(group.id);
    expect((await pool.query('select 1 from core.groups where id = $1::uuid', [group.id])).rows).toHaveLength(0);
    expect((await pool.query('select 1 from core.group_members where group_id = $1::uuid', [group.id])).rows).toHaveLength(0);
    expect((await pool.query('select 1 from core.conversations where id = $1::uuid', [conversation])).rows).toHaveLength(0);
    expect((await pool.query('select 1 from core.messages where conversation_id = $1::uuid', [conversation])).rows).toHaveLength(0);
  });

  it('clears the history and keeps the group, its members and its id', async () => {
    const group = await createGroup(pool, { name: 'Clear me', coordinator: 'concierge', members: ['ledger'] });
    const one = await createGroupConversation(pool, group);
    await createGroupConversation(pool, group);
    await appendRoomNote(pool, one, 'Ledger has finished.');
    await pool.query('update core.groups set last_summary = $2 where id = $1::uuid', [group.id, 'Where we stopped.']);
    expect(await groupHistorySize(pool, group.id)).toEqual({ conversations: 2, messages: 1 });
    expect(await clearGroupHistory(pool, group.id)).toBe(2);
    expect(await groupHistorySize(pool, group.id)).toEqual({ conversations: 0, messages: 0 });
    expect(await getGroup(pool, group.id)).toMatchObject({ id: group.id, name: 'Clear me', members: ['concierge', 'ledger'], lastSummary: null });
  });
});
