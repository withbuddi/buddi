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
  ownerPresent,
  pairSurfaceIdentity,
  registerChannel,
  type ActionRecord,
  type Offer,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { notifyApproval, ownerDeliver, ownerText, splitOwnerText } from './owner-notify.js';
import { createTelegramChannel, ownerMessageText } from './telegram/channel.js';
import { OwnerNotPairedError } from './telegram/notify.js';
import { listNotificationsRoute, markSeenRoute, notificationSettingsRoute, presenceRoute } from './web/notifications.js';

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

  it('describes Telegram with the bot it runs as', () => {
    const channel = createTelegramChannel({ pool, botUsername: () => 'buddi_test_bot' });
    expect(channel.describe()).toEqual({ label: 'Telegram', where: '@buddi_test_bot' });
    expect(ownerMessageText({ title: 'One line' })).toBe('One line');
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
      settings: { defaultChannel: null, endOfDay: '18:00', quietStart: null },
      channels: [{ kind: 'telegram.chat', label: 'Telegram', where: '@buddi_test_bot' }],
    });
    const put = await notificationSettingsRoute(pool, 'PUT', {
      defaultChannel: 'telegram.chat',
      perKind: { watcher: 'off', recap: 'default' },
      quietStart: '22:00',
      quietEnd: '07:00',
      endOfDay: '17:30',
    });
    expect(put.body).toMatchObject({
      settings: { defaultChannel: 'telegram.chat', perKind: { watcher: 'off' }, quietStart: '22:00', quietEnd: '07:00', endOfDay: '17:30' },
    });
    expect(await notificationSettingsRoute(pool, 'PUT', { perKind: { approval: 'off' } })).toEqual({
      status: 400,
      body: { error: 'Approvals and questions cannot be turned off.' },
    });
    expect((await notificationSettingsRoute(pool, 'PUT', { quietStart: '22:00' })).status).toBe(400);
  });

  it('splits a report into a title and a body', () => {
    expect(splitOwnerText('One')).toEqual({ title: 'One' });
    expect(splitOwnerText('One\n\nTwo\nThree')).toEqual({ title: 'One', text: 'Two\nThree' });
  });
});
