import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type CoreToolContext } from '@buddi/core';
import { birthdayLine, createSystemManifest, DECISION_LINES, GROUNDING_LINES, formatLine, hostFacts, LIST_ANSWER_LINE, NOTIFY_LINE, ownerLines, resourcefulLines, systemContext, systemTime } from './system-context.js';

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
  it('tells every agent to try what it can reach before declining, worded for the tools it holds', async () => {
    const { ctx } = fixture();
    const full = resourcefulLines(['browser.status', 'browser.act', 'secret.list', 'secret.fill', 'agent.delegate']);
    expect(full).toMatch(/^Before you say you cannot do something/);
    expect(full).toContain('look with browser.act; buddi picks the browser');
    expect(full).toContain('secret.list, then secret.fill');
    expect(full).toContain('asks the owner once with a card');
    expect(full).not.toMatch(/read browser\.status|mode/);
    expect(full).toContain('delegate it and relay the answer');
    expect(full).toContain('Never tell the owner to open the app or site themselves');
    // No secrets: the owner is asked once with a card.
    const noSecrets = resourcefulLines(['browser.status', 'browser.act']);
    expect(noSecrets).not.toContain('secret.');
    expect(noSecrets).toContain('asks the owner once with a card when a page needs their sign-in');
    expect(noSecrets).not.toContain('delegate');
    // No browser.act: never told to use it, told what to ask for instead.
    const bare = resourcefulLines(['browser.status', 'memory.recall']);
    expect(bare).not.toContain('browser.act');
    expect(bare).toContain('you cannot open a browser');
    expect(bare).toContain('your agent page, Tools');
    expect(bare).toContain('one concrete next step');
    expect(bare).not.toContain('open the app or site themselves');
    expect((await systemContext(ctx, { agentId: 'home', tools: ['browser.act'] })).prompt).toContain('look with browser.act');
    expect((await systemContext(ctx)).prompt).not.toContain('Before you say you cannot');
  });
  it('tells an agent with the browser to answer lists of items as a short list, not a table', async () => {
    const { ctx } = fixture();
    expect(LIST_ANSWER_LINE).toBe('Lists of items (cart, orders, results) go as a short list, one line per item with name · price · one fact; tables only when the owner asks for a comparison.');
    expect((await systemContext(ctx, { agentId: 'shopper', tools: ['browser.act'] })).prompt).toContain(LIST_ANSWER_LINE);
    expect((await systemContext(ctx, { agentId: 'scout', tools: ['memory.recall'] })).prompt).not.toContain(LIST_ANSWER_LINE);
  });
  it('tells every run to take a single option, ask a few as choices, and state its defaults', async () => {
    const { ctx } = fixture();
    expect(DECISION_LINES).toContain('Exactly one valid option');
    expect(DECISION_LINES).toContain('ask with conversation.ask and those options');
    expect(DECISION_LINES).toContain('2–6');
    expect(DECISION_LINES).toContain('an evening dinner lasts 2 hours');
    expect((await systemContext(ctx, { agentId: 'scout', tools: [] })).prompt).toContain(DECISION_LINES);
    expect((await systemContext(ctx)).prompt).not.toContain('Exactly one valid option');
  });
  it('tells every run to read, never recall: the news, mail, money, sources it did not read', async () => {
    const { ctx } = fixture();
    expect(GROUNDING_LINES).toMatch(/^Read, never recall:/);
    expect(GROUNDING_LINES).toContain('Today, the news, mail, calendar, money, prices');
    expect(GROUNDING_LINES).toContain('never answer from memory. Read it or delegate it.');
    expect(GROUNDING_LINES).toContain('Never name a source, figure or quote you did not read in this conversation');
    expect(GROUNDING_LINES).toContain('say so in one line');
    // A few lines, not a paragraph.
    expect(GROUNDING_LINES.split('\n')).toHaveLength(4);
    const prompt = (await systemContext(ctx, { agentId: 'concierge', tools: [] })).prompt;
    expect(prompt).toContain(GROUNDING_LINES);
    // Beside the try-first rule, before the decide-or-ask one.
    expect(prompt.indexOf('Before you say you cannot')).toBeLessThan(prompt.indexOf('Read, never recall'));
    expect(prompt.indexOf('Read, never recall')).toBeLessThan(prompt.indexOf('When a step needs a choice'));
    expect((await systemContext(ctx)).prompt).not.toContain('Read, never recall');
  });
  it('adds no edition line when the turn carries no message, and none when no edition matches', async () => {
    const { ctx, query } = fixture();
    await systemContext(ctx, { agentId: 'concierge', tools: [] });
    expect(query.mock.calls.some(([sql]) => /mission\.delivered/.test(String(sql)))).toBe(false);
    const prompt = (await systemContext(ctx, { agentId: 'concierge', tools: [], message: 'tell me about the housing bills in Spain' })).prompt;
    expect(prompt).not.toContain("today's edition");
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
  it('tells every agent who the owner is: full name, pronouns and the birthday, today said as today', async () => {
    const row = { preferred_name: 'Amen', full_name: 'Amenophis Mouzou', pronouns: 'he/him', birthday_day: 2, birthday_month: 10, birthday_year: 1990, timezone: 'Europe/Paris' };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const at = (iso: string): CoreToolContext => ({ db: { query } as unknown as CoreToolContext['db'], ownerId: 'owner', timezone: 'Europe/Paris', now: () => new Date(iso) });
    const lines = await ownerLines(at('2026-10-01T23:30:00Z'));
    expect(lines).toContain('- Call them Amen.');
    expect(lines).toContain('- Full name: Amenophis Mouzou (for letters, forms and bookings).');
    expect(lines).toContain('- Pronouns: he/him.');
    // 01:30 on the 2nd in Paris: the owner's day, not UTC's.
    expect(lines).toContain('- Birthday: 2 October 1990. Today is their birthday (36).');
    expect(birthdayLine({ day: 2, month: 10, year: null }, at('2026-09-28T12:00:00Z'))).toBe('- Birthday: 2 October. It is in 4 days.');
    expect(birthdayLine({ day: 2, month: 10, year: null }, at('2026-06-01T12:00:00Z'))).toBe('- Birthday: 2 October.');
    expect(birthdayLine(null, at('2026-06-01T12:00:00Z'))).toBe('');
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
