/**
 * Metrics the owner reports (docs/goals.md, "Metrics the owner reports").
 *
 * A metric is a named series with a source. Plugins are one source; the owner
 * is the other: "288 to 220 by December" has no plugin behind it, so the goal
 * names `owner.weight` and its values are what the owner tells buddi.
 *
 * Three pieces:
 *
 *  - **The store** — `core.owner_metrics` and `core.owner_metric_values`
 *    (migration 044). Definitions are created when an approved goal names
 *    one; values are appended by `goal.record` and never rewritten.
 *  - **The sane band** — a value more than 50 % away from the last one, or of
 *    the other sign, is refused with a sentence until the owner confirms it.
 *    A typo ("28.5" for 285) must never become the number a goal is judged by.
 *  - **The source** — `ownerMetricSource(base)` is a `MetricSource` that
 *    answers the plugin metrics of `base` and every owner metric, so every
 *    goal surface keeps asking one question: `source.metric(id)`. Owner
 *    metrics live in a table, and `metric()` is synchronous, so the source
 *    keeps a cache that each entry point refreshes with one small `select`.
 */
import { z } from 'zod';
import type { Queryable } from '../owner.js';
import type {
  MetricDirection,
  MetricReading,
  MetricSource,
  MetricUnit,
  RegisteredMetric,
} from '../metrics.js';
import type { CoreToolContext } from '../tools.js';
import { GOAL_CADENCES, type GoalCadence } from './types.js';

/** The namespace every owner metric's id is under: `owner.weight`. */
export const OWNER_METRIC_PREFIX = 'owner.';

/** The plugin name an owner metric reports, and its `source` in `goal.metrics`. */
export const OWNER_SOURCE = 'owner';

/** Kebab, lowercase, starting with a letter: `weight`, `resting-heart-rate`. */
export const OWNER_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The longest slug. It is a name, not a sentence. */
export const MAX_OWNER_SLUG = 40;

/** The longest label and unit label. */
export const MAX_OWNER_LABEL = 80;
export const MAX_OWNER_UNIT_LABEL = 16;

/** Where the owner said a value. */
export const OWNER_VALUE_SOURCES = ['chat', 'telegram', 'api'] as const;
export type OwnerValueSource = (typeof OWNER_VALUE_SOURCES)[number];

/** How far a value may move from the last one before it has to be confirmed. */
export const SANE_BAND = 0.5;

const DAY_MS = 24 * 60 * 60_000;

/** One cadence, in milliseconds. */
export function cadenceMs(cadence: GoalCadence): number {
  return cadence === 'daily' ? DAY_MS : 7 * DAY_MS;
}

export interface OwnerMetric {
  slug: string;
  /** `owner.<slug>`: what a goal's `metric` holds. */
  id: string;
  label: string;
  unit: MetricUnit;
  /** "lb", "kg": printed after the number. Null prints nothing. */
  unitLabel: string | null;
  direction: MetricDirection;
  createdAt: Date;
}

export interface OwnerMetricValue {
  id: string;
  slug: string;
  /** When buddi wrote it down. */
  at: Date;
  /** When it was true. */
  asOf: Date;
  value: number;
  note: string | null;
  source: OwnerValueSource;
  conversationId: string | null;
}

/** `owner.<slug>`. */
export function ownerMetricId(slug: string): string {
  return `${OWNER_METRIC_PREFIX}${slug}`;
}

/** The slug of an owner metric id, or null for any other id. */
export function ownerSlugOf(id: string): string | null {
  if (!id.startsWith(OWNER_METRIC_PREFIX)) return null;
  const slug = id.slice(OWNER_METRIC_PREFIX.length);
  return OWNER_SLUG.test(slug) && slug.length <= MAX_OWNER_SLUG ? slug : null;
}

/** Why a slug is refused, or null when it is a good one. */
export function refuseOwnerSlug(slug: string): string | null {
  if (slug.length === 0 || slug.length > MAX_OWNER_SLUG || !OWNER_SLUG.test(slug)) {
    return (
      `"${slug}" is not a metric name: use lowercase words joined by hyphens, starting with a letter, ` +
      `at most ${MAX_OWNER_SLUG} characters ("weight", "resting-heart-rate").`
    );
  }
  return null;
}

type OwnerMetricRow = {
  slug: string;
  label: string;
  unit: MetricUnit;
  unit_label: string | null;
  direction: MetricDirection;
  created_at: Date;
};

type OwnerValueRow = {
  id: string;
  slug: string;
  at: Date;
  as_of: Date;
  value: string | number;
  note: string | null;
  source: OwnerValueSource;
  conversation_id: string | null;
};

const METRIC_COLUMNS = 'slug, label, unit, unit_label, direction, created_at';
const VALUE_COLUMNS = 'id, slug, at, as_of, value, note, source, conversation_id';

function toOwnerMetric(row: OwnerMetricRow): OwnerMetric {
  return {
    slug: row.slug,
    id: ownerMetricId(row.slug),
    label: row.label,
    unit: row.unit,
    unitLabel: row.unit_label,
    direction: row.direction,
    createdAt: row.created_at,
  };
}

function toOwnerValue(row: OwnerValueRow): OwnerMetricValue {
  return {
    id: String(row.id),
    slug: row.slug,
    at: row.at,
    asOf: row.as_of,
    value: Number(row.value),
    note: row.note,
    source: row.source,
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
  };
}

/** One owner metric by slug, or null. */
export async function getOwnerMetric(db: Queryable, slug: string): Promise<OwnerMetric | null> {
  const { rows } = await db.query(`select ${METRIC_COLUMNS} from core.owner_metrics where slug = $1`, [slug]);
  return rows.length > 0 ? toOwnerMetric(rows[0] as OwnerMetricRow) : null;
}

/** Every owner metric, oldest first. A small table: one row per thing the owner measures. */
export async function listOwnerMetrics(db: Queryable): Promise<OwnerMetric[]> {
  const { rows } = await db.query(`select ${METRIC_COLUMNS} from core.owner_metrics order by created_at, slug`);
  return (rows as OwnerMetricRow[]).map(toOwnerMetric);
}

export interface OwnerMetricInput {
  slug: string;
  label: string;
  unit: MetricUnit;
  unitLabel?: string | null;
  direction: MetricDirection;
}

/**
 * Create an owner metric, or answer the one that already has this slug.
 *
 * `on conflict do nothing` and then a read, so two approvals naming the same
 * new slug both end with the one row. Whether the existing row *agrees* with
 * this definition is the caller's question — `goal.set` refuses a definition
 * that disagrees before any card is drawn.
 */
export async function createOwnerMetric(db: Queryable, input: OwnerMetricInput): Promise<OwnerMetric> {
  await db.query(
    `insert into core.owner_metrics (slug, label, unit, unit_label, direction)
     values ($1, $2, $3, $4, $5)
     on conflict (slug) do nothing`,
    [input.slug, input.label.trim(), input.unit, input.unitLabel?.trim() || null, input.direction],
  );
  const metric = await getOwnerMetric(db, input.slug);
  if (metric === null) throw new Error(`owner metric ${input.slug} could not be created`);
  return metric;
}

export interface RecordOwnerValueInput {
  slug: string;
  value: number;
  at: Date;
  /** When it was true. Defaults to `at`. */
  asOf?: Date;
  note?: string | null;
  source: OwnerValueSource;
  conversationId?: string | null;
}

/** Append one value. Values are never rewritten: a correction is a newer value. */
export async function recordOwnerValue(db: Queryable, input: RecordOwnerValueInput): Promise<OwnerMetricValue> {
  const { rows } = await db.query(
    `insert into core.owner_metric_values (slug, at, as_of, value, note, source, conversation_id)
     values ($1, $2::timestamptz, $3::timestamptz, $4::numeric, $5, $6, $7::uuid)
     returning ${VALUE_COLUMNS}`,
    [
      input.slug,
      input.at.toISOString(),
      (input.asOf ?? input.at).toISOString(),
      input.value,
      input.note?.trim() || null,
      input.source,
      input.conversationId ?? null,
    ],
  );
  return toOwnerValue(rows[0] as OwnerValueRow);
}

/** The newest value by `as_of` (then by `at`), or null when the owner has said none. */
export async function latestOwnerValue(db: Queryable, slug: string): Promise<OwnerMetricValue | null> {
  const [first] = await ownerValues(db, slug, { limit: 1 });
  return first ?? null;
}

/**
 * Values, newest first, optionally only those true at or after `since` and
 * before `until`. Capped: a screen or a window never asks for everything.
 */
export async function ownerValues(
  db: Queryable,
  slug: string,
  opts: { since?: Date; until?: Date; limit?: number } = {},
): Promise<OwnerMetricValue[]> {
  const { rows } = await db.query(
    `select ${VALUE_COLUMNS} from core.owner_metric_values
      where slug = $1
        and ($2::timestamptz is null or as_of >= $2::timestamptz)
        and ($3::timestamptz is null or as_of < $3::timestamptz)
      order by as_of desc, at desc, id desc
      limit $4`,
    [slug, opts.since?.toISOString() ?? null, opts.until?.toISOString() ?? null, opts.limit ?? 500],
  );
  return (rows as OwnerValueRow[]).map(toOwnerValue);
}

/**
 * Is this value believable next to the last one? Null when it is; otherwise the
 * sentence the agent repeats to the owner, asking them to confirm.
 *
 * Two rules and nothing clever: more than 50 % away from the last value, or on
 * the other side of zero. A last value of zero has no percentage, so only the
 * sign rule applies to it; no last value at all is a first value, which is the
 * baseline and always kept.
 */
export function refuseOutsideBand(
  last: number | null,
  value: number,
  format: (n: number) => string = String,
): string | null {
  if (last === null) return null;
  const wrongSign = (last > 0 && value < 0) || (last < 0 && value > 0);
  const far = last !== 0 && Math.abs(value - last) > SANE_BAND * Math.abs(last);
  if (!wrongSign && !far) return null;
  return (
    `${format(value)} is a long way from the last value, ${format(last)}. ` +
    'Ask the owner to confirm it, then record it again with confirmed: true.'
  );
}

/* ------------------------------------------------------------------ *
 * The source
 * ------------------------------------------------------------------ */

/** An owner metric as the registry shape carries it, with the two words a plugin metric has not got. */
export type RegisteredOwnerMetric = RegisteredMetric & {
  plugin: typeof OWNER_SOURCE;
  label: string;
  unitLabel: string | null;
};

/**
 * What an owner metric's `measure` accepts: the goal's cadence, so "older than
 * two cadences" is two of *that goal's* cadences. Weekly when absent — the
 * wider of the two, so a caller that does not say is never told "not
 * measured" early.
 */
const OWNER_PARAMS = z.object({ cadence: z.enum(GOAL_CADENCES).optional() }).strict();

/** The registry shape of one owner metric. Its `measure` reads the newest value. */
export function registeredOwnerMetric(metric: OwnerMetric): RegisteredOwnerMetric {
  return {
    id: metric.id,
    plugin: OWNER_SOURCE,
    description: `${metric.label}, measured by the owner when they tell buddi.`,
    label: metric.label,
    unit: metric.unit,
    unitLabel: metric.unitLabel,
    direction: metric.direction,
    params: OWNER_PARAMS,
    async measure(params, ctx): Promise<MetricReading | null> {
      const { cadence } = OWNER_PARAMS.parse(params ?? {});
      // Core's own metric, measured only through `measureMetric`, which hands
      // it core's context (the read-only pool and the run's clock).
      const core = ctx as CoreToolContext;
      const latest = await latestOwnerValue(core.db, metric.slug);
      if (latest === null) return null;
      // Older than two cadences is not a number any more; it is "not measured
      // since …", and the check says so rather than repeating it for months.
      const now = core.now().getTime();
      if (now - latest.asOf.getTime() > 2 * cadenceMs(cadence ?? 'weekly')) return null;
      return {
        value: latest.value,
        asOf: latest.asOf,
        ...(latest.note === null ? {} : { note: latest.note }),
      };
    },
  };
}

/** Is this registered metric one of the owner's? */
export function isOwnerMetric(metric: RegisteredMetric | undefined): metric is RegisteredOwnerMetric {
  return metric !== undefined && metric.plugin === OWNER_SOURCE && metric.id.startsWith(OWNER_METRIC_PREFIX);
}

/** A metric source that also answers the owner's metrics, from a cache it refreshes. */
export interface OwnerMetricSource extends MetricSource {
  /** Re-read `core.owner_metrics`. One `select`; call it at every entry point. */
  refresh(db: Queryable): Promise<void>;
  /** Put one metric in the cache now, as a write that just created it does. */
  remember(metric: OwnerMetric): void;
}

/**
 * The plugin metrics of `base`, and the owner's.
 *
 * An id under `owner.` is always answered from the owner's table, so a plugin
 * can never shadow one — a plugin's metric ids start with its own name, and
 * `owner` is not a plugin anybody can install alongside core's goals.
 */
export function ownerMetricSource(base: MetricSource): OwnerMetricSource {
  let cache = new Map<string, RegisteredOwnerMetric>();
  return {
    metric(id) {
      if (id.startsWith(OWNER_METRIC_PREFIX)) return cache.get(id);
      return base.metric(id);
    },
    metrics() {
      return [...base.metrics().filter((m) => !m.id.startsWith(OWNER_METRIC_PREFIX)), ...cache.values()];
    },
    async refresh(db) {
      const next = new Map<string, RegisteredOwnerMetric>();
      for (const metric of await listOwnerMetrics(db)) next.set(metric.id, registeredOwnerMetric(metric));
      cache = next;
    },
    remember(metric) {
      cache.set(metric.id, registeredOwnerMetric(metric));
    },
  };
}
