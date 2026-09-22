/**
 * What the registry will and will not accept as a metric, and what
 * `measureMetric` does with one once it has.
 *
 * The validation half matters because a metric is discovered by an agent
 * months after it was written: the only moment the plugin can still be *named*
 * is `register()`, and a metric that slips through becomes a goal that stops
 * being checked with nobody to blame. The measuring half matters because the
 * caller is a sentinel tick with eleven other goals to get through — nothing
 * here may throw, whatever the plugin does.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { measureMetric, measureMetricResult, metricParamsSchema } from './metrics.js';
import type { MetricDefinition } from './metrics.js';
import type { PluginManifest, ToolContext } from './tools.js';

const reading = { value: 42, asOf: new Date('2026-09-22T09:00:00Z') };

function metric(over: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    id: 'test.total',
    description: 'A number, for a test.',
    unit: 'number',
    direction: 'down',
    measure: async () => reading,
    ...over,
  };
}

function manifest(metrics: MetricDefinition[], name = 'test'): PluginManifest {
  return { name, version: '0.1.0', schema: 'core', migrationsDir: '', tools: [], metrics };
}

/**
 * A pool that answers one row and records the statements it was handed, so a
 * test can assert what the read-only wrapper let through.
 */
function fakePool(): { pool: any; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: async (config: unknown) => {
      statements.push(typeof config === 'string' ? config : String((config as { text: string }).text));
      return { rows: [{ n: 1 }] };
    },
    release: () => {},
  };
  return { statements, pool: { connect: async () => client, query: async () => ({ rows: [] }) } };
}

const ctx = (db: unknown): ToolContext => ({
  db: db as ToolContext['db'],
  ownerId: 'owner',
  now: () => new Date('2026-09-22T09:00:00Z'),
  timezone: 'America/New_York',
  agentId: 'ledger',
});

describe('the registry validates a metric before it stores anything', () => {
  it('takes a well-formed one and lists it with its plugin', () => {
    const registry = new ToolRegistry();
    registry.register(manifest([metric()]));
    expect(registry.metrics().map((m) => [m.id, m.plugin])).toEqual([['test.total', 'test']]);
    expect(registry.metric('test.total')?.description).toBe('A number, for a test.');
    expect(registry.metric('test.nothing')).toBeUndefined();
  });

  const bad: [string, MetricDefinition, RegExp][] = [
    ['an unnamespaced id', metric({ id: 'total' }), /must be `<plugin>\.<name>`/],
    ['a capitalised id', metric({ id: 'test.Total' }), /must be `<plugin>\.<name>`/],
    ['another plugin‘s namespace', metric({ id: 'finance.total' }), /namespaced under another plugin/],
    ['a unit nobody knows', metric({ unit: 'furlongs' as never }), /declares unit "furlongs"/],
    ['a direction nobody knows', metric({ direction: 'sideways' as never }), /declares direction "sideways"/],
    ['no measure at all', metric({ measure: undefined as never }), /has no `measure` function/],
    ['params that are not an object schema', metric({ params: z.string() as never }), /zod object schema/],
  ];
  for (const [name, definition, message] of bad) {
    it(`refuses ${name}, naming the plugin`, () => {
      const registry = new ToolRegistry();
      expect(() => registry.register(manifest([definition]))).toThrow(message);
      expect(registry.metrics()).toEqual([]);
    });
  }

  it('refuses two metrics with the same id in one plugin', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest([metric(), metric()]))).toThrow(/collision: test\.total/);
  });

  it('refuses an id another plugin already has', () => {
    const registry = new ToolRegistry();
    registry.register(manifest([metric()]));
    // Same id, and the second plugin is even allowed to be called `test.` —
    // it is not, but the check that matters is the one on the id.
    expect(() => registry.register(manifest([metric()], 'test'))).toThrow(/already registered/);
  });

  it('leaves the registry untouched when a later metric is bad', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(manifest([metric(), metric({ id: 'test.other', unit: 'nope' as never })])),
    ).toThrow(/test\.other/);
    expect(registry.metrics()).toEqual([]);
    expect(registry.manifests()).toEqual([]);
  });

  it('makes `params` strict, so a plugin need not remember to', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest([metric({ params: z.object({ account: z.string() }) })]));
    const params = registry.metric('test.total')?.params;
    expect(params?.safeParse({ account: 'a' }).success).toBe(true);
    expect(params?.safeParse({ account: 'a', sneaky: 1 }).success).toBe(false);
  });

  it('describes a metric‘s params the way a tool input is described', () => {
    const schema = metricParamsSchema(metric({ params: z.object({ account: z.string().optional() }) }));
    expect(schema).toMatchObject({ type: 'object', properties: { account: { type: 'string' } } });
    expect(metricParamsSchema(metric())).toBeUndefined();
  });
});

describe('measureMetric', () => {
  it('answers the reading', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest([metric()]));
    await expect(measureMetric(registry, 'test.total', {}, ctx(fakePool().pool))).resolves.toEqual(reading);
  });

  it('measures under the read-only pool, in a read-only transaction', async () => {
    const { pool, statements } = fakePool();
    const registry = new ToolRegistry();
    registry.register(
      manifest([
        metric({
          async measure(_params, inner) {
            await inner.db.query('select 1');
            return reading;
          },
        }),
      ]),
    );
    await measureMetric(registry, 'test.total', {}, ctx(pool));
    expect(statements[0]).toBe('begin isolation level repeatable read read only');
    expect(statements).toContain('select 1');
  });

  it('refuses a write from inside a metric before Postgres ever sees it', async () => {
    const { pool } = fakePool();
    const registry = new ToolRegistry();
    let refused: string | null = null;
    registry.register(
      manifest([
        metric({
          async measure(_params, inner) {
            await inner.db.query('delete from core.goals').catch((err: Error) => {
              refused = err.message;
            });
            return reading;
          },
        }),
      ]),
    );
    await measureMetric(registry, 'test.total', {}, ctx(pool));
    expect(refused).toMatch(/may only read/);
  });

  it('is handed the goal‘s holder, not the owner', async () => {
    const seen: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      manifest([
        metric({
          async measure(_params, inner) {
            seen.push(inner.agentId ?? 'none');
            return reading;
          },
        }),
      ]),
    );
    await measureMetric(registry, 'test.total', {}, ctx(fakePool().pool));
    expect(seen).toEqual(['ledger']);
  });

  const nulls: [string, () => Promise<unknown>, string, RegExp][] = [
    ['an id nobody installed', async () => null, 'test.missing', /no metric test\.missing is installed/],
    ['a metric that answers null', async () => null, 'test.total', /cannot be measured right now/],
    [
      'a metric that throws',
      async () => {
        throw new Error('the bank is down');
      },
      'test.total',
      /failed: the bank is down/,
    ],
  ];
  for (const [name, measure, id, note] of nulls) {
    it(`is null for ${name}, with the reason kept`, async () => {
      const registry = new ToolRegistry();
      registry.register(manifest([metric({ measure: measure as MetricDefinition['measure'] })]));
      const c = ctx(fakePool().pool);
      await expect(measureMetric(registry, id, {}, c)).resolves.toBeNull();
      const result = await measureMetricResult(registry, id, {}, c);
      expect(result.ok).toBe(false);
      expect((result as { note: string }).note).toMatch(note);
    });
  }

  it('parses params and refuses what the metric did not declare', async () => {
    const measure = vi.fn(async (_params: unknown) => reading);
    const registry = new ToolRegistry();
    registry.register(manifest([metric({ params: z.object({ account: z.string() }), measure })]));
    const c = ctx(fakePool().pool);

    await expect(measureMetric(registry, 'test.total', { account: 'a' }, c)).resolves.toEqual(reading);
    expect(measure.mock.calls[0]?.[0]).toEqual({ account: 'a' });

    const bad = await measureMetricResult(registry, 'test.total', { account: 1 }, c);
    expect(bad).toMatchObject({ ok: false, reason: 'invalid-params' });
    expect((bad as { note: string }).note).toMatch(/refused those parameters/);
    expect(measure).toHaveBeenCalledTimes(1);
  });
});
