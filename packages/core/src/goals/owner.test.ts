/**
 * Owner metrics without a database: the slug rule, the sane band, and what
 * `measure` answers for a value that is fresh, old, or missing.
 */
import { describe, expect, it } from 'vitest';
import {
  ownerMetricId,
  ownerMetricSource,
  ownerSlugOf,
  refuseOutsideBand,
  refuseOwnerSlug,
  registeredOwnerMetric,
  type OwnerMetric,
} from './owner.js';
import type { CoreToolContext } from '../tools.js';
import type { MetricSource } from '../metrics.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60_000;

const weight: OwnerMetric = {
  slug: 'weight',
  id: 'owner.weight',
  label: 'Weight',
  unit: 'number',
  unitLabel: 'lb',
  direction: 'down',
  createdAt: NOW,
};

/** A context whose database answers one value row, or none. */
function ctxWith(asOf: Date | null): CoreToolContext {
  const rows =
    asOf === null
      ? []
      : [{ id: '1', slug: 'weight', at: asOf, as_of: asOf, value: '285', note: null, source: 'chat', conversation_id: null }];
  return {
    db: { query: async () => ({ rows }) } as unknown as CoreToolContext['db'],
    ownerId: 'owner',
    now: () => NOW,
    timezone: 'UTC',
  };
}

describe('owner metric slugs', () => {
  it('takes kebab words and refuses anything else', () => {
    expect(refuseOwnerSlug('weight')).toBeNull();
    expect(refuseOwnerSlug('resting-heart-rate')).toBeNull();
    for (const bad of ['Weight', 'weight_kg', '-weight', 'weight-', '9lives', 'a--b', '', 'x'.repeat(41)]) {
      expect(refuseOwnerSlug(bad)).toMatch(/not a metric name/);
    }
  });

  it('maps a slug to its id and back', () => {
    expect(ownerMetricId('weight')).toBe('owner.weight');
    expect(ownerSlugOf('owner.weight')).toBe('weight');
    expect(ownerSlugOf('finance.total_debt')).toBeNull();
    expect(ownerSlugOf('owner.Bad_Slug')).toBeNull();
  });
});

describe('the sane band', () => {
  it('keeps a first value and a believable next one', () => {
    expect(refuseOutsideBand(null, 288)).toBeNull();
    expect(refuseOutsideBand(288, 285)).toBeNull();
    expect(refuseOutsideBand(288, 144)).toBeNull(); // exactly 50 % is inside
    expect(refuseOutsideBand(0, 3)).toBeNull(); // no percentage from zero
  });

  it('asks to confirm a value more than half away, or of the other sign', () => {
    expect(refuseOutsideBand(288, 28.5)).toMatch(/Ask the owner to confirm it/);
    expect(refuseOutsideBand(288, 500)).toMatch(/confirmed: true/);
    expect(refuseOutsideBand(10, -1)).toMatch(/long way from the last value, 10/);
  });
});

describe('an owner metric as the registry sees it', () => {
  const metric = registeredOwnerMetric(weight);

  it('answers the newest value with its as-of', async () => {
    const asOf = new Date(NOW.getTime() - 3 * DAY);
    expect(await metric.measure({}, ctxWith(asOf))).toEqual({ value: 285, asOf });
  });

  it('answers null when there is no value, or it is older than two cadences', async () => {
    expect(await metric.measure({}, ctxWith(null))).toBeNull();
    expect(await metric.measure({}, ctxWith(new Date(NOW.getTime() - 15 * DAY)))).toBeNull();
    expect(await metric.measure({ cadence: 'weekly' }, ctxWith(new Date(NOW.getTime() - 13 * DAY)))).not.toBeNull();
    expect(await metric.measure({ cadence: 'daily' }, ctxWith(new Date(NOW.getTime() - 3 * DAY)))).toBeNull();
  });

  it('sits beside the plugin metrics, and a plugin cannot shadow it', async () => {
    const shadow = { ...metric, id: 'owner.weight', plugin: 'rogue' };
    const base: MetricSource = { metrics: () => [shadow], metric: (id) => (id === shadow.id ? shadow : undefined) };
    const source = ownerMetricSource(base);
    expect(source.metric('owner.weight')).toBeUndefined();
    source.remember(weight);
    expect(source.metric('owner.weight')?.plugin).toBe('owner');
    expect(source.metrics().map((m) => `${m.plugin}:${m.id}`)).toEqual(['owner:owner.weight']);
  });
});
