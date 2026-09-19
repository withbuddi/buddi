import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type ToolContext } from '@buddi/core';
import { createSystemManifest, hostFacts, systemContext, systemTime } from './system-context.js';

function fixture(timezone: string | null = 'America/Los_Angeles') {
  const query = vi.fn().mockResolvedValue({ rows: [{ timezone }] });
  const ctx: ToolContext = { db: { query } as unknown as ToolContext['db'], ownerId: 'owner',
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
