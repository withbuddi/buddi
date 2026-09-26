/**
 * Three read-only commands for the phone: `/missions`, `/goals`, `/where`.
 *
 * Each answers from what core already holds and changes nothing. Editing a
 * mission or a goal is a dashboard thing; these only say where things stand.
 * The sentences are pure functions of their rows, so the surface's tests and
 * the reference doc agree on every word.
 */
import { getActiveSchedule, listMissions, nextAfter } from '@buddi/core';
import type { Pool } from 'pg';
import type { GoalDigestLine } from '../missions/goals-page.js';

/** How many missions `/missions` lists. */
export const MISSIONS_LIMIT = 5;

export const NO_MISSIONS_TEXT = 'No mission is scheduled.';
export const NO_GOALS_TEXT = 'No goal is open.';
export const LOCAL_ONLY_TEXT = 'The dashboard is on this computer only: open buddi there.';

/** One scheduled run coming up. */
export interface UpcomingMission {
  name: string;
  /** The agent's name, as the owner knows it. */
  agent: string;
  at: Date;
}

/** "Fri 26 Sep, 17:00", in the owner's zone. */
export function localWhen(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}, ${part('hour')}:${part('minute')}`;
}

/** `/missions`: the next few, soonest first, with their local times and the agent. */
export function missionsText(upcoming: readonly UpcomingMission[], timezone: string): string {
  if (upcoming.length === 0) return NO_MISSIONS_TEXT;
  return [
    'Next missions:',
    ...upcoming.map((m) => `${localWhen(m.at, timezone)}: ${m.name}, by ${m.agent}`),
  ].join('\n');
}

/** `/goals`: each open goal with its number and one word of drift. */
export function goalsText(lines: readonly GoalDigestLine[]): string {
  if (lines.length === 0) return NO_GOALS_TEXT;
  return ['Your goals:', ...lines.map((g) => `${g.title}: ${g.figure}, ${g.drift}`)].join('\n');
}

/** `/where`: the dashboard's address a phone can open, or where it is instead. */
export function whereText(publicOrigin: string | undefined): string {
  if (!publicOrigin) return LOCAL_ONLY_TEXT;
  return `The dashboard: ${publicOrigin.replace(/\/$/, '')}/`;
}

/**
 * The next scheduled runs, from every enabled mission's active schedule. A
 * mission with no schedule, or disabled, is not coming up.
 */
export async function upcomingMissions(
  pool: Pool,
  now: Date,
  agentName: (agentId: string) => string,
  limit = MISSIONS_LIMIT,
): Promise<UpcomingMission[]> {
  const out: UpcomingMission[] = [];
  for (const mission of await listMissions(pool)) {
    if (!mission.enabled) continue;
    const spec = await getActiveSchedule(pool, mission.id);
    if (!spec) continue;
    let at: Date | null = null;
    try {
      at = nextAfter(spec.cron, now, spec.timezone);
    } catch {
      at = null;
    }
    if (at) out.push({ name: mission.name, agent: agentName(mission.agentId), at });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, limit);
}
