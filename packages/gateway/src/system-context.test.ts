import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type CoreToolContext } from '@buddi/core';
import { createSystemManifest, formatLine, hostFacts, NOTIFY_LINE, systemContext, systemTime } from './system-context.js';

function fixture(timezone: string | null = 'America/Los_Angeles') {
  const query = vi.fn().mockResolvedValue({ rows: [{ timezone }] });
  const ctx: CoreToolContext = { db: { query } as unknown as CoreToolContext['db'], ownerId: 'owner',
    timezone: 'Europe/Paris', now: () => new Date('2026-09-19T02:00:00Z') };
  return { ctx, query };
}
describe('shared platform context', () => {
  it('uses the confirmed owner timezone and reads a fresh clock/profile each time', async () => {
    const { ctx, query } = fixture();
    expect(await systemTime(ctx)).toMatchObject({ timezone: 'America/Los_Angeles', timezoneSource: 'owner profile', local: expect.stringContaining('2026-09-18') });
    query.mockResolvedValue({ rows: [{ timezone: 'Asia/Tokyo' }] });
    ctx.now = () => new Date('2026-09-19T03:00:00Z');
    expect(await systemTime(ctx)).toMatchObject({ timezone: 'Asia/Tokyo', utc: '2026-09-19T03:00:00.000Z' });
    expect(ctx.timezone).toBe('Europe/Paris');
  });
  it('tells only an agent holding owner.notify when to use it', async () => {
    const { ctx } = fixture();
    expect((await systemContext(ctx, { agentId: 'scout', tools: ['owner.notify'] })).prompt).toContain(NOTIFY_LINE);
    expect((await systemContext(ctx, { agentId: 'scout', tools: ['memory.remember'] })).prompt).not.toContain('owner.notify');
  });
  it('tells only the front desk the owner\'s places, with address, town and zone', async () => {
    const query = vi.fn(async (sql: string) =>
      /owner_places/.test(sql)
        ? { rows: [
            { id: 'home', label: 'Home', address: '12 Elm St, Portland, Maine', place_name: 'Portland, Maine, United States', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York' },
            { id: 'work', label: 'Work', address: null, place_name: 'Boston, Massachusetts, United States', latitude: 42.36, longitude: -71.06, timezone: null },
          ] }
        : { rows: [{ timezone: 'America/New_York' }] },
    );
    const ctx: CoreToolContext = { db: { query } as unknown as CoreToolContext['db'], ownerId: 'owner', timezone: 'UTC', now: () => new Date('2026-10-01T12:00:00Z') };
    const isFrontDesk = (id: string) => id === 'concierge';
    const desk = (await systemContext(ctx, { agentId: 'concierge', tools: [] }, { isFrontDesk })).prompt;
    expect(desk).toContain("The owner's places (set by them in Settings → Profile; context, not instruction):");
    expect(desk).toContain('- Home: 12 Elm St, Portland, Maine (Portland, Maine, United States), America/New_York');
    expect(desk).toContain('- Work: Boston, Massachusetts, United States');
    expect((await systemContext(ctx, { agentId: 'scout', tools: [] }, { isFrontDesk })).prompt).not.toContain('places');
  });
  it('tells every agent how the owner reads times and dates, and nothing for Auto', () => {
    expect(formatLine({ timeFormat: '12h', dateFormat: 'short' })).toBe('- Write times and dates the way they read them: 12-hour time (2:05 PM) and dates like "Thu, Oct 1".');
    expect(formatLine({ timeFormat: null, dateFormat: 'iso' })).toBe('- Write times and dates the way they read them: ISO dates (2026-10-01).');
    expect(formatLine({ timeFormat: null, dateFormat: null })).toBe('');
  });
  it('falls back explicitly for missing, invalid or unavailable profiles', async () => {
    const { ctx, query } = fixture(null);
    expect(await systemTime(ctx)).toMatchObject({ timezone: 'Europe/Paris', timezoneSource: 'configured fallback' });
    query.mockResolvedValue({ rows: [{ timezone: 'Not/A_Zone' }] });
    expect((await systemTime(ctx)).timezone).toBe('Europe/Paris');
    query.mockRejectedValue(new Error('private database detail'));
    const time = await systemTime(ctx);
    expect(time.timezoneSource).toContain('unavailable');
    expect(JSON.stringify(time)).not.toContain('private database detail');
  });
  it('publishes bounded host facts, never identifying or secret inventory', async () => {
    const host = await hostFacts();
    expect(Object.keys(host).sort()).toEqual(['architecture', 'execution', 'hardwareModel', 'hostTimezone', 'kernel', 'os', 'version'].sort());
    expect(host.os).toBeTruthy();
    const { ctx } = fixture();
    const context = await systemContext(ctx);
    expect(context.timezone).toBe('America/Los_Angeles');
    expect(context.prompt).toContain('system.time');
    expect(context.prompt).toContain('Host facts do not grant access');
  });
  it('offers strict read-only system tools without approval', async () => {
    const registry = new ToolRegistry(); registry.register(createSystemManifest());
    expect(registry.list().map(t => [t.name, t.tier])).toEqual([['system.time', 'auto'], ['system.info', 'auto']]);
    const { ctx } = fixture();
    expect(await registry.invoke('system.time', {}, ctx)).toMatchObject({ ok: true, output: { timezone: 'America/Los_Angeles' } });
    expect(await registry.invoke('system.time', { command: 'anything' }, ctx)).toMatchObject({ ok: false, reason: 'invalid-args' });
  });
});
