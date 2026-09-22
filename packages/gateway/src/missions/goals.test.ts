/**
 * The goal tools, against a fake registry with one in-memory metric.
 *
 * What is settled here is everything that happens *before* a row exists: what
 * an agent is told the installation can measure, which proposals never become
 * a card at all, and the exact sentence the owner is asked to approve. The
 * database half — the set travelling through describe → approve → execute, the
 * thirteenth goal, the sentinel over six weeks — is `goals.db.test.ts`.
 */
import { ToolRegistry, type MetricDefinition, type MetricSource, type RegisteredMetric, type ToolContext } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DAILY_DUE_MS,
  WEEKLY_DUE_MS,
  cadenceDue,
  createGoalManifest,
  formatValue,
  goalKey,
  renderGoalSet,
  renderGoalUpdate,
  type GoalSetEnvelope,
  type GoalUpdateEnvelope,
} from './goals.js';

const NOW = new Date('2026-09-22T13:00:00Z');
const TZ = 'America/New_York';

/** A metric source with whatever a test wants in it, and nothing else. */
function source(...metrics: (MetricDefinition & { plugin?: string })[]): MetricSource {
  const all = metrics.map((m) => ({ plugin: 'finance', ...m })) as RegisteredMetric[];
  return { metrics: () => all, metric: (id) => all.find((m) => m.id === id) };
}

const debt: MetricDefinition = {
  id: 'finance.total_debt',
  description: 'Everything you owe across cards and loans, in your currency.',
  unit: 'currency',
  direction: 'down',
  params: z.object({ account: z.string().optional() }).strict(),
  measure: async () => ({ value: 87_400, currency: 'USD', asOf: NOW }),
};

const unmeasurable: MetricDefinition = {
  ...debt,
  id: 'finance.unknown_debt',
  measure: async () => null,
};

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  db: { query: async () => ({ rows: [] }) } as unknown as ToolContext['db'],
  ownerId: 'owner',
  now: () => NOW,
  timezone: TZ,
  agentId: 'ledger',
  ...over,
});

const goodInput = {
  title: 'Debt down by 40k',
  metric: 'finance.total_debt',
  target: { kind: 'delta' as const, value: -40_000 },
  deadline: '2027-03-22',
  cadence: 'weekly' as const,
  milestones: [-10_000, -20_000, -30_000],
};

/** The manifest, in a registry, so `invoke` decides the tier the way it will. */
function registryWith(src: MetricSource): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createGoalManifest(src));
  return registry;
}

function toolOf(src: MetricSource, name: string) {
  const tool = createGoalManifest(src).tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool;
}

describe('goal.metrics', () => {
  it('lists what this installation can measure, params and all', async () => {
    const result = (await toolOf(source(debt), 'goal.metrics').execute({}, ctx())) as {
      metrics: Record<string, unknown>[];
    };
    expect(result.metrics).toEqual([
      {
        id: 'finance.total_debt',
        plugin: 'finance',
        description: debt.description,
        unit: 'currency',
        direction: 'down',
        params: expect.objectContaining({ type: 'object' }),
      },
    ]);
  });

  it('is empty on an installation with no metrics — and says nothing about goals', async () => {
    const result = (await toolOf(source(), 'goal.metrics').execute({}, ctx())) as { metrics: unknown[] };
    expect(result.metrics).toEqual([]);
  });
});

describe('goal.set refuses before it ever becomes a card', () => {
  const cases: [string, Partial<typeof goodInput>, Partial<ToolContext>, string, RegExp][] = [
    [
      'a run with no agent id',
      {},
      { agentId: undefined },
      'no-agent',
      /this run has no agent id/,
    ],
    [
      'a delegate',
      {},
      { delegationDepth: 1 },
      'delegate',
      /a delegate cannot set a goal/,
    ],
    [
      'a metric nobody installed',
      { metric: 'finance.made_up' },
      {},
      'unknown-metric',
      /no metric "finance\.made_up" is installed here/,
    ],
    [
      'a deadline in the past',
      { deadline: '2026-01-01' },
      {},
      'deadline-past',
      /is not in the future/,
    ],
    [
      'a deadline past the horizon',
      { deadline: '2032-01-01' },
      {},
      'deadline-too-far',
      /at most 1095 days/,
    ],
    [
      'a deadline nobody can parse',
      { deadline: 'next Friday' },
      {},
      'invalid-deadline',
      /is not an ISO date or datetime/,
    ],
  ];

  for (const [name, input, over, reason, message] of cases) {
    it(`${name} is answered, not asked about`, async () => {
      const registry = registryWith(source(debt));
      const result = await registry.invoke('goal.set', { ...goodInput, ...input }, ctx(over));
      /*
       * A gated tool is gated on every call, so the refusal comes out of
       * `describe` — before any action exists. What the model gets back is the
       * sentence, and what the owner gets is nothing at all: no card, no row.
       */
      expect(result).toMatchObject({ ok: false, reason: 'tool-error' });
      expect((result as { message: string }).message).toMatch(message);
      expect(reason).toBeTruthy();
    });
  }

  it('a good proposal gets as far as describing an effect', async () => {
    // No database here, so the action cannot be written; what is under test is
    // that `describe` refuses nothing and the call is on its way to a card.
    const registry = registryWith(source(debt));
    const result = await registry.invoke('goal.set', goodInput, ctx());
    expect((result as { message?: string }).message ?? '').not.toMatch(/could not describe/);
  });

  it('the card is never shown for a metric that cannot be measured', async () => {
    const tool = toolOf(source(unmeasurable), 'goal.set');
    await expect(
      tool.describe?.({ ...goodInput, metric: 'finance.unknown_debt' }, ctx()),
    ).rejects.toThrow(/cannot be measured right now, so there is no baseline/);
  });

  it('describes the effect from the measurement, not from the arguments', async () => {
    const described = await toolOf(source(debt), 'goal.set').describe?.(goodInput, ctx());
    const envelope = described?.envelope as GoalSetEnvelope;
    expect(envelope).toMatchObject({
      tool: 'goal.set',
      agentId: 'ledger',
      metric: 'finance.total_debt',
      target: { kind: 'delta', value: -40_000 },
      baseline: { value: 87_400, currency: 'USD' },
      cadence: 'weekly',
      milestones: [-10_000, -20_000, -30_000],
    });
    // The deadline is the owner's day, resolved to an instant here and not
    // left as the string a model wrote.
    expect(envelope.deadline).toBe(new Date('2027-03-22T13:00:00.000Z').toISOString());
  });
});

describe('the cards', () => {
  const envelope: GoalSetEnvelope = {
    tool: 'goal.set',
    agentId: 'ledger',
    title: 'Debt down by 40k',
    metric: 'finance.total_debt',
    params: {},
    target: { kind: 'delta', value: -40_000 },
    baseline: { value: 87_400, currency: 'USD', asOf: '2026-09-22T13:00:00.000Z' },
    deadline: '2027-03-22T13:00:00.000Z',
    cadence: 'weekly',
    milestones: [-10_000],
  };

  it('says the §5 sentence, in the owner‘s money and the owner‘s day', () => {
    const preview = renderGoalSet(envelope, 'currency', TZ);
    expect(preview).toContain(
      'From $87,400 today to $47,400 by 2027-03-22: $1,547 per week, checked weekly, held by @ledger',
    );
    expect(preview).toContain('Milestones you will hear about, once each: $77,400.');
  });

  it('renders the day in the owner‘s zone, not UTC', () => {
    // 01:00 UTC on the 23rd is still the 22nd in New York.
    const preview = renderGoalSet(
      { ...envelope, deadline: '2027-03-23T01:00:00.000Z' },
      'currency',
      TZ,
    );
    expect(preview).toContain('by 2027-03-22');
  });

  it('an update card shows only what changes, before → after', () => {
    const update: GoalUpdateEnvelope = {
      tool: 'goal.update',
      id: 'g1',
      agentId: 'ledger',
      title: 'Debt down by 40k',
      before: {
        target: { kind: 'delta', value: -40_000 },
        deadline: '2027-03-22T13:00:00.000Z',
        cadence: 'weekly',
        milestones: [-10_000],
      },
      after: {
        target: { kind: 'delta', value: -30_000 },
        deadline: '2027-03-22T13:00:00.000Z',
        cadence: 'weekly',
        milestones: [-10_000],
      },
    };
    const preview = renderGoalUpdate(update, 'currency', TZ, 87_400);
    expect(preview).toContain('Target:    $47,400 → $57,400');
    expect(preview).not.toContain('Deadline');
    expect(preview).not.toContain('Cadence');
  });

  it('an update that changes nothing says so rather than showing a blank card', () => {
    const same = {
      target: { kind: 'delta' as const, value: -40_000 },
      deadline: '2027-03-22T13:00:00.000Z',
      cadence: 'weekly' as const,
      milestones: [],
    };
    const preview = renderGoalUpdate(
      { tool: 'goal.update', id: 'g1', agentId: 'ledger', title: 'x', before: same, after: same },
      'currency',
      TZ,
      100,
    );
    expect(preview).toContain('(nothing changes)');
  });
});

describe('formatValue', () => {
  const cases: [string, Parameters<typeof formatValue>, string][] = [
    ['money with the metric‘s currency', [87_400, 'currency', 'USD'], '$87,400'],
    ['money with no currency falls back rather than lying', [1, 'currency', null], '$1'],
    ['a count', [12, 'count', null], '12'],
    ['a percent', [12.34, 'percent', null], '12.3%'],
    ['minutes', [90.4, 'minutes', null], '90 min'],
    ['nothing measured says so', [null, 'currency', 'USD'], 'not measured'],
  ];
  for (const [name, args, expected] of cases) {
    it(name, () => expect(formatValue(...args)).toBe(expected));
  }
});

describe('cadenceDue', () => {
  const at = (ms: number): Date => new Date(NOW.getTime() - ms);
  it('a goal never checked is due', () => {
    expect(cadenceDue('daily', null, NOW)).toBe(true);
    expect(cadenceDue('weekly', null, NOW)).toBe(true);
  });
  it('daily waits 20 hours, so tomorrow‘s 09:00 tick still counts', () => {
    expect(cadenceDue('daily', at(DAILY_DUE_MS - 1), NOW)).toBe(false);
    expect(cadenceDue('daily', at(DAILY_DUE_MS), NOW)).toBe(true);
  });
  it('weekly waits 6 days and 20 hours', () => {
    expect(cadenceDue('weekly', at(WEEKLY_DUE_MS - 1), NOW)).toBe(false);
    expect(cadenceDue('weekly', at(WEEKLY_DUE_MS), NOW)).toBe(true);
    // A daily margin is nowhere near enough for a weekly goal.
    expect(cadenceDue('weekly', at(DAILY_DUE_MS), NOW)).toBe(false);
  });
});

describe('goalKey', () => {
  it('is one key per goal per event, so each resolves on its own', () => {
    expect(goalKey('g1', 'off-track')).toBe('goal.g1.off-track');
    expect(goalKey('g1', 'milestone.-10000')).toBe('goal.g1.milestone.-10000');
    expect(goalKey('g1', 'off-track')).not.toBe(goalKey('g2', 'off-track'));
  });
});
