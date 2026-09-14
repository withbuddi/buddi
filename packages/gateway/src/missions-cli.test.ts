import { describe, expect, it } from 'vitest';
import { parseMissionsArgs } from './missions-cli.js';
import {
  DAILY_CHECK_PROMPT,
  FRIDAY_RECAP_PROMPT,
} from '@buddi/tool-finance';
import { loadGatewayCatalog } from './agents/catalog.js';
import { planDefaultMissions } from './missions/defaults.js';
import { findingOf, renderFinding, sentinelWakeMission } from './missions/sentinel-wake.js';
import { DEFAULT_TIMEZONE, recapMissionId, timezoneFromEnv } from './missions/recap.js';

/** The plan this installation's plugins and agent files actually produce. */
const catalog = loadGatewayCatalog({ env: {} });
const plan = planDefaultMissions(catalog);
const entry = (id: string) => plan.entries.find((e) => e.mission.id === id);

describe('parseMissionsArgs', () => {
  it('reads list', () => {
    expect(parseMissionsArgs(['list'])).toEqual({ command: 'list', inline: false });
  });

  it('reads add-defaults', () => {
    expect(parseMissionsArgs(['add-defaults'])).toEqual({
      command: 'add-defaults',
      inline: false,
    });
  });

  it('reads add-friday-recap', () => {
    expect(parseMissionsArgs(['add-friday-recap'])).toEqual({
      command: 'add-friday-recap',
      inline: false,
    });
  });

  it('reads run-now with a mission id', () => {
    expect(parseMissionsArgs(['run-now', 'friday-recap'])).toEqual({
      command: 'run-now',
      missionId: 'friday-recap',
      inline: false,
    });
  });

  it('reads --inline', () => {
    expect(parseMissionsArgs(['run-now', 'friday-recap', '--inline'])).toMatchObject({
      inline: true,
    });
  });

  it('ignores the pnpm `--` separator', () => {
    expect(parseMissionsArgs(['run-now', 'friday-recap', '--', '--inline'])).toMatchObject({
      command: 'run-now',
      missionId: 'friday-recap',
      inline: true,
    });
  });

  it('reads enable and disable', () => {
    expect(parseMissionsArgs(['enable', 'x'])).toMatchObject({ command: 'enable', missionId: 'x' });
    expect(parseMissionsArgs(['disable', 'x'])).toMatchObject({
      command: 'disable',
      missionId: 'x',
    });
  });

  it('needs a mission id for run-now, enable and disable', () => {
    for (const command of ['run-now', 'enable', 'disable']) {
      expect(() => parseMissionsArgs([command])).toThrow(/needs a mission id/);
    }
  });

  it('refuses --inline outside run-now', () => {
    expect(() => parseMissionsArgs(['list', '--inline'])).toThrow(/only applies to run-now/);
  });

  it('refuses an unknown option and a stray argument', () => {
    expect(() => parseMissionsArgs(['list', '--wat'])).toThrow(/unknown option/);
    expect(() => parseMissionsArgs(['run-now', 'a', 'b'])).toThrow(/unexpected argument/);
  });

  it('falls back to help', () => {
    expect(parseMissionsArgs([]).command).toBe('help');
    expect(parseMissionsArgs(['nope']).command).toBe('help');
  });
});

describe('the recap mission', () => {
  it('comes from the plugin that knows what a recap is', () => {
    expect(recapMissionId()).toBe('friday-recap');
    expect(entry('friday-recap')?.mission).toMatchObject({
      id: 'friday-recap',
      agentId: 'finance-advisor',
      enabled: true,
      alwaysDeliver: true,
    });
  });

  it('asks for every section of the recap', () => {
    for (const needle of ['net worth', '14 days', '60-day projection', 'safety floor', '1500']) {
      expect(FRIDAY_RECAP_PROMPT).toContain(needle);
    }
  });

  it('takes the timezone from BUDDI_TZ, else New York', () => {
    expect(timezoneFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TIMEZONE);
    expect(timezoneFromEnv({ BUDDI_TZ: '  ' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TIMEZONE);
    expect(timezoneFromEnv({ BUDDI_TZ: 'Europe/Paris' } as NodeJS.ProcessEnv)).toBe(
      'Europe/Paris',
    );
  });
});

describe('the default missions', () => {
  it('registers what the plugins suggest, then the wake mission', () => {
    expect(plan.entries.map((d) => d.mission.id)).toEqual([
      'friday-recap',
      'daily-check',
      'weekly-consolidation',
      'sentinel-wake',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('resolves every suggested mission through a role, not an agent name', () => {
    for (const id of ['friday-recap', 'daily-check', 'weekly-consolidation']) {
      expect(entry(id)?.mission.agentId).toBe('finance-advisor');
    }
  });

  it('gives only the recap an unconditional delivery', () => {
    const alwaysDeliver = plan.entries.filter((d) => d.mission.alwaysDeliver);
    expect(alwaysDeliver.map((d) => d.mission.id)).toEqual(['friday-recap']);
  });

  it('gives the wake mission no schedule — it is enqueued, never cron-ed', () => {
    const wake = entry('sentinel-wake');
    expect(wake?.cron).toBeUndefined();
    expect(wake?.mission.prompt).toContain('mission.silent');
  });

  it('points the wake mission at the overview role holder', () => {
    expect(sentinelWakeMission(catalog).agentId).toBe('finance-advisor');
  });

  it('runs the daily check at 08:00 and tells it to stay silent', () => {
    const daily = entry('daily-check');
    expect(daily?.cron).toBe('0 8 * * *');
    expect(daily?.misfirePolicy).toBe('coalesce');
    for (const needle of ['projection', 'next 3 days', 'unmatched', 'mission.silent', '7 days']) {
      expect(DAILY_CHECK_PROMPT).toContain(needle);
    }
  });

  it('ships the consolidation placeholder disabled', () => {
    expect(entry('weekly-consolidation')?.mission.enabled).toBe(false);
  });
});

describe('a wake payload', () => {
  it('reads a finding out of an occurrence payload and renders it', () => {
    const finding = findingOf({
      finding: {
        key: 'k',
        sentinelId: 'finance.cashflow',
        severity: 'urgent',
        title: 'Floor breaks',
        detail: 'on 2026-10-02',
        data: { minimum: 120 },
      },
    });
    expect(finding?.key).toBe('k');
    const rendered = renderFinding(finding!);
    expect(rendered).toContain('finance.cashflow');
    expect(rendered).toContain('Floor breaks');
    expect(rendered).toContain('"minimum":120');
  });

  it('is null for a cron occurrence and for junk', () => {
    expect(findingOf(null)).toBeNull();
    expect(findingOf({})).toBeNull();
    expect(findingOf({ finding: { title: 'no key' } })).toBeNull();
  });
});
