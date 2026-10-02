/**
 * The gateway's callers on core's `notifyOwner`, and Telegram as the channel,
 * against real Postgres (docs/notifications.md).
 *
 * The rules under test: an approval arrives on Telegram as the card with its
 * bound buttons, not as text; a report keeps its offers as buttons; with no
 * channel nothing throws and the row says why; deciding an approval marks its
 * row acted; the dashboard's endpoints read and write what slice 2 will need.
 *
 * The database is created by this suite, named after this process, and
 * dropped again: the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clearChannels,
  createAction,
  createPool,
  decideApproval,
  listNotifications,
  migrateCore,
  notificationsTick,
  notifyOwner,
  setFocus,
  ownerPresent,
  pairSurfaceIdentity,
  registerChannel,
  ToolRegistry,
  type ActionRecord,
  type CoreToolContext,
  type Offer,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { notifyApproval, ownerDeliver, ownerText, splitOwnerText } from './owner-notify.js';
import { bindOwnerTools, createOwnerManifest, interactiveTurn, NOTIFY_TOOL } from './agents/owner-tools.js';
import type { AgentCatalog } from './telegram/types.js';
import { createTelegramChannel, ownerMessageText } from './telegram/channel.js';
import { OwnerNotPairedError } from './telegram/notify.js';
import { agentMuteRoute, focusRoute, listNotificationsRoute, markSeenRoute, notificationSettingsRoute, presenceRoute } from './web/notifications.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_owner_notify_${process.pid}`;
const NOW = new Date('2026-09-14T14:00:00.000Z');

function urlFor(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

suite('reaching the owner from the gateway', () => {
  let admin: Pool;
  let pool: Pool;
  const deps = { now: () => NOW, timezone: 'America/New_York' };

  interface Sent { text: string; offers?: readonly Offer[] }
  const telegram = () => {
    const cards: Array<{ chatId: string; action: ActionRecord }> = [];
    const texts: Sent[] = [];
    registerChannel(createTelegramChannel({
      pool,
      botUsername: () => 'buddi_test_bot',
      approvals: () => ({ async request(chatId, action) { cards.push({ chatId, action }); return 1; } }),
      sendText: async (text, opts) => {
        texts.push({ text, ...(opts?.offers ? { offers: opts.offers } : {}) });
        return '777';
      },
    }));
    return { cards, texts };
  };

  beforeAll(async () => {
    admin = createPool(urlFor(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlFor(databaseUrl as string, DB));
    await migrateCore(pool);
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: '777', externalChatId: '777' });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  afterEach(async () => {
    clearChannels();
    await pool.query('truncate core.owner_notifications, core.owner_presence, core.notification_settings');
  });

  it('sends an approval to Telegram as the card, and deciding it marks the row acted', async () => {
    const { cards, texts } = telegram();
    const action = await createAction(pool, {
      tool: 'mail.send',
      toolVersion: '1.0.0',
      agentId: 'postman',
      canonicalArgs: { to: 'a@b.c' },
      envelope: { to: ['a@b.c'] },
      preview: 'Send "Hi" to a@b.c',
    });
    const result = await notifyApproval(pool, deps, action);
    expect(result).toMatchObject({ state: 'sent', channel: 'telegram.chat' });
    expect(texts).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.chatId).toBe('777');
    expect(cards[0]?.action.id).toBe(action.id);

    await decideApproval(pool, { actionId: action.id, decision: 'approved', by: 'owner', via: 'web' });
    const [row] = await listNotifications(pool);
    expect(row).toMatchObject({ kind: 'approval', actionId: action.id });
    expect(row?.actedAt).not.toBeNull();
  });

  it('delivers a report as text with its offers, under the kind its origin says', async () => {
    const { texts } = telegram();
    const offers = [{ id: 'o1', label: 'Send it' }] as unknown as Offer[];
    const deliver = ownerDeliver(pool, deps);
    expect(await deliver('Rent is due\nPay 1,200 by Friday.', offers, { agentId: 'ledger', origin: 'mission' })).toBe('telegram.chat');
    expect(texts[0]).toEqual({ text: 'Rent is due\n\nPay 1,200 by Friday.', offers });
    await deliver('Call the bank', undefined, { agentId: 'ledger', origin: 'reminder', dedupeKey: 'reminder:r1' });
    const rows = await listNotifications(pool);
    expect(rows.map((r) => [r.kind, r.urgency, r.dedupeKey]).sort()).toEqual([
      ['recap', 'now', null],
      ['reminder', 'now', 'reminder:r1'],
    ]);
  });

  it('holds a wake line for the end of the day when its finding asked for today', async () => {
    const { texts } = telegram();
    const deliver = ownerDeliver(pool, deps);
    await deliver('You have not told me your weight this week.', undefined, {
      agentId: 'coach',
      origin: 'wake',
      dedupeKey: 'goal:g-1:stale:2026-09-29',
      notifyUrgency: 'today',
    });
    expect(texts).toHaveLength(0);
    const rows = await listNotifications(pool);
    expect(rows.map((r) => [r.kind, r.urgency, r.state, r.dedupeKey])).toEqual([
      ['watcher', 'today', 'held', 'goal:g-1:stale:2026-09-29'],
    ]);
  });

  it('describes Telegram with the bot it runs as', () => {
    const channel = createTelegramChannel({ pool, botUsername: () => 'buddi_test_bot' });
    expect(channel.describe()).toEqual({ label: 'Telegram', where: '@buddi_test_bot' });
    expect(ownerMessageText({ title: 'One line' })).toBe('One line');
    // What a message asks the owner to do is said last, on its own line.
    expect(ownerMessageText({ title: 'Charged twice', text: 'At Monoprix.', action: 'Confirm with the bank?' })).toBe('Charged twice\n\nAt Monoprix.\n\n→ Confirm with the bank?');
    expect(ownerMessageText({
      title: 'Today, 2 things:',
      text: '- finance: Charged twice\n- finance: Rain later',
      parts: [{ title: 'Charged twice', action: ' Confirm with the bank? ' }, { title: 'Rain later' }],
    })).toBe('Today, 2 things:\n\n- finance: Charged twice\n- finance: Rain later\n\n→ Charged twice: Confirm with the bank?');
  });

  it('says each part\'s action in a batch: the end of the day and the end of a focus', async () => {
    const { texts } = telegram();
    // Held for the end of the day (18:00 New York; NOW is 10:00 there).
    await notifyOwner(pool, deps, { kind: 'plugin', pluginId: 'finance', urgency: 'today', title: 'Charged twice', action: 'Confirm with the bank?' });
    await notifyOwner(pool, deps, { kind: 'plugin', pluginId: 'finance', urgency: 'today', title: 'Rain later' });
    expect(texts).toHaveLength(0);
    await notificationsTick(pool, deps, new Date('2026-09-14T22:30:00.000Z'));
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('→ Charged twice: Confirm with the bank?');
    expect(texts[0]!.text).not.toContain('→ Rain later');

    // Held by Do not disturb, said when it ends.
    texts.length = 0;
    await setFocus(pool, deps, { mode: 'do-not-disturb', duration: 'indefinite', by: 'dashboard' });
    await notifyOwner(pool, deps, { kind: 'plugin', pluginId: 'finance', urgency: 'now', title: 'Rent went up', action: 'Approve the new amount?' });
    expect(texts).toHaveLength(0);
    await setFocus(pool, deps, { mode: 'normal', by: 'dashboard' });
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('→ Rent went up: Approve the new amount?');
  });

  it('keeps the message and throws nothing when there is no channel, unless asked to be strict', async () => {
    const failure = ownerText(pool, deps, { kind: 'failure', dedupeKey: 'dead-letter' });
    expect(await failure('Three jobs died')).toBe('failed');
    const [row] = await listNotifications(pool);
    expect(row).toMatchObject({ kind: 'failure', state: 'failed', error: 'no channel' });

    const strict = ownerDeliver(pool, { ...deps, strict: true });
    await expect(strict('Report', undefined, { origin: 'mission' })).rejects.toBeInstanceOf(OwnerNotPairedError);
  });

  it('shows a message on the dashboard while the page says the owner is there', async () => {
    const { texts } = telegram();
    expect(await presenceRoute(pool, { state: 'active' }, NOW)).toEqual({ status: 200, body: { ok: true } });
    expect(await ownerPresent(pool, NOW)).toBe(true);
    expect(await ownerDeliver(pool, deps)('Rent is due', undefined, { origin: 'wake' })).toBe('dashboard');
    expect(texts).toEqual([]);

    const list = await listNotificationsRoute(pool, '5');
    const [row] = (list.body as { notifications: Array<{ id: string; kind: string; state: string }> }).notifications;
    expect(row).toMatchObject({ kind: 'watcher', state: 'shown' });
    expect((await markSeenRoute(pool, row!.id, NOW)).status).toBe(200);
    expect((await markSeenRoute(pool, '00000000-0000-4000-8000-000000000000', NOW)).status).toBe(404);

    expect(await presenceRoute(pool, { state: 'away' }, new Date(NOW.getTime() + 1000))).toMatchObject({ status: 200 });
    expect(await ownerPresent(pool, new Date(NOW.getTime() + 2000))).toBe(false);
    expect((await presenceRoute(pool, { state: 'here' }, NOW)).status).toBe(400);
  });

  it('reads and replaces the settings, and refuses what cannot be', async () => {
    telegram();
    const read = await notificationSettingsRoute(pool, 'GET');
    expect(read.body).toMatchObject({
      settings: { defaultChannel: null, endOfDay: '18:00', schedules: [], focus: null, agents: { maxUrgency: 'now', muted: [] } },
      channels: [{ kind: 'telegram.chat', label: 'Telegram', where: '@buddi_test_bot' }],
    });
    const night = { mode: 'do-not-disturb', days: ['mon', 'tue'], from: '22:00', to: '07:00' };
    const put = await notificationSettingsRoute(pool, 'PUT', {
      defaultChannel: 'telegram.chat',
      perKind: { watcher: 'off', recap: 'default' },
      schedules: [night],
      endOfDay: '17:30',
    });
    expect(put.body).toMatchObject({
      settings: { defaultChannel: 'telegram.chat', perKind: { watcher: 'off' }, schedules: [night], endOfDay: '17:30' },
    });
    expect(await notificationSettingsRoute(pool, 'PUT', { perKind: { approval: 'off' } })).toEqual({
      status: 400,
      body: { error: 'Approvals and questions cannot be turned off.' },
    });
    expect((await notificationSettingsRoute(pool, 'PUT', { schedules: [{ ...night, days: [] }] })).status).toBe(400);
  });

  it('reads and switches the focus', async () => {
    const deps = { now: () => NOW, timezone: 'America/New_York' };
    expect(await focusRoute(pool, deps, 'GET')).toEqual({ status: 200, body: { focus: null } });
    const on = await focusRoute(pool, deps, 'PUT', { mode: 'do-not-disturb', duration: '3h' });
    expect(on.body).toMatchObject({ focus: { mode: 'do-not-disturb', until: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(), by: 'dashboard' } });
    expect((await focusRoute(pool, deps, 'GET')).body).toMatchObject({ focus: { mode: 'do-not-disturb' } });
    expect((await focusRoute(pool, deps, 'PUT', { mode: 'loud' })).status).toBe(400);
    expect((await focusRoute(pool, deps, 'PUT', { mode: 'urgent-only', duration: 'soon' })).status).toBe(400);
    expect(await focusRoute(pool, deps, 'PUT', { mode: 'normal' })).toEqual({ status: 200, body: { focus: null } });
  });

  describe('owner.notify, the tool', () => {
    const registry = new ToolRegistry();
    const tool = createOwnerManifest(registry).tools.find((t) => t.name === NOTIFY_TOOL)!;
    bindOwnerTools(registry, { catalog: { get: (id: string) => (id === 'scout-7' ? { handle: 'scout' } : undefined) } as unknown as AgentCatalog });
    const base = (): CoreToolContext => ({
      db: pool,
      ownerId: 'owner',
      now: () => NOW,
      timezone: 'America/New_York',
      agentId: 'scout-7',
      conversationId: 'c-1',
    }) as unknown as CoreToolContext;
    const chatTurn = (): CoreToolContext => ({ ...base(), ownerRequest: { id: 'r1', text: 'send it to my phone', expiresAt: Date.now() + 60_000 } });
    const run = async (input: Record<string, unknown>, ctx: CoreToolContext) =>
      (await tool.execute(input as never, ctx)) as { ok: boolean; delivered: string; reason?: string };

    it('tells an interactive turn from a mission and a delegate', () => {
      expect(interactiveTurn(chatTurn())).toBe(true);
      expect(interactiveTurn(base())).toBe(false);
      expect(interactiveTurn({ ...chatTurn(), delegationDepth: 1 })).toBe(false);
      expect(interactiveTurn({ ...chatTurn(), ownerRequest: { id: 'r', text: 'x', expiresAt: Date.now() - 1 } })).toBe(false);
    });

    it('in a chat turn, goes to Telegram at once though the owner is on the dashboard, as "@handle: title", plain', async () => {
      const { texts, cards } = telegram();
      await presenceRoute(pool, { state: 'active' }, NOW);
      const result = await run({ title: 'Your parcel arrived', text: 'Signed by [the bank](https://evil.example).', link: '#/chat/scout-7/c-1' }, chatTurn());
      expect(result).toEqual({ ok: true, delivered: 'sent to Telegram' });
      expect(texts).toEqual([{ text: '@\u2060scout: Your parcel arrived\n\nSigned by [the bank](https://evil.example).' }]);
      expect(cards).toEqual([]);
    });

    it('with an action, asks the owner on Telegram and waits in Needs you; without one it is information', async () => {
      const { texts } = telegram();
      expect(await run({ title: 'Charged twice at Monoprix', action: 'Confirm with the bank?' }, chatTurn())).toEqual({ ok: true, delivered: 'sent to Telegram' });
      expect(await run({ title: 'The parcel was delivered' }, chatTurn())).toEqual({ ok: true, delivered: 'sent to Telegram' });
      expect(texts.map((t: { text: string }) => t.text)).toEqual([
        '@\u2060scout: Charged twice at Monoprix\n\n→ Confirm with the bank?',
        '@\u2060scout: The parcel was delivered',
      ]);
      const listed = (await listNotificationsRoute(pool, null)).body as { notifications: Array<{ title: string; needsOwner: boolean }> };
      expect(listed.notifications.map((n) => [n.title, n.needsOwner]).sort()).toEqual([
        ['@scout: Charged twice at Monoprix', true],
        ['@scout: The parcel was delivered', false],
      ]);
      const needs = (await listNotificationsRoute(pool, null, { needs: true })).body as { notifications: Array<{ action: string }> };
      expect(needs.notifications.map((n) => n.action)).toEqual(['Confirm with the bank?']);
      const input = tool.input as { safeParse(v: unknown): { success: boolean } };
      expect(input.safeParse({ title: 'x', action: 'y'.repeat(81) }).success).toBe(false);
    });

    it('in a mission, keeps the dashboard hold', async () => {
      const { texts } = telegram();
      await presenceRoute(pool, { state: 'active' }, NOW);
      const result = await run({ title: 'Your parcel arrived' }, base());
      expect(result.delivered).toBe('shown on the dashboard, and sent to Telegram if unseen in 10 minutes');
      expect(texts).toEqual([]);
    });

    it('refuses an outside link and a muted agent, and checks its input', async () => {
      telegram();
      expect(await run({ title: 'Look', link: 'https://evil.example' }, chatTurn())).toMatchObject({ ok: false, reason: 'invalid-link' });
      expect(await agentMuteRoute(pool, { agentId: 'scout-7', muted: true })).toEqual({ status: 200, body: { agents: { maxUrgency: 'now', muted: ['scout-7'] } } });
      expect(await run({ title: 'Look' }, chatTurn())).toMatchObject({ ok: false, reason: 'muted', delivered: expect.stringMatching(/^refused: the owner has muted messages from @scout/) });
      expect((await agentMuteRoute(pool, { agentId: 'scout-7' })).status).toBe(400);
      const input = tool.input as { safeParse(v: unknown): { success: boolean } };
      expect(input.safeParse({ title: 'x'.repeat(81) }).success).toBe(false);
      expect(input.safeParse({ title: 'ok', text: 'x'.repeat(1001) }).success).toBe(false);
      expect(input.safeParse({ title: 'ok', urgency: 'digest' }).success).toBe(false);
      expect(tool.tier).toBe('auto');
    });
  });

  it('splits a report into a title and a body', () => {
    expect(splitOwnerText('One')).toEqual({ title: 'One' });
    expect(splitOwnerText('One\n\nTwo\nThree')).toEqual({ title: 'One', text: 'Two\nThree' });
  });
});
