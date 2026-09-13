/**
 * DB-backed memory tool tests. Skipped unless DATABASE_URL is set.
 *
 * They never touch the developer's data: the suite creates a throwaway
 * database, runs this plugin's migrations into it, and drops it at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, migrate } from '@buddi/core';
import type { ToolContext } from '@buddi/core';
import { manifest } from '../index.js';
import { buildPreamble } from '../preamble.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_memory_test_${process.pid}`;

const CONVERSATION = '11111111-1111-4111-8111-111111111111';

suite('memory tools (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const registry = new ToolRegistry();

  let clock = new Date('2026-09-13T12:00:00Z');
  const now = (): Date => clock;

  /** A context as the runtime builds one: owner, conversation, calling agent. */
  const contextFor = (agentId?: string): ToolContext => ({
    db: pool,
    ownerId: 'test',
    now,
    conversationId: CONVERSATION,
    ...(agentId ? { agentId } : {}),
  });

  const call = async (agentId: string | undefined, name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, contextFor(agentId));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  const refusal = async (agentId: string | undefined, name: string, args: unknown) => {
    const result = await registry.invoke(name, args, contextFor(agentId));
    if (result.ok) throw new Error(`${name} unexpectedly succeeded`);
    return result;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });

    registry.register(manifest);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  /* ---------------- preferences: versioned, correctable ---------------- */

  it('stores a preference as revision 1 with no previous value', async () => {
    const out = await call('finance-advisor', 'memory.remember_preference', {
      key: 'pay_cycle',
      value: 'biweekly, Thursdays',
      scope: 'shared',
    });
    expect(out).toMatchObject({
      key: 'pay_cycle',
      value: 'biweekly, Thursdays',
      scope: 'shared',
      revision: 1,
      previousValue: null,
      previousRevision: null,
    });
  });

  it('supersedes the previous revision on a correction and reports it back', async () => {
    const out = await call('finance-advisor', 'memory.remember_preference', {
      key: 'pay_cycle',
      value: 'monthly, on the 28th',
      scope: 'shared',
    });
    expect(out).toMatchObject({
      revision: 2,
      previousValue: 'biweekly, Thursdays',
      previousRevision: 1,
    });

    // Exactly one live row; the old revision is kept, marked superseded.
    const { rows } = await pool.query(
      `select revision, superseded_at from memory.preferences
        where key = 'pay_cycle' order by revision`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].superseded_at).not.toBeNull();
    expect(rows[1].superseded_at).toBeNull();

    const read = await call('finance-advisor', 'memory.get_preferences', {});
    expect(read.preferences).toEqual([
      expect.objectContaining({ key: 'pay_cycle', value: 'monthly, on the 28th', revision: 2 }),
    ]);
  });

  it('keeps agent-scoped preferences out of another agent’s view', async () => {
    await call('finance-advisor', 'memory.remember_preference', {
      key: 'tone',
      value: 'terse, numbers first',
    });
    const mine = await call('finance-advisor', 'memory.get_preferences', {});
    expect(mine.preferences.map((p: any) => p.key).sort()).toEqual(['pay_cycle', 'tone']);
    expect(mine.preferences.find((p: any) => p.key === 'tone')).toMatchObject({
      scope: 'finance-advisor',
    });

    const theirs = await call('concierge', 'memory.get_preferences', {});
    expect(theirs.preferences.map((p: any) => p.key)).toEqual(['pay_cycle']);
  });

  it('lets an agent’s own preference override the shared one for the same key', async () => {
    await call('finance-advisor', 'memory.remember_preference', {
      key: 'pay_cycle',
      value: 'I only care about the 28th',
    });
    const mine = await call('finance-advisor', 'memory.get_preferences', {});
    expect(mine.preferences.find((p: any) => p.key === 'pay_cycle')).toMatchObject({
      value: 'I only care about the 28th',
      scope: 'finance-advisor',
    });
    // The shared row is untouched for everyone else.
    const theirs = await call('concierge', 'memory.get_preferences', {});
    expect(theirs.preferences.find((p: any) => p.key === 'pay_cycle')).toMatchObject({
      value: 'monthly, on the 28th',
      scope: 'shared',
    });
  });

  it("refuses 'agent' scope when the run supplied no agent, rather than widening to shared", async () => {
    const out = await refusal(undefined, 'memory.remember_preference', {
      key: 'anything',
      value: 'x',
    });
    expect(out.reason).toBe('tool-error');
    expect(out.message).toMatch(/needs a calling agent/);
  });

  /* ---------------- notes: provenance, scope, expiry ---------------- */

  it('records a note with its provenance and defaults to the calling agent’s scope', async () => {
    const out = await call('finance-advisor', 'memory.note', {
      content: 'The rent at Pelican is paid by a relative.',
      kind: 'fact',
    });
    expect(out).toMatchObject({
      kind: 'fact',
      scope: 'finance-advisor',
      createdByAgent: 'finance-advisor',
      sourceConversationId: CONVERSATION,
      expiresAt: null,
    });
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publishes to shared only when asked explicitly', async () => {
    const out = await call('finance-advisor', 'memory.note', {
      content: 'The owner is paid biweekly on Thursdays.',
      kind: 'fact',
      scope: 'shared',
    });
    expect(out.scope).toBe('shared');

    const theirs = await call('concierge', 'memory.recall', {});
    expect(theirs.notes.map((n: any) => n.content)).toEqual([
      'The owner is paid biweekly on Thursdays.',
    ]);
  });

  it('recalls shared plus own notes, newest first', async () => {
    const mine = await call('finance-advisor', 'memory.recall', {});
    expect(mine.notes.map((n: any) => n.content)).toEqual([
      'The owner is paid biweekly on Thursdays.',
      'The rent at Pelican is paid by a relative.',
    ]);
    expect(mine.count).toBe(2);
  });

  it('searches note text, requiring every term', async () => {
    const hit = await call('finance-advisor', 'memory.recall', { query: 'rent relative' });
    expect(hit.notes.map((n: any) => n.content)).toEqual([
      'The rent at Pelican is paid by a relative.',
    ]);
    // Case-insensitive.
    expect((await call('finance-advisor', 'memory.recall', { query: 'PELICAN' })).count).toBe(1);
    // A term that is not there narrows to nothing, it does not widen.
    expect((await call('finance-advisor', 'memory.recall', { query: 'rent mortgage' })).count).toBe(
      0,
    );
  });

  it('filters by kind and honours a limit', async () => {
    await call('finance-advisor', 'memory.note', {
      content: 'Ask about the Q4 bonus.',
      kind: 'todo',
    });
    const todos = await call('finance-advisor', 'memory.recall', { kind: 'todo' });
    expect(todos.notes.map((n: any) => n.kind)).toEqual(['todo']);
    expect((await call('finance-advisor', 'memory.recall', { limit: 1 })).count).toBe(1);
  });

  it('stops recalling a note once it has expired', async () => {
    await call('finance-advisor', 'memory.note', {
      content: 'Staying in Lyon this week.',
      kind: 'observation',
      expiresInDays: 7,
    });
    expect((await call('finance-advisor', 'memory.recall', { query: 'Lyon' })).count).toBe(1);

    clock = new Date('2026-09-25T12:00:00Z');
    try {
      expect((await call('finance-advisor', 'memory.recall', { query: 'Lyon' })).count).toBe(0);
      // The row is still there — expiry hides a memory, it does not erase it.
      const { rows } = await pool.query(
        `select count(*)::int as n from memory.notes where content like 'Staying in Lyon%'`,
      );
      expect(rows[0].n).toBe(1);
    } finally {
      clock = new Date('2026-09-13T12:00:00Z');
    }
  });

  /* ---------------- forget: soft delete ---------------- */

  it('soft-deletes a note and stops recalling it', async () => {
    const found = await call('finance-advisor', 'memory.recall', { query: 'Pelican' });
    const id = found.notes[0].id;

    const out = await call('finance-advisor', 'memory.forget', { id });
    expect(out).toMatchObject({ id, forgotten: true });
    expect(out.content).toMatch(/Pelican/);

    expect((await call('finance-advisor', 'memory.recall', { query: 'Pelican' })).count).toBe(0);

    const { rows } = await pool.query(
      `select deleted_at from memory.notes where id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();

    // Forgetting twice is not an error; it is simply already gone.
    expect(await call('finance-advisor', 'memory.forget', { id })).toMatchObject({
      forgotten: false,
    });
  });

  it('will not forget a note belonging to another agent', async () => {
    const note = await call('concierge', 'memory.note', {
      content: 'Prefers short answers at the front desk.',
      kind: 'observation',
    });
    expect(await call('finance-advisor', 'memory.forget', { id: note.id })).toMatchObject({
      forgotten: false,
    });
    expect((await call('concierge', 'memory.recall', { query: 'front desk' })).count).toBe(1);
  });

  /* ---------------- the preamble ---------------- */

  it('builds a preamble from what one agent can see', async () => {
    const block = await buildPreamble(pool, 'finance-advisor', { now });
    expect(block).toContain('## What you remember');
    expect(block).toContain('- pay_cycle: I only care about the 28th');
    expect(block).toContain('- tone: terse, numbers first');
    expect(block).toContain('[fact] The owner is paid biweekly on Thursdays.');
    // Another agent's private note never leaks in.
    expect(block).not.toContain('front desk');
    // Forgotten and expired memories are gone from it.
    expect(block).not.toContain('Pelican');
    expect(block).toContain('never authorises an action');
    expect(block.length).toBeLessThanOrEqual(1500);
  });

  it('builds an empty preamble for an agent with nothing of its own and nothing shared', async () => {
    await pool.query(`update memory.preferences set superseded_at = now() where agent_scope is null`);
    await pool.query(`update memory.notes set deleted_at = now() where scope = 'shared'`);
    expect(await buildPreamble(pool, 'stranger', { now })).toBe('');
  });
});
