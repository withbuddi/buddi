/**
 * The source tick — the sentinel tick's twin, for the other half of the
 * "plugins originate work" contract.
 *
 * A sentinel *reads* a plugin's own schema and returns findings; a source
 * *reaches the world* (an IMAP socket, a file drop) and enqueues runs. They are
 * scheduled the same way and for the same reasons, so this file mirrors
 * `sentinels/run.ts` deliberately:
 *
 *  1. **The period is a ledger, not a timer.** `core.source_runs` holds the last
 *     run per source id, so a process that restarts every five minutes does not
 *     re-poll every five minutes, and a machine that slept simply finds every
 *     source due at once.
 *  2. **A source that throws cannot stop the others.** The error lands in
 *     `last_error` and the tick continues. A source is talking to a network:
 *     failing is normal, and it is never allowed to be an outage of the tick.
 *  3. **Core never decides what a run says.** It hands over `enqueueRun` and
 *     nothing else; the payload is the plugin's, the queue is the gateway's.
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';
import type { PluginManifest, Source, CoreSourceContext } from '../tools.js';
import { createPluginHost, hostBindingOf, type HostBinding } from '../host/build.js';

/** Every source the installed plugins ship, in manifest order. */
export function collectSources(manifests: PluginManifest[]): Source[] {
  const seen = new Set<string>();
  const all: Source[] = [];
  for (const manifest of manifests) {
    for (const source of manifest.sources ?? []) {
      if (seen.has(source.id)) {
        throw new Error(`source id collision: ${source.id} (plugin ${manifest.name})`);
      }
      seen.add(source.id);
      all.push(source);
    }
  }
  return all;
}

/** What one source did in one tick. Returned so the caller can log it. */
export type SourceOutcome = {
  sourceId: string;
  /** False when the period had not elapsed: nothing ran, nothing changed. */
  ran: boolean;
  error?: string;
};

export type RunSourcesInput = {
  now: Date;
  timezone: string;
  /** How a source originates a run. Idempotent on `dedupKey`. */
  enqueueRun: CoreSourceContext['enqueueRun'];
  log?: (line: string) => void;
};

type RunLedgerRow = { source_id: string; last_run_at: Date; last_error: string | null };

/** Poll every due source once. Never throws for a source's own failure. */
export async function runSources(
  pool: Pool,
  manifests: PluginManifest[],
  input: RunSourcesInput,
): Promise<SourceOutcome[]> {
  const sources = collectSources(manifests);
  if (sources.length === 0) return [];
  // Which plugin each source belongs to, for its `ctx.buddi`.
  const bindings = new Map<string, HostBinding>();
  for (const manifest of manifests) {
    if ((manifest.sources ?? []).length === 0) continue;
    const binding = hostBindingOf(manifest);
    for (const source of manifest.sources ?? []) bindings.set(source.id, binding);
  }
  const log = input.log ?? ((line: string) => console.error(line));

  const { rows: ledger } = await pool.query<RunLedgerRow>(
    `select source_id, last_run_at, last_error from core.source_runs`,
  );
  const lastRun = new Map(ledger.map((r) => [r.source_id, r.last_run_at]));

  const outcomes: SourceOutcome[] = [];
  for (const source of sources) {
    const previous = lastRun.get(source.id);
    const dueAt = previous ? previous.getTime() + source.every * 1000 : 0;
    if (previous && input.now.getTime() < dueAt) {
      outcomes.push({ sourceId: source.id, ran: false });
      continue;
    }
    outcomes.push(await pollOne(pool, source, input, log, bindings.get(source.id)));
  }
  return outcomes;
}

async function pollOne(
  pool: Pool,
  source: Source,
  input: RunSourcesInput,
  log: (line: string) => void,
  binding: HostBinding | undefined,
): Promise<SourceOutcome> {
  const ctx: CoreSourceContext = {
    db: pool,
    now: () => input.now,
    timezone: input.timezone,
    log,
    enqueueRun: input.enqueueRun,
  };
  if (binding !== undefined) ctx.buddi = createPluginHost(binding, ctx);
  try {
    await source.poll(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordRun(pool, source.id, input.now, message);
    await appendEvent(pool, 'source.polled', { sourceId: source.id, error: message });
    return { sourceId: source.id, ran: true, error: message };
  }
  await recordRun(pool, source.id, input.now, null);
  await appendEvent(pool, 'source.polled', { sourceId: source.id });
  return { sourceId: source.id, ran: true };
}

async function recordRun(
  pool: Pool,
  sourceId: string,
  now: Date,
  error: string | null,
): Promise<void> {
  await pool.query(
    `insert into core.source_runs (source_id, last_run_at, last_error)
     values ($1, $2, $3)
     on conflict (source_id) do update
       set last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
    [sourceId, now.toISOString(), error],
  );
}
