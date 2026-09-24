/**
 * Metrics — a number a plugin can answer, and a goal can watch.
 *
 * The same shape as a Home block (`home.ts`): a named, read-only function that
 * answers for this owner now. Core never learns the word "debt" — it learns
 * that `finance.total_debt` is a currency that should go `down`, which is
 * everything the goal machinery needs to compute progress and a pace.
 *
 * Three rules make a metric safe to call on a schedule, forever:
 *
 *  1. **It only reads.** `measure` is always handed a context whose `db` is
 *     `readOnlyPool(pool)` — the same Postgres read-only transaction a page
 *     query runs in — so a metric cannot write even through a volatile
 *     function of its own. `measureMetric` is the single place that wrapping
 *     happens, which is why the tools and the sentinel both go through it.
 *  2. **`null` is an answer.** "No data yet", "the plugin is gone", "the bank
 *     has not synced since Friday": the check records *not measurable* and the
 *     goal says "not measured since …" rather than inventing a number.
 *  3. **A broken plugin is not a broken check.** A `measure` that throws is
 *     `null` too, with its message kept as the check's note — one goal's
 *     metric must never stop the sentinel from checking the other eleven.
 */
import { z, type ZodObject, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readOnlyPool } from './pages.js';
import type { CoreToolContext, ToolContext } from './tools.js';

/** What a metric can be. Decides how a goal's numbers are rendered. */
export const METRIC_UNITS = ['number', 'currency', 'percent', 'count', 'minutes'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** Which way is better. A goal's target is checked against this. */
export const METRIC_DIRECTIONS = ['down', 'up'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

/** What a `measure` answers with when it can answer at all. */
export interface MetricReading {
  value: number;
  /** An ISO currency code, for a `currency` metric. */
  currency?: string;
  /** The instant the number is true of — not necessarily now. */
  asOf: Date;
  /** One line of provenance: "across 3 cards, statement of 2026-09-01". */
  note?: string;
}

export interface MetricDefinition {
  /** Namespaced, stable: `finance.total_debt`, `email.inbox_unread`. */
  id: string;
  /** A sentence: "Everything you owe across cards and loans, in your currency." */
  description: string;
  unit: MetricUnit;
  /** Which way is better. A goal's target is checked against this. */
  direction: MetricDirection;
  /** Optional narrowing, validated: `{ account?: string }`. Strict, like page queries. */
  params?: ZodObject<any>;
  /** Read-only, under the same read-only pool as a page query. The value now. */
  measure(params: unknown, ctx: ToolContext): Promise<MetricReading | null>;
}

/** A metric, and the plugin that contributed it. */
export type RegisteredMetric = MetricDefinition & { plugin: string };

/**
 * Whatever can find a metric by id — the registry, or a test's fake.
 *
 * `measureMetric` is typed against this rather than against `ToolRegistry` for
 * two reasons: `metrics.ts` is imported *by* `registry.ts`, so the dependency
 * only goes one way, and a suite that wants one in-memory metric should not
 * have to build a plugin manifest to get it.
 */
export interface MetricSource {
  metric(id: string): RegisteredMetric | undefined;
  metrics(): RegisteredMetric[];
}

/** `<plugin>.<name>`: lowercase, and the plugin's own name in front. */
const METRIC_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** What a metric that declares no narrowing accepts: nothing. */
const EMPTY_PARAMS = z.object({}).strict();

/**
 * Check one plugin's metrics, and hand back the versions the registry stores.
 *
 * Called from `register()` *before* anything is stored, like the page
 * descriptors: a plugin with a bad metric leaves the registry exactly as it
 * was, and the error names the plugin and the metric rather than surfacing as
 * a goal that cannot be checked three weeks later.
 *
 * `params` is made strict here rather than in each plugin, the way page query
 * parameters are (`strictParams` in `pages.ts`): unknown keys are refused by
 * the framework, not by everyone remembering `.strict()`.
 */
export function parseMetrics(
  plugin: string,
  metrics: readonly MetricDefinition[],
  taken: (id: string) => boolean,
): RegisteredMetric[] {
  const out: RegisteredMetric[] = [];
  const here = new Set<string>();
  for (const metric of metrics) {
    const id = metric.id ?? '';
    if (!METRIC_ID.test(id)) {
      throw new Error(
        `plugin ${plugin}: metric id "${id}" must be \`<plugin>.<name>\`, lowercase — ` +
          'a metric is namespaced so two plugins can both have a "total".',
      );
    }
    if (id.slice(0, id.indexOf('.')) !== plugin) {
      throw new Error(
        `plugin ${plugin}: metric "${id}" is namespaced under another plugin; ` +
          `it must start with "${plugin}.".`,
      );
    }
    if (here.has(id) || taken(id)) {
      throw new Error(`plugin ${plugin}: metric id collision: ${id}`);
    }
    if (!METRIC_UNITS.includes(metric.unit)) {
      throw new Error(
        `plugin ${plugin}: metric ${id} declares unit "${metric.unit}"; it must be one of ` +
          `${METRIC_UNITS.join(', ')}.`,
      );
    }
    if (!METRIC_DIRECTIONS.includes(metric.direction)) {
      throw new Error(
        `plugin ${plugin}: metric ${id} declares direction "${metric.direction}"; ` +
          `it must be "down" or "up" — a goal's target is checked against it.`,
      );
    }
    if (typeof metric.measure !== 'function') {
      throw new Error(`plugin ${plugin}: metric ${id} has no \`measure\` function.`);
    }
    here.add(id);
    out.push({ ...metric, plugin, ...(metric.params === undefined ? {} : { params: strictParams(plugin, id, metric.params) }) });
  }
  return out;
}

/** A metric's `params`, as the goal tools will use it: an object that refuses surprises. */
function strictParams(plugin: string, id: string, params: unknown): ZodObject<any> {
  const shape = params as {
    _def?: { typeName?: string; unknownKeys?: string };
    strict?: () => ZodObject<any>;
  };
  if (
    params === null ||
    typeof params !== 'object' ||
    shape._def?.typeName !== 'ZodObject' ||
    typeof shape.strict !== 'function'
  ) {
    throw new Error(
      `plugin ${plugin}: metric ${id} must declare \`params\` as a zod object schema; ` +
        'a narrowing is a bag of named values and nothing else can read one.',
    );
  }
  return shape._def?.unknownKeys === 'strict' ? (params as ZodObject<any>) : shape.strict();
}

/**
 * The shape of a metric's `params`, in the words a model already reads tool
 * inputs in — a JSON Schema object, from the same `zodToJsonSchema` the
 * registry derives every tool's schema with. A metric with no narrowing has
 * none, which is not the same thing as an empty object.
 */
export function metricParamsSchema(metric: MetricDefinition): Record<string, unknown> | undefined {
  if (metric.params === undefined) return undefined;
  const schema = zodToJsonSchema(metric.params as ZodTypeAny, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

/**
 * Does this metric accept these parameters? The question `goal.set` asks
 * before it draws a card, so the refusal is a sentence rather than a goal that
 * measures `null` forever.
 */
export function checkMetricParams(
  metric: MetricDefinition,
  params: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const schema = metric.params ?? EMPTY_PARAMS;
  const result = schema.safeParse(params ?? {});
  if (result.success) return { ok: true, params: result.data as Record<string, unknown> };
  return {
    ok: false,
    message:
      metric.params === undefined
        ? `${metric.id} takes no parameters; drop them.`
        : `${metric.id} refused those parameters: ${result.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`,
  };
}

/** A reading, plus what could not be read. Never a throw. */
export type MetricMeasurement =
  | { ok: true; reading: MetricReading }
  | { ok: false; reason: 'unknown-metric' | 'invalid-params' | 'not-measurable' | 'threw'; note?: string };

/**
 * Measure one metric, under the read-only pool, as the goal's holder.
 *
 * The one place a `measure` is ever called. It parses the params, wraps the
 * context the way `pageQueryContext` does — the read-only pool in place of the
 * real one — and turns every way this can fail into `null` with a note, because
 * the caller is a sentinel tick that has eleven other goals to check.
 *
 * `agentId` is the goal's holder: a metric that scopes to an agent (a
 * developer plugin's failing tests for *this* agent's workspace) reads it from
 * the context exactly as a tool would.
 */
export async function measureMetric(
  source: MetricSource,
  id: string,
  params: unknown,
  ctx: CoreToolContext,
): Promise<MetricReading | null> {
  const result = await measureMetricResult(source, id, params, ctx);
  return result.ok ? result.reading : null;
}

/**
 * The same measurement, with the reason it did not happen.
 *
 * `measureMetric` is what most callers want — a number or `null`. The check
 * keeps the reason as the check row's `note`, so "the plugin is gone" and "the
 * bank has not synced" are still different facts a week later.
 */
export async function measureMetricResult(
  source: MetricSource,
  id: string,
  params: unknown,
  ctx: CoreToolContext,
): Promise<MetricMeasurement> {
  const metric = source.metric(id);
  if (metric === undefined) {
    return { ok: false, reason: 'unknown-metric', note: `no metric ${id} is installed here` };
  }
  /*
   * A metric that declares no narrowing takes none. Without this, a metric
   * whose `measure` defensively reads an optional field it never declared —
   * an account, an agent id — can be handed one a *model* chose, and the goal
   * row keeps it forever. "Strict, like page queries" has to mean the empty
   * case too, or it only means the cases somebody remembered to declare.
   */
  const schema = metric.params ?? EMPTY_PARAMS;
  const result = schema.safeParse(params ?? {});
  if (!result.success) {
    return {
      ok: false,
      reason: 'invalid-params',
      note:
        metric.params === undefined
          ? `${id} takes no parameters; drop them.`
          : `${id} refused those parameters: ${result.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
              .join('; ')}`,
    };
  }
  /*
   * What is handed to `measure` is what the schema *made of* the input, not
   * the input — defaults applied, values coerced. The caller that persists it
   * (`goal.set`) stores this too, so the goal row and the measurement agree.
   */
  const parsed: unknown = result.data;
  try {
    const reading = await metric.measure(parsed, metricContext(ctx));
    if (reading === null || reading === undefined) {
      return { ok: false, reason: 'not-measurable', note: `${id} cannot be measured right now` };
    }
    return { ok: true, reading };
  } catch (err) {
    return {
      ok: false,
      reason: 'threw',
      note: `${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The context a `measure` runs in: the caller's, with the read-only pool in
 * place of the real one. The mirror of `pageQueryContext`, except that the
 * agent is not the owner — it is whoever holds the goal.
 */
export function metricContext(ctx: CoreToolContext): CoreToolContext {
  return { ...ctx, db: readOnlyPool(ctx.db) };
}
