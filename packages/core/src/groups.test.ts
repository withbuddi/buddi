/**
 * Changing a group: the rules, without a database.
 *
 * `planGroupChange` is the whole decision — what the group becomes, or the
 * sentence saying why it cannot. The route and the platform tool both refuse
 * on this, so it is tested here once rather than twice over HTTP.
 */
import { describe, expect, it } from 'vitest';
import { GroupRefusal, groupable, planGroupChange, updateGroup } from './groups.js';

const before = { name: 'Test room', coordinator: 'concierge', members: ['concierge', 'ledger'] };
const roster = [
  { id: 'concierge', roles: ['front-desk'] },
  { id: 'ledger', roles: [] },
  { id: 'garage', roles: [] },
  { id: 'father', roles: ['maker'] },
  { id: 'scout', roles: [], available: false },
];

describe('planning a change to a group', () => {
  it('leaves out of the change exactly what the change leaves out', () => {
    expect(planGroupChange(before, {}, roster)).toEqual(before);
    expect(planGroupChange(before, { name: '  Money  ' }, roster)).toEqual({ ...before, name: 'Money' });
  });

  it('adds a member and moves the coordinator in one change', () => {
    expect(planGroupChange(before, { coordinator: 'ledger', members: ['concierge', 'ledger', 'garage'] }, roster))
      .toEqual({ name: 'Test room', coordinator: 'ledger', members: ['concierge', 'ledger', 'garage'] });
  });

  it('refuses a coordinator who is not in the room', () => {
    const refusal = (): unknown => planGroupChange(before, { coordinator: 'garage' }, roster);
    expect(refusal).toThrow(GroupRefusal);
    expect(refusal).toThrow('The coordinator has to be one of the members.');
    // And the same when the members list is what drops it.
    expect(() => planGroupChange(before, { members: ['ledger', 'garage'] }, roster))
      .toThrow('The coordinator has to be one of the members.');
  });

  it('refuses the maker, an agent that cannot run, and one that is not installed', () => {
    for (const id of ['father', 'scout', 'nobody']) {
      const refusal = (): unknown => planGroupChange(before, { members: ['concierge', id] }, roster);
      expect(refusal).toThrow(GroupRefusal);
      expect(refusal).toThrow(new RegExp(id));
    }
    expect(groupable({ id: 'father', roles: ['maker'] })).toBe(false);
    expect(groupable({ id: 'ledger', roles: [] })).toBe(true);
  });

  it('refuses a room with nobody in it but the coordinator, and an empty name', () => {
    expect(() => planGroupChange(before, { members: ['concierge'] }, roster))
      .toThrow('A group needs at least one member besides the coordinator.');
    expect(() => planGroupChange(before, { members: [] }, roster))
      .toThrow('The coordinator has to be one of the members.');
    expect(() => planGroupChange(before, { name: '   ' }, roster)).toThrow(/needs a name/);
    expect(() => planGroupChange(before, { name: 'x'.repeat(81) }, roster)).toThrow(/needs a name/);
  });

  it('duplicates are one member, not two', () => {
    expect(planGroupChange(before, { members: ['concierge', 'ledger', 'ledger'] }, roster).members)
      .toEqual(['concierge', 'ledger']);
  });
});

const id = '11111111-2222-3333-4444-555555555555';

/** A pool that answers `getGroup` and records everything else. */
function fakePool(members: string[] = ['concierge', 'ledger']): {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
  sql: string[];
} {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string, params?: any[]): Promise<{ rows: any[] }> {
      sql.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (text.includes('from core.groups g')) {
        return { rows: [{ id, name: 'Test room', coordinator_agent_id: 'concierge', members, context_cap_chars: 40_000, last_summary: null, created_at: new Date() }] };
      }
      return { rows: [] };
    },
  };
}

describe('updateGroup', () => {
  it('writes nothing when the change is refused', async () => {
    const pool = fakePool();
    await expect(updateGroup(pool, id, { members: ['ledger', 'garage'] }, roster)).rejects.toThrow(GroupRefusal);
    expect(pool.sql.filter((s) => s.startsWith('update') || s.startsWith('delete') || s.startsWith('insert'))).toEqual([]);
  });

  it('answers null for a group that is not there, without planning anything', async () => {
    const pool = { query: async (): Promise<{ rows: any[] }> => ({ rows: [] }) };
    expect(await updateGroup(pool, id, { name: 'Money' }, roster)).toBeNull();
  });

  it('renames in place: one update, and the id is not touched', async () => {
    const pool = fakePool();
    const after = await updateGroup(pool, id, { name: 'Money' }, roster);
    expect(after?.id).toBe(id);
    expect(pool.sql).toContain('update core.groups set');
    expect(pool.sql.some((s) => s.startsWith('delete from core.group_members'))).toBe(true);
  });
});
