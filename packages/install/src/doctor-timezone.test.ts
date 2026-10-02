import { describe, expect, test } from 'vitest';
import { readProfileZone, timezoneLine } from './doctor-timezone.js';

describe('the timezone line of a packaged doctor', () => {
  test('names the zone and where it comes from: the Profile, BUDDI_TZ, or the default', async () => {
    expect(await timezoneLine(async () => 'Europe/Lisbon', { BUDDI_TZ: 'America/Chicago' })).toMatch(/^Timezone: Europe\/Lisbon \(Settings → Profile/);
    expect(await timezoneLine(async () => null, { BUDDI_TZ: 'America/Chicago' })).toMatch(/^Timezone: America\/Chicago \(BUDDI_TZ — set one in Settings → Profile/);
    expect(await timezoneLine(async () => null, {})).toMatch(/^Timezone: America\/New_York \(default — set one in Settings → Profile/);
  });

  test('a database that cannot be read still prints the line, and says the Profile was not read', async () => {
    const line = await timezoneLine(async () => { throw new Error('connection refused'); }, { BUDDI_TZ: 'Asia/Tokyo' });
    expect(line).toMatch(/^Timezone: Asia\/Tokyo \(BUDDI_TZ/);
    expect(line).toContain('Settings → Profile not read');
    const down = await timezoneLine(readProfileZone({ env: { DATABASE_URL: 'postgres://x@127.0.0.1:1/x' } }), {});
    expect(down).toMatch(/^Timezone: America\/New_York/);
  });
});
