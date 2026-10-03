import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Why a browser task stopped, or nearly did (docs/browser.md, "Stop causes").
 *
 * One id per path the spec counted. `outcome` is what the path is now: gone
 * (`removed`), retried inside the tool (`retry`), one owner card (`card`), or
 * still a stop the owner chose (`kept`). Counting them is how the flakiness
 * is seen to fall.
 */
export const STOP_CAUSES = {
  // Removed (10): no sentence reaches the agent or the owner any more.
  'start-with-navigate': { outcome: 'removed', what: 'An action before any page was open' },
  'slot-limit': { outcome: 'removed', what: 'All pages in use; the task now waits its turn' },
  'mode-lock': { outcome: 'removed', what: 'Settings locked while a page was open' },
  'controls-changing': { outcome: 'removed', what: 'Owner controls changing during an action; now serialised' },
  'access-changed-opening': { outcome: 'removed', what: 'Access changed while a page was opening; now serialised' },
  'request-ended': { outcome: 'removed', what: 'The request ended after a close, sweep or rollover; the next action re-opens' },
  'never-switch-modes': { outcome: 'removed', what: 'The prompt rule against switching modes' },
  'status-first': { outcome: 'removed', what: 'browser.status as a required first call' },
  'owner-watching': { outcome: 'removed', what: 'The owner looking at the tab; now wait, then the in-tab bar' },
  'route-unavailable': { outcome: 'removed', what: 'A route down while another could serve; now a silent fallback' },
  // Retried in the tool (6).
  'page-not-answered': { outcome: 'retry', what: 'The page had not answered; re-read with backoff' },
  'observation-failures': { outcome: 'retry', what: 'Repeated observation failures; six attempts, then one card' },
  'stale-ref': { outcome: 'retry', what: 'A ref that no longer matched; re-observed' },
  'redirect': { outcome: 'retry', what: 'The page moved since the observation; re-observed' },
  'stale-observation': { outcome: 'retry', what: 'An old observation id; re-observed' },
  'not-connected': { outcome: 'retry', what: 'The owner\'s Chrome not connected; fell back to the own browser' },
  // One owner card (4).
  'uncertain-input': { outcome: 'card', what: 'A click or fill that may not have landed: Look?' },
  'budget': { outcome: 'card', what: 'The task used its steps or its hour: Keep going?' },
  'sign-in': { outcome: 'card', what: 'A sign-in or a code with no stored login and no Chrome: Sign in' },
  'human-check': { outcome: 'card', what: 'A captcha or "verify you are human": Human check' },
  // Kept: the owner's own stops, and the facts that have no alternative.
  'owner-stop': { outcome: 'kept', what: 'The owner\'s Stop agents\' browsing (expires; Resume card)' },
  'session-stop': { outcome: 'kept', what: 'The owner stopped this conversation\'s page' },
  'takeover': { outcome: 'kept', what: 'The owner took over' },
  'no-owner-request': { outcome: 'kept', what: 'No owner request (sources, CLI)' },
  'screen-gone': { outcome: 'retry', what: 'The tab or window closed; re-opened at the last address' },
  'app-behind': { outcome: 'retry', what: 'The app went behind the owner\'s window; brought forward again' },
  'targeting-cap': { outcome: 'card', what: 'Eight targeting failures in a row: the budget card' },
  'no-browser': { outcome: 'kept', what: 'No browser installed (repair in Settings)' },
  'apps-unavailable': { outcome: 'kept', what: 'An app job with the apps route off or unhealthy' },
} as const;
export type StopCause = keyof typeof STOP_CAUSES;

export type TelemetryEvent =
  | { type: 'browser.stop'; cause: StopCause; route: string; agent?: string; surface?: string; host?: string; recovered: 'silent' | 'card' | 'none' }
  | { type: 'browser.route'; chosen: string; reason: string; fallbackFrom?: string; agent?: string; host?: string }
  | { type: 'browser.task'; outcome: 'done' | 'needs-owner' | 'stopped' | 'budget'; actions: number; seconds: number; cards: number; agent?: string; route?: string };

/** The structured log behind `buddi doctor browser`. Host only, never a URL or a value. */
export class BrowserTelemetry {
  /** In memory too, so a process without a log file (tests, CLI) still answers. */
  readonly events: Array<TelemetryEvent & { at: string }> = [];
  constructor(readonly file?: string, readonly now: () => number = Date.now, readonly maxBytes = 1_000_000) {}

  record(event: TelemetryEvent): void {
    const entry = { ...event, at: new Date(this.now()).toISOString() };
    this.events.push(entry);
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try { if (statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`); } catch { /* no file yet */ }
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* telemetry never costs the owner a page */ }
  }

  stop(cause: StopCause, fields: Omit<Extract<TelemetryEvent, { type: 'browser.stop' }>, 'type' | 'cause' | 'recovered'> & { recovered?: 'silent' | 'card' | 'none' }): void {
    const outcome = STOP_CAUSES[cause].outcome;
    this.record({ type: 'browser.stop', cause, recovered: fields.recovered ?? (outcome === 'card' ? 'card' : outcome === 'kept' ? 'none' : 'silent'), ...fields });
  }
}

/** What `buddi doctor browser` prints from: the last `days` of events. */
export interface TelemetrySummary {
  days: number;
  tasks: number;
  stops: number;
  cards: number;
  byCause: Array<{ cause: string; count: number; outcome: string }>;
  routes: Record<string, number>;
  /** Stops per task, the number the spec aims under 0.2. */
  stopsPerTask: number;
}

export function summarize(events: ReadonlyArray<TelemetryEvent & { at: string }>, now: number, days = 7): TelemetrySummary {
  const since = now - days * 86_400_000;
  const recent = events.filter((event) => Date.parse(event.at) >= since);
  const counts = new Map<string, number>();
  const routes: Record<string, number> = {};
  let tasks = 0; let cards = 0; let stops = 0;
  for (const event of recent) {
    if (event.type === 'browser.stop') {
      stops++;
      if (event.recovered === 'card') cards++;
      counts.set(event.cause, (counts.get(event.cause) ?? 0) + 1);
    } else if (event.type === 'browser.route') routes[event.chosen] = (routes[event.chosen] ?? 0) + 1;
    else if (event.type === 'browser.task') tasks++;
  }
  const byCause = [...counts].sort((a, b) => b[1] - a[1]).map(([cause, count]) => ({ cause, count, outcome: (STOP_CAUSES as Record<string, { outcome: string }>)[cause]?.outcome ?? 'unknown' }));
  const routeTasks = Object.values(routes).reduce((sum, n) => sum + n, 0);
  const denominator = Math.max(tasks, routeTasks, 1);
  return { days, tasks: Math.max(tasks, routeTasks), stops, cards, byCause, routes, stopsPerTask: Math.round((stops / denominator) * 100) / 100 };
}

/** Read the log (and its rotated half) back. Lines that do not parse are skipped. */
export function readTelemetry(file: string): Array<TelemetryEvent & { at: string }> {
  const out: Array<TelemetryEvent & { at: string }> = [];
  for (const name of [`${file}.1`, file]) {
    let text = '';
    try { text = readFileSync(name, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
    }
  }
  return out;
}

/** The lines `buddi doctor browser` prints. */
export function telemetryLines(summary: TelemetrySummary): string[] {
  const lines = [`Browser, last ${summary.days} days: ${summary.tasks} task${summary.tasks === 1 ? '' : 's'}, ${summary.stops} stop${summary.stops === 1 ? '' : 's'} (${summary.stopsPerTask} per task), ${summary.cards} card${summary.cards === 1 ? '' : 's'}.`];
  const routes = Object.entries(summary.routes).map(([route, n]) => `${route} ${n}`).join(', ');
  if (routes) lines.push(`Routes: ${routes}.`);
  for (const { cause, count, outcome } of summary.byCause.slice(0, 12)) lines.push(`  ${cause}: ${count} (${outcome})`);
  return lines;
}
