/**
 * `/missions`, `/goals`, `/where`: the sentences, from fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { FrequencyStanding, Goal, GoalStanding } from '@buddi/core';
import {
  LOCAL_ONLY_TEXT,
  NO_GOALS_TEXT,
  NO_MISSIONS_TEXT,
  goalsText,
  localWhen,
  missionsText,
  upcomingMissions,
  whereText,
} from './commands.js';
import { frequencyDrift, levelDrift } from '../missions/goals-page.js';

const TZ = 'Europe/Paris';

describe('/missions', () => {
  it('lists each with its local time and agent', () => {
    const text = missionsText(
      [
        { name: 'Weekly recap', agent: 'Ledger', at: new Date('2026-09-26T15:00:00Z') },
        { name: 'Inbox sweep', agent: 'Mail', at: new Date('2026-09-27T06:30:00Z') },
      ],
      TZ,
    );
    expect(text).toBe('Next missions:\nSat 26 Sep, 17:00: Weekly recap, by Ledger\nSun 27 Sep, 08:30: Inbox sweep, by Mail');
  });

  it('says so when nothing is scheduled', () => {
    expect(missionsText([], TZ)).toBe(NO_MISSIONS_TEXT);
    expect(NO_MISSIONS_TEXT).toBe('No mission is scheduled.');
  });

  it('formats a time in the owner zone, 24-hour', () => {
    expect(localWhen(new Date('2026-01-05T23:05:00Z'), 'America/New_York')).toBe('Mon 5 Jan, 18:05');
  });

  it('reads the next five enabled, scheduled missions, soonest first', async () => {
    const missions = [
      ['daily', 'Daily brief', 'ledger', true, '0 8 * * *'],
      ['weekly', 'Weekly recap', 'ledger', true, '0 17 * * 5'],
      ['off', 'Disabled', 'ledger', false, '* * * * *'],
      ['none', 'Unscheduled', 'mail', true, null],
      ['hourly', 'Hourly', 'mail', true, '0 * * * *'],
    ] as const;
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('from core.missions')) {
          return {
            rows: missions.map(([id, name, agent, enabled]) => ({
              id, name, agent_id: agent, prompt: '', enabled, always_deliver: false, created_at: new Date(0),
            })),
          };
        }
        if (sql.includes('from core.schedule_specs')) {
          const m = missions.find((x) => x[0] === params[0]);
          return {
            rows: m && m[4] ? [{
              id: `s-${m[0]}`, mission_id: m[0], revision: 1, cron: m[4], timezone: TZ, misfire_policy: 'coalesce',
              deadline_minutes: null, active: true, created_at: new Date(0),
            }] : [],
          };
        }
        throw new Error(sql);
      },
    };
    const now = new Date('2026-09-26T05:10:00Z'); // 07:10 in Paris, a Saturday
    const upcoming = await upcomingMissions(pool as never, now, (id) => (id === 'ledger' ? 'Ledger' : 'Mail'), 5);
    expect(upcoming.map((m) => [m.name, m.agent, localWhen(m.at, TZ)])).toEqual([
      ['Daily brief', 'Ledger', 'Sat 26 Sep, 08:00'],
      ['Hourly', 'Mail', 'Sat 26 Sep, 08:00'],
      ['Weekly recap', 'Ledger', 'Fri 2 Oct, 17:00'],
    ]);
  });
});

describe('/goals', () => {
  it('says each goal with its number and one word', () => {
    expect(goalsText([
      { title: 'Pay off the card', figure: '$1,240', drift: 'on track' },
      { title: 'Run three times a week', figure: '1 of 3 this week', drift: 'behind' },
    ])).toBe('Your goals:\nPay off the card: $1,240, on track\nRun three times a week: 1 of 3 this week, behind');
    expect(goalsText([])).toBe(NO_GOALS_TEXT);
  });

  const standing = (over: Partial<GoalStanding>): GoalStanding => ({
    latest: { value: 10 } as GoalStanding['latest'],
    progress: 0.5,
    paceNeeded: null,
    projected: null,
    onTrack: null,
    verdict: 'on-track',
    offTrackRuns: 0,
    milestonesCrossed: [],
    ...over,
  });

  it('words a level goal: behind, on track, ahead, not measured', () => {
    expect(levelDrift(standing({ verdict: 'off-track' }), 0.5)).toBe('behind');
    expect(levelDrift(standing({ verdict: 'on-track', progress: 0.5 }), 0.5)).toBe('on track');
    expect(levelDrift(standing({ verdict: 'on-track', progress: 0.8 }), 0.5)).toBe('ahead');
    expect(levelDrift(standing({ progress: 1 }), 0.5)).toBe('ahead');
    expect(levelDrift(standing({ latest: null, progress: null, verdict: 'not-measured' }), 0.5)).toBe('not measured');
    expect(levelDrift(standing({ verdict: 'no-projection', progress: 0.2 }), 0.5)).toBe('behind');
  });

  it('words a frequency goal from this window and the last whole one', () => {
    const goal = { target: { kind: 'frequency', count: 3, per: 'week' } } as Goal;
    const window = (count: number, closed: boolean, state: string) => ({ start: '', end: '', count, closed, state }) as FrequencyStanding['windows'][number];
    const f = (windows: FrequencyStanding['windows'], current: FrequencyStanding['current']): FrequencyStanding => ({
      windows, current, lastClosed: null, streak: 0, met: 0, short: 0, toGo: null,
    });
    expect(frequencyDrift(goal, f([window(3, false, 'met')], window(3, false, 'met')))).toBe('ahead');
    expect(frequencyDrift(goal, f([window(1, true, 'short'), window(1, false, 'open')], window(1, false, 'open')))).toBe('behind');
    expect(frequencyDrift(goal, f([window(3, true, 'met'), window(0, false, 'open')], window(0, false, 'open')))).toBe('on track');
    expect(frequencyDrift(goal, f([window(0, false, 'open')], window(0, false, 'open')))).toBe('not measured');
  });
});

describe('/where', () => {
  it('names the public origin, or says the dashboard is on this computer only', () => {
    expect(whereText('https://buddi.example.ts.net')).toBe('The dashboard: https://buddi.example.ts.net/');
    expect(whereText(undefined)).toBe(LOCAL_ONLY_TEXT);
    expect(LOCAL_ONLY_TEXT).toBe('The dashboard is on this computer only: open buddi there.');
  });
});
