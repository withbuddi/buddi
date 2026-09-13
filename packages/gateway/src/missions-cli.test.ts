import { describe, expect, it } from 'vitest';
import { parseMissionsArgs } from './missions-cli.js';
import {
  DEFAULT_TIMEZONE,
  FRIDAY_RECAP_MISSION,
  FRIDAY_RECAP_PROMPT,
  timezoneFromEnv,
} from './missions/recap.js';

describe('parseMissionsArgs', () => {
  it('reads list', () => {
    expect(parseMissionsArgs(['list'])).toEqual({ command: 'list', inline: false });
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

describe('the Friday recap mission', () => {
  it('is pinned to the finance advisor', () => {
    expect(FRIDAY_RECAP_MISSION).toMatchObject({
      id: 'friday-recap',
      agentId: 'finance-advisor',
      enabled: true,
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
