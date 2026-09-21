/**
 * The queue the owner's mid-run words wait in, against real Postgres.
 *
 * Three properties, and each one is a bug that was in the first cut of this
 * feature: a lease is not a delivery (a run that never reaches the model must
 * hand the words back), a promotion is one transaction (one canonical turn or
 * none at all), and the time the owner said something is never rewritten —
 * the canonical row gets a time of its own, and `received_at` stays the
 * record of when it arrived.
 *
 * The database is created by this suite, named after this process, and
 * dropped again: the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from './db.js';
import {
  conversationsWithPendingInput,
  leasePendingInput,
  markDelivered,
  promotePendingInput,
  queuePendingInput,
  releaseLease,
  waitingPendingInput,
} from './pending-input.js';
import { urlForDatabase } from './backup/restore.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_pending_input_${process.pid}`;

suite('what the owner said while the agent was working', () => {
  let admin: Pool;
  let pool: Pool;

  const conversation = async (): Promise<string> => {
    const { rows } = await pool.query(
      `insert into core.conversations (agent_id) values ('ledger') returning id`,
    );
    return String(rows[0].id);
  };

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

  afterEach(async () => {
    await pool.query('truncate core.pending_input, core.messages, core.conversations cascade');
  });

  it('leases in the order it was said, and a lease is not a delivery', async () => {
    const id = await conversation();
    await queuePendingInput(pool, { conversationId: id, runId: null, text: 'wait', now: new Date('2026-01-01T10:00:00Z') });
    await queuePendingInput(pool, { conversationId: id, runId: null, text: 'in euros', now: new Date('2026-01-01T10:00:05Z') });

    const leased = await leasePendingInput(pool, id, null);
    expect(leased.map((row) => row.text)).toEqual(['wait', 'in euros']);
    // Leased is still waiting: nobody has been shown it.
    expect((await waitingPendingInput(pool, id)).map((row) => row.state)).toEqual(['leased', 'leased']);
    // And a second lease takes nothing: it is not a queue you can drain twice.
    expect(await leasePendingInput(pool, id, null)).toHaveLength(0);

    // The step never happened, so they are waiting again, in their own order.
    await releaseLease(pool, leased.map((row) => row.id));
    expect((await waitingPendingInput(pool, id)).map((row) => [row.state, row.text])).toEqual([
      ['pending', 'wait'],
      ['pending', 'in euros'],
    ]);

    // Shown to the model at last, and pointed at the turn that carries them.
    const again = await leasePendingInput(pool, id, null);
    const { rows } = await pool.query(
      `insert into core.messages (conversation_id, role, content) values ($1::uuid, 'user', '[]'::jsonb) returning id`,
      [id],
    );
    await markDelivered(pool, again.map((row) => row.id), String(rows[0].id));
    expect(await waitingPendingInput(pool, id)).toHaveLength(0);
    const { rows: after } = await pool.query(
      `select state, delivered_at, message_id from core.pending_input where conversation_id = $1::uuid`,
      [id],
    );
    expect(after.every((r: any) => r.state === 'delivered' && r.delivered_at !== null)).toBe(true);
    expect(new Set(after.map((r: any) => String(r.message_id))).size).toBe(1);
  });

  it('promotes everything waiting into one turn, in one transaction, keeping the time it was said', async () => {
    const id = await conversation();
    const first = new Date('2026-01-01T10:00:00Z');
    const second = new Date('2026-01-01T10:00:05Z');
    await queuePendingInput(pool, { conversationId: id, text: 'wait', now: first });
    const held = await leasePendingInput(pool, id, null);
    expect(held).toHaveLength(1);
    await queuePendingInput(pool, { conversationId: id, text: 'do the other one first', now: second });

    // Leased and pending alike: a run that ended is holding neither.
    const promoted = await promotePendingInput(pool, id);
    expect(promoted?.text).toBe('wait\n\ndo the other one first');
    expect(promoted?.ids).toHaveLength(2);

    const { rows: rows } = await pool.query(
      `select state, received_at, message_id from core.pending_input where conversation_id = $1::uuid order by received_at asc`,
      [id],
    );
    expect(rows.map((r: any) => r.state)).toEqual(['promoted', 'promoted']);
    // The receipt times are exactly what they were…
    expect(rows.map((r: any) => new Date(r.received_at).toISOString())).toEqual([
      first.toISOString(),
      second.toISOString(),
    ]);
    // …and the canonical turn is a new row, written now, carrying both.
    const { rows: message } = await pool.query(
      `select content, created_at from core.messages where id = $1::uuid`,
      [promoted!.messageId],
    );
    expect(message[0].content).toEqual([{ type: 'text', text: 'wait\n\ndo the other one first' }]);
    expect(new Date(message[0].created_at).getTime()).toBeGreaterThan(second.getTime());

    // Nothing is left to promote, and promoting again writes no second turn.
    expect(await promotePendingInput(pool, id)).toBeNull();
    const { rows: count } = await pool.query(
      `select count(*)::int as n from core.messages where conversation_id = $1::uuid`,
      [id],
    );
    expect(count[0].n).toBe(1);
  });

  it('leaves the rows exactly as they were when the transaction cannot land', async () => {
    const id = await conversation();
    await queuePendingInput(pool, { conversationId: id, text: 'wait' });

    // Something inside the transaction fails. Half a promotion — a canonical
    // turn with the rows still waiting, or rows marked promoted with no turn
    // to show for it — is the one outcome that must be impossible.
    await expect(
      promotePendingInput(pool, id, { join: () => { throw new Error('no'); } }),
    ).rejects.toThrow('no');

    expect((await waitingPendingInput(pool, id)).map((row) => row.state)).toEqual(['pending']);
    const { rows } = await pool.query(
      `select count(*)::int as n from core.messages where conversation_id = $1::uuid`,
      [id],
    );
    expect(rows[0].n).toBe(0);
    expect(await conversationsWithPendingInput(pool)).toEqual([id]);

    // And it can still be promoted afterwards, exactly once.
    expect((await promotePendingInput(pool, id))?.text).toBe('wait');
  });
});
