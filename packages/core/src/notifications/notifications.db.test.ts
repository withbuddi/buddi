/**
 * Reaching the owner, against real Postgres with a fake clock and a fake
 * channel: where each urgency goes, present and away, the escalation, the end
 * of the day, dedupe, the rate rule, quiet hours, and nowhere to go.
 *
 * The database is created by this suite, named after this process, and
 * dropped again: the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { urlForDatabase } from '../backup/restore.js';
import { createPool, migrateCore } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { clearChannels, registerChannel } from './channels.js';
import { LOWERED_SENTENCE, notificationsTick, notifyOwner } from './notify.js';
import {
  listDigestNotifications,
  listNotifications,
  markActed,
  markSeen,
  ownerPresent,
  presenceTouch,
  writeNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
} from './store.js';
import type { DeliverableMessage, NotifyDeps } from './types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_notifications_${process.pid}`;

// 10:00 in New York (EDT).
const T0 = new Date('2026-09-14T14:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

suite('reaching the owner', () => {
  let admin: Pool;
  let pool: Pool;
  let sent: DeliverableMessage[];
  let clock: Date;
  const deps: NotifyDeps = { now: () => clock, timezone: 'America/New_York' };

  const fakeChannel = (answer: 'ok' | 'refused' | 'throw' = 'ok') =>
    registerChannel({
      kind: 'fake.chat',
      describe: () => ({ label: 'Fake' }),
      can: { offers: true, attachments: false, markdown: false },
      async deliver(message) {
        if (answer === 'throw') throw new Error('the fake is down');
        if (answer === 'refused') return 'refused';
        sent.push(message);
        return { id: `m${sent.length}` };
      },
    });

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  beforeEach(() => {
    sent = [];
    clock = T0;
  });

  afterEach(async () => {
    clearChannels();
    await pool.query('truncate core.owner_notifications, core.owner_presence, core.notification_settings');
  });

  it('shows a now message on the dashboard while the owner is there, and escalates it unseen after ten minutes', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    expect(await ownerPresent(pool, T0)).toBe(true);
    const result = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Rent is due', agentId: 'ledger' });
    expect(result).toMatchObject({ state: 'shown', channel: 'dashboard' });
    expect(sent).toHaveLength(0);

    clock = minutes(9);
    await notificationsTick(pool, deps, clock);
    expect(sent).toHaveLength(0);

    clock = minutes(10);
    expect(await notificationsTick(pool, deps, clock)).toMatchObject({ escalated: 1 });
    expect(sent.map((m) => m.title)).toEqual(['Rent is due']);
    const [row] = await listNotifications(pool);
    expect(row).toMatchObject({ state: 'sent', channel: 'fake.chat' });

    // Once only.
    await notificationsTick(pool, deps, minutes(20));
    expect(sent).toHaveLength(1);
  });

  it('does not escalate what the owner saw', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    const { id } = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Rent is due' });
    expect(await markSeen(pool, id, minutes(2))).toBe(true);
    await notificationsTick(pool, deps, minutes(30));
    expect(sent).toHaveLength(0);
  });

  it('delivers at once when the owner is away, and away means away', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    await presenceTouch(pool, 'web', minutes(0.5), 'away');
    clock = minutes(1);
    expect(await ownerPresent(pool, clock)).toBe(false);
    const result = await notifyOwner(pool, deps, {
      kind: 'failure',
      urgency: 'now',
      title: 'Mail polling keeps failing',
      text: 'Three jobs died.',
      link: { route: '#/activity' },
    });
    expect(result).toMatchObject({ state: 'sent', channel: 'fake.chat', error: null });
    expect(sent[0]).toMatchObject({ title: 'Mail polling keeps failing', text: 'Three jobs died.', link: { route: '#/activity' } });
  });

  it('holds today items and sends them as one message at the end of the owner day', async () => {
    fakeChannel();
    await notifyOwner(pool, deps, { kind: 'recap', urgency: 'today', title: 'Dorothée wrote back', agentId: 'postman' });
    await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'today', title: 'A proposal is waiting', agentId: 'ledger' });
    const acted = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'today', title: 'Already handled' });
    await markActed(pool, acted.id, minutes(5));

    await notificationsTick(pool, deps, new Date('2026-09-14T21:59:00.000Z'));
    expect(sent).toHaveLength(0);
    const outcome = await notificationsTick(pool, deps, new Date('2026-09-14T22:00:00.000Z'));
    expect(outcome.endOfDay).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('Today, 2 things:');
    expect(sent[0]?.text).toBe('- postman: Dorothée wrote back\n- ledger: A proposal is waiting');
    const rows = await listNotifications(pool);
    expect(rows.filter((r) => r.state === 'sent')).toHaveLength(2);
    expect(rows.find((r) => r.id === acted.id)?.state).toBe('stored');

    await notificationsTick(pool, deps, new Date('2026-09-14T22:01:00.000Z'));
    expect(sent).toHaveLength(1);
  });

  it('stores digest items for the recap and sends nothing', async () => {
    fakeChannel();
    const result = await notifyOwner(pool, deps, { kind: 'plugin', urgency: 'digest', title: 'Synced 40 receipts', pluginId: 'finance' });
    expect(result.state).toBe('stored');
    await notificationsTick(pool, deps, minutes(24 * 60));
    expect(sent).toHaveLength(0);
    const digest = await listDigestNotifications(pool, minutes(-1));
    expect(digest.map((d) => d.title)).toEqual(['Synced 40 receipts']);
  });

  it('updates an unsent row with the same key rather than adding one', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    const first = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Balance low', dedupeKey: 'balance' });
    clock = minutes(1);
    const second = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Balance lower', dedupeKey: 'balance' });
    expect(second).toMatchObject({ id: first.id, deduped: true });
    const rows = await listNotifications(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Balance lower', firedCount: 2 });
    // The escalation clock is the first one's.
    await notificationsTick(pool, deps, minutes(10));
    expect(sent.map((m) => m.title)).toEqual(['Balance lower']);
  });

  it('lowers a key that fires more than three times in an hour to today, and says so once', async () => {
    fakeChannel();
    for (let i = 0; i < 3; i += 1) {
      clock = minutes(i);
      expect((await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Disk full', dedupeKey: 'disk' })).state).toBe('sent');
    }
    clock = minutes(4);
    const fourth = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Disk full', dedupeKey: 'disk' });
    expect(fourth).toMatchObject({ state: 'held', lowered: true });
    clock = minutes(5);
    const fifth = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Disk full', dedupeKey: 'disk' });
    expect(fifth).toMatchObject({ id: fourth.id, state: 'held', lowered: true });
    const row = (await listNotifications(pool)).find((r) => r.id === fourth.id);
    expect(row?.urgency).toBe('today');
    expect(row?.title).toBe(`Disk full ${LOWERED_SENTENCE}`);
    expect(sent).toHaveLength(3);
  });

  it('holds now messages through quiet hours, except approvals and questions', async () => {
    fakeChannel();
    await writeNotificationSettings(pool, { ...DEFAULT_NOTIFICATION_SETTINGS, quietStart: '22:00', quietEnd: '07:00' });
    // 23:00 in New York.
    clock = new Date('2026-09-15T03:00:00.000Z');
    const watcher = await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Card declined' });
    expect(watcher.state).toBe('held');
    const approval = await notifyOwner(pool, deps, { kind: 'approval', urgency: 'now', title: 'ledger needs your approval' });
    expect(approval.state).toBe('sent');
    expect(sent.map((m) => m.title)).toEqual(['ledger needs your approval']);

    await notificationsTick(pool, deps, new Date('2026-09-15T10:59:00.000Z'));
    expect(sent).toHaveLength(1);
    // 07:00 in New York.
    await notificationsTick(pool, deps, new Date('2026-09-15T11:00:00.000Z'));
    expect(sent.map((m) => m.title)).toEqual(['ledger needs your approval', 'Card declined']);
  });

  it('records "no channel" once and throws nothing when there is nowhere to go', async () => {
    await presenceTouch(pool, 'web', T0);
    const shown = await notifyOwner(pool, deps, { kind: 'reminder', urgency: 'now', title: 'Call the bank' });
    expect(shown.state).toBe('shown');
    await notificationsTick(pool, deps, minutes(10));
    await notificationsTick(pool, deps, minutes(11));
    const [row] = await listNotifications(pool);
    expect(row).toMatchObject({ state: 'failed', error: 'no channel' });

    clock = minutes(20);
    const away = await notifyOwner(pool, deps, { kind: 'reminder', urgency: 'now', title: 'Call the bank again' });
    expect(away).toMatchObject({ state: 'failed', error: 'no channel' });
  });

  it('writes a refusing or throwing channel on the row', async () => {
    fakeChannel('throw');
    const thrown = await notifyOwner(pool, deps, { kind: 'failure', urgency: 'now', title: 'Jobs died' });
    expect(thrown).toMatchObject({ state: 'failed', error: 'the fake is down' });
    clearChannels();
    fakeChannel('refused');
    const refused = await notifyOwner(pool, deps, { kind: 'failure', urgency: 'now', title: 'Jobs died again' });
    expect(refused).toMatchObject({ state: 'failed', error: 'Fake refused it' });
  });

  it('keeps a kind the owner turned off on the record only, but never an approval', async () => {
    fakeChannel();
    await writeNotificationSettings(pool, { ...DEFAULT_NOTIFICATION_SETTINGS, perKind: { watcher: 'off', approval: 'off' } });
    expect((await notifyOwner(pool, deps, { kind: 'watcher', urgency: 'now', title: 'Quiet one' })).state).toBe('stored');
    expect((await notifyOwner(pool, deps, { kind: 'approval', urgency: 'now', title: 'Loud one' })).state).toBe('sent');
  });

  it('refuses a malformed message', async () => {
    await expect(notifyOwner(pool, deps, { kind: 'shout' as never, urgency: 'now', title: 'x' })).rejects.toThrow(/kind/);
    await expect(notifyOwner(pool, deps, { kind: 'plugin', urgency: 'now', title: ' ' })).rejects.toThrow(/title/);
  });
});
