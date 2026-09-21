/**
 * `platform.update_group` and `platform.archive_group`: what Agent Father can
 * change about a room, what it is refused, and what the owner is shown before
 * they approve it.
 *
 * Two things are the point here. The refusals happen in `describe`, before an
 * action exists — an owner must never be asked to approve a change that cannot
 * be made. And the preview is the *change*, in the owner's words ("Add Garage
 * to Test room; make Concierge the coordinator"), not the arguments as JSON:
 * this is what they read at seven in the morning.
 *
 * The catalog is a fake binding and the database is a small in-memory stand-in
 * for the three statements core's group writes make, so the whole family runs
 * without a Postgres.
 */
import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { createToolRegistry, type ReloadableAgentCatalog } from './catalog.js';
import {
  bindPlatformTools,
  createPlatformManifest,
  renderGroupUpdate,
  type GroupUpdateEnvelope,
} from './platform.js';

/* ------------------------------------------------------------------ *
 * A roster, a group store, and the tools bound to both
 * ------------------------------------------------------------------ */

const ROSTER = [
  { id: 'concierge', handle: 'concierge', name: 'Concierge', roles: ['front-desk'], available: true },
  { id: 'ledger', handle: 'ledger', name: 'Ledger', roles: [], available: true },
  { id: 'garage', handle: 'garage', name: 'Garage', roles: [], available: true },
  { id: 'father', handle: 'father', name: 'Agent Father', roles: ['maker'], available: true },
  { id: 'scout', handle: 'scout', name: 'Scout', roles: [], available: false },
];

interface StoredGroup {
  id: string;
  name: string;
  coordinator: string;
  members: string[];
  archivedAt: Date | null;
}

/**
 * The handful of statements core's group functions make, answered from a Map.
 * Recognised by what they say, because that is all a stand-in can do — and if
 * core's SQL changes shape, this stops answering rather than lying.
 */
function fakeDb(groups: StoredGroup[]): ToolContext['db'] {
  const rowOf = (g: StoredGroup): Record<string, unknown> => ({
    id: g.id,
    name: g.name,
    coordinator_agent_id: g.coordinator,
    members: [...g.members],
    context_cap_chars: 40_000,
    last_summary: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
  });
  return {
    async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
      const live = (): StoredGroup[] => groups.filter((g) => g.archivedAt === null);
      if (sql.includes('from core.groups g')) {
        const rows = sql.includes('where g.id = $1::uuid')
          ? live().filter((g) => g.id === params[0])
          : live();
        return { rows: rows.map(rowOf) };
      }
      if (sql.includes('set archived_at')) {
        const group = live().find((g) => g.id === params[0]);
        if (!group) return { rows: [] };
        group.archivedAt = params[1] ?? new Date();
        return { rows: [{ id: group.id }] };
      }
      if (sql.includes('update core.groups set name')) {
        const group = groups.find((g) => g.id === params[0])!;
        group.name = params[1];
        group.coordinator = params[2];
        return { rows: [] };
      }
      if (sql.includes('delete from core.group_members')) {
        const group = groups.find((g) => g.id === params[0])!;
        group.members = group.members.filter((m) => (params[1] as string[]).includes(m));
        return { rows: [] };
      }
      if (sql.includes('insert into core.group_members')) {
        const group = groups.find((g) => g.id === params[0])!;
        if (!group.members.includes(params[1])) group.members.push(params[1]);
        return { rows: [] };
      }
      throw new Error(`the fake database was asked something it does not know: ${sql}`);
    },
  } as unknown as ToolContext['db'];
}

function harness(): {
  tool(name: string): ToolDefinition<any, any>;
  ctx: ToolContext;
  groups: StoredGroup[];
  group: StoredGroup;
} {
  const registry = createToolRegistry({});
  const agent = (id: string): unknown => ROSTER.find((a) => a.id === id);
  const catalog = {
    get: (id: string) => agent(id),
    byHandle: (handle: string) => ROSTER.find((a) => a.handle === handle.toLowerCase()),
    list: () => ROSTER,
    reload: () => {},
  } as unknown as ReloadableAgentCatalog;
  bindPlatformTools(registry, { catalog, reload: () => {} });
  const manifest = createPlatformManifest(registry);
  const group: StoredGroup = {
    id: randomUUID(),
    name: 'Test room',
    coordinator: 'ledger',
    members: ['ledger', 'concierge'],
    archivedAt: null,
  };
  const groups = [group];
  const ctx = {
    db: fakeDb(groups),
    ownerId: 'owner',
    now: () => new Date('2026-09-21T09:00:00Z'),
    timezone: 'Europe/Paris',
    agentId: 'agent-father',
  } satisfies ToolContext;
  return {
    groups,
    group,
    ctx,
    tool(name) {
      const found = manifest.tools.find((t) => t.name === name);
      if (!found) throw new Error(`no such tool: ${name}`);
      // Stands in for the executor's approved snapshot: describe, then execute.
      return {
        ...found,
        execute: async (input: unknown, c: ToolContext) =>
          found.execute(input, { ...c, approvedEffect: c.approvedEffect ?? (await found.describe!(input, c)) }),
      } as ToolDefinition<any, any>;
    },
  };
}

const refusal = async (h: ReturnType<typeof harness>, tool: string, input: unknown): Promise<string> => {
  try {
    await h.tool(tool).describe!(input, h.ctx);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${tool} did not refuse`);
};

/* ------------------------------------------------------------------ */

describe('platform.update_group', () => {
  it('is a gated write, confined like every other one', () => {
    const h = harness();
    expect(h.tool('platform.update_group').tier).toBe('gated');
  });

  it('shows the owner the exact change, in their words', async () => {
    const h = harness();
    const described = await h.tool('platform.update_group').describe!(
      { group: 'Test room', coordinator: 'concierge', members: ['concierge', 'ledger', 'garage'] },
      h.ctx,
    );
    expect(described.preview).toBe('Add Garage to Test room; make Concierge the coordinator');
  });

  it('says a rename, a removal and "nothing" just as plainly', () => {
    const envelope = (after: Partial<GroupUpdateEnvelope['after']>): GroupUpdateEnvelope => ({
      tool: 'platform.update_group',
      id: 'g1',
      before: { name: 'Test room', coordinator: 'ledger', members: ['concierge', 'ledger'] },
      after: { name: 'Test room', coordinator: 'ledger', members: ['concierge', 'ledger'], ...after },
    });
    const names = (id: string): string => ROSTER.find((a) => a.id === id)?.name ?? id;
    expect(renderGroupUpdate(envelope({ name: 'Money' }), names)).toBe('Rename "Test room" to "Money"');
    expect(renderGroupUpdate(envelope({ members: ['ledger'] }), names)).toBe('Remove Concierge from Test room');
    expect(renderGroupUpdate(envelope({}), names)).toBe('Leave Test room exactly as it is');
  });

  it('changes the group, keeping its id, and answers in handles', async () => {
    const h = harness();
    const out = (await h.tool('platform.update_group').execute(
      { group: 'Test room', name: 'Money', members: ['ledger', 'garage'] },
      h.ctx,
    )) as { id: string; name: string; members: string[] };
    expect(out.id).toBe(h.group.id);
    expect(out.name).toBe('Money');
    expect(out.members.sort()).toEqual(['garage', 'ledger']);
    expect(h.group.members.sort()).toEqual(['garage', 'ledger']);
  });

  it('refuses before an action exists: the coordinator outside the room, the maker, an agent that cannot run, an empty room, and a group nobody has', async () => {
    const h = harness();
    expect(await refusal(h, 'platform.update_group', { group: 'Test room', members: ['concierge'] }))
      .toMatch(/coordinator has to be one of the members/);
    expect(await refusal(h, 'platform.update_group', { group: 'Test room', members: ['ledger', 'father'] }))
      .toMatch(/father/);
    expect(await refusal(h, 'platform.update_group', { group: 'Test room', members: ['ledger', 'scout'] }))
      .toMatch(/scout/);
    expect(await refusal(h, 'platform.update_group', { group: 'Test room', members: ['ledger'] }))
      .toMatch(/at least one member besides the coordinator/);
    expect(await refusal(h, 'platform.update_group', { group: 'Test room', members: ['ledger', 'nobody'] }))
      .toMatch(/No installed agent is "nobody"/);
    expect(await refusal(h, 'platform.update_group', { group: 'A room nobody made', name: 'x' }))
      .toMatch(/No group is called/);
    // And nothing moved.
    expect(h.group).toMatchObject({ name: 'Test room', coordinator: 'ledger', members: ['ledger', 'concierge'] });
  });

  it('refuses to run against a group that changed after the owner approved', async () => {
    const h = harness();
    const tool = h.tool('platform.update_group');
    const approved = await tool.describe!({ group: 'Test room', members: ['ledger', 'garage'] }, h.ctx);
    h.group.name = 'Renamed elsewhere';
    await expect(
      tool.execute({ group: 'Renamed elsewhere', members: ['ledger', 'garage'] }, { ...h.ctx, approvedEffect: approved }),
    ).rejects.toThrow(/no longer matches the approved preview/);
  });
});

describe('platform.archive_group', () => {
  it('names the group and says what archiving does, before it is approved', async () => {
    const h = harness();
    const described = await h.tool('platform.archive_group').describe!({ group: 'Test room' }, h.ctx);
    expect(described.preview).toMatch(/^Archive Test room: it leaves the dashboard's roster/);
    expect(h.group.archivedAt).toBeNull();
  });

  it('archives it, and refuses a group nobody has', async () => {
    const h = harness();
    expect(await h.tool('platform.archive_group').execute({ group: 'Test room' }, h.ctx))
      .toMatchObject({ id: h.group.id, name: 'Test room', archived: true });
    expect(h.group.archivedAt).not.toBeNull();
    expect(await refusal(h, 'platform.archive_group', { group: 'Test room' })).toMatch(/No group is called/);
  });
});
