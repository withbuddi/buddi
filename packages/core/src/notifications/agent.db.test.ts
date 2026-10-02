/**
 * `owner.notify`'s core half, against real Postgres with a fake clock and a
 * fake channel: routing per urgency and presence, the interactive exception,
 * the per-agent limits, dedupe by key, mute and off, and the sentence the
 * agent is given for each outcome.
 *
 * The database is created by this suite, named after this process, and
 * dropped again: the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { urlForDatabase } from '../backup/restore.js';
import { createPool, migrateCore } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { AGENT_MESSAGES_PER_DAY, AGENT_NOW_PER_HOUR, notifyFromAgent } from './agent.js';
import { clearChannels, registerChannel } from './channels.js';
import { countOpenAsks, listOpenAsks, needsOwner, openForOwner } from './needs.js';
import { notificationsTick, notifyOwner } from './notify.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  listNotifications,
  presenceTouch,
  readNotificationSettings,
  setAgentMuted,
  writeNotificationSettings,
} from './store.js';
import type { DeliverableMessage, NotifyDeps } from './types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_agent_notify_${process.pid}`;

// 10:00 in New York (EDT).
const T0 = new Date('2026-09-14T14:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

/** Titles that share no words, so nothing could be taken for the same thing. */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor'];

suite('an agent tells the owner', () => {
  let admin: Pool;
  let pool: Pool;
  let sent: DeliverableMessage[];
  let clock: Date;
  const deps: NotifyDeps = { now: () => clock, timezone: 'America/New_York' };

  const fakeChannel = () =>
    registerChannel({
      kind: 'telegram.chat',
      describe: () => ({ label: 'Telegram' }),
      can: { offers: true, attachments: false, markdown: false },
      async deliver(message) {
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

  it('away: now goes to the channel at once, signed with the handle', async () => {
    fakeChannel();
    const result = await notifyFromAgent(pool, deps, { agentId: 'scout-1', agentHandle: 'scout', title: 'The page changed', text: 'See [here](https://evil.example)' });
    expect(result).toMatchObject({ ok: true, outcome: 'sent', delivered: 'sent to Telegram' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'agent', title: '@scout: The page changed', agentId: 'scout-1' });
    expect(sent[0]?.offers).toBeUndefined();
    const [row] = await listNotifications(pool);
    expect(row).toMatchObject({ kind: 'agent', agentId: 'scout-1', state: 'sent', topic: null });
  });

  it('on the dashboard: now is shown there and escalates after ten minutes', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    const result = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Parcel delivered' });
    expect(result.outcome).toBe('shown');
    expect(result.delivered).toBe('shown on the dashboard, and sent to Telegram if unseen in 10 minutes');
    expect(sent).toHaveLength(0);
    clock = minutes(11);
    await notificationsTick(pool, deps, clock);
    expect(sent.map((m) => m.title)).toEqual(['@scout: Parcel delivered']);
  });

  it('today waits for the end-of-day message, one line each', async () => {
    fakeChannel();
    const result = await notifyFromAgent(pool, deps, { agentId: 'planner', title: 'Tomorrow is clear', urgency: 'today' });
    expect(result).toMatchObject({ outcome: 'today', delivered: "in today's end-of-day message, at 18:00 on the owner's clock" });
    clock = new Date('2026-09-14T22:01:00.000Z'); // 18:01 in New York
    await notificationsTick(pool, deps, clock);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('- @planner: Tomorrow is clear');
  });

  it('the interactive exception: the owner on the dashboard asked, so it goes at once', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    const result = await notifyFromAgent(pool, deps, { agentId: 'buddi', title: 'Here it is on your phone', interactive: true });
    expect(result).toMatchObject({ outcome: 'sent', delivered: 'sent to Telegram' });
    expect(sent).toHaveLength(1);
  });

  it('a mission (not interactive) keeps the hold on the dashboard', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    const result = await notifyFromAgent(pool, deps, { agentId: 'buddi', title: 'Found something', interactive: false });
    expect(result.outcome).toBe('shown');
    expect(sent).toHaveLength(0);
  });

  it('the interactive exception does not reach past a focus', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    await writeNotificationSettings(pool, {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      schedules: [{ mode: 'do-not-disturb', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '09:00', to: '12:00' }],
    });
    const result = await notifyFromAgent(pool, deps, { agentId: 'buddi', title: 'Quiet please', interactive: true });
    expect(result.outcome).toBe('focus');
    expect(result.delivered).toMatch(/^held while the owner is in Do not disturb/);
    expect(sent).toHaveLength(0);
  });

  it(`lowers the ${AGENT_NOW_PER_HOUR + 1}th now in an hour to today`, async () => {
    fakeChannel();
    for (let i = 0; i < AGENT_NOW_PER_HOUR; i += 1) {
      clock = minutes(i);
      const r = await notifyFromAgent(pool, deps, { agentId: 'scout', title: `${WORDS[i]} happened` });
      expect(r.outcome).toBe('sent');
    }
    clock = minutes(10);
    const seventh = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'zulu happened' });
    expect(seventh.outcome).toBe('lowered-limit');
    expect(seventh.delivered).toMatch(/^lowered to today: you sent more than 6 of these this hour/);
    // Another agent has its own count.
    expect((await notifyFromAgent(pool, deps, { agentId: 'planner', title: 'yankee happened' })).outcome).toBe('sent');
    // An hour on, now is allowed again.
    clock = minutes(61);
    expect((await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'xray happened' })).outcome).toBe('sent');
  });

  it(`refuses the ${AGENT_MESSAGES_PER_DAY + 1}st message in a day`, async () => {
    fakeChannel();
    for (let i = 0; i < AGENT_MESSAGES_PER_DAY; i += 1) {
      clock = minutes(i * 30);
      const r = await notifyFromAgent(pool, deps, { agentId: 'scout', title: `${WORDS[i]} update`, urgency: 'today' });
      expect(r.ok).toBe(true);
    }
    clock = minutes(AGENT_MESSAGES_PER_DAY * 30);
    const refused = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'one more' });
    expect(refused).toMatchObject({ ok: false, outcome: 'daily-limit' });
    expect(refused.delivered).toBe('refused: you already sent 20 messages today, the daily limit. Nothing was sent.');
    expect(await listNotifications(pool, { limit: 100 })).toHaveLength(AGENT_MESSAGES_PER_DAY);
  });

  it('dedupes by key, scoped to the agent', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    const first = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Build failed', key: 'build' });
    const again = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Build failed again', key: 'build' });
    expect(again.id).toBe(first.id);
    expect(again.updated).toBe(true);
    expect(again.delivered).toMatch(/^updated your earlier message with this key; shown on the dashboard/);
    // The same key from another agent is another message.
    const other = await notifyFromAgent(pool, deps, { agentId: 'planner', title: 'Build failed', key: 'build' });
    expect(other.id).not.toBe(first.id);
    const rows = await listNotifications(pool);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(['agent:planner:build', 'agent:scout:build']);
  });

  it('a muted agent is refused and nothing is written', async () => {
    fakeChannel();
    await setAgentMuted(pool, 'scout', true);
    const result = await notifyFromAgent(pool, deps, { agentId: 'scout', agentHandle: 'scout', title: 'Hello' });
    expect(result).toMatchObject({ ok: false, outcome: 'muted' });
    expect(result.delivered).toMatch(/^refused: the owner has muted messages from @scout\./);
    expect(await listNotifications(pool)).toHaveLength(0);
    await setAgentMuted(pool, 'scout', false);
    expect((await readNotificationSettings(pool)).agents.muted).toEqual([]);
    expect((await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Hello' })).outcome).toBe('sent');
  });

  it('off: kept for the record, never sent, and said so', async () => {
    fakeChannel();
    await writeNotificationSettings(pool, { ...DEFAULT_NOTIFICATION_SETTINGS, perKind: { agent: 'off' } });
    const result = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Hello' });
    expect(result.outcome).toBe('off');
    expect(result.delivered).toMatch(/^not sent: messages from agents are off/);
    expect(sent).toHaveLength(0);
    expect((await listNotifications(pool))[0]?.state).toBe('stored');
  });

  it('the highest urgency the owner allows lowers now to today', async () => {
    fakeChannel();
    await writeNotificationSettings(pool, { ...DEFAULT_NOTIFICATION_SETTINGS, agents: { maxUrgency: 'today', muted: [] } });
    const result = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Hello', interactive: true });
    expect(result).toMatchObject({ outcome: 'lowered-settings' });
    expect(result.delivered).toBe("lowered to today by the owner's settings; it will be in today's end-of-day message");
    expect(sent).toHaveLength(0);
  });

  it('saving the page without the agents value keeps the mutes', async () => {
    await setAgentMuted(pool, 'scout', true);
    const { agents: _ignored, focus: _focus, ...page } = DEFAULT_NOTIFICATION_SETTINGS;
    await writeNotificationSettings(pool, page);
    expect((await readNotificationSettings(pool)).agents.muted).toEqual(['scout']);
  });

  it('with no channel it fails, kept, and says why', async () => {
    const result = await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Hello' });
    expect(result.outcome).toBe('failed');
    expect(result.delivered).toBe("not sent: no channel. It is kept in the owner's notification list");
  });

  it('is never folded into another agent\'s message about the same thing', async () => {
    fakeChannel();
    await presenceTouch(pool, 'web', T0);
    await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'Visa card payment due Friday 40 EUR' });
    await notifyFromAgent(pool, deps, { agentId: 'planner', title: 'Visa card payment due Friday 40 EUR' });
    expect(await listNotifications(pool)).toHaveLength(2);
  });

  it('plain information is delivered as ever but never needs the owner; one with an action does, until seen', async () => {
    fakeChannel();
    // A mission's report and two plain owner.notify messages: information.
    await notifyOwner(pool, deps, { kind: 'recap', urgency: 'now', title: 'Morning brief: three meetings', link: { route: '#/chat/brief/c1' } });
    await notifyFromAgent(pool, deps, { agentId: 'scout', title: 'The parcel was delivered' });
    await notifyFromAgent(pool, deps, { agentId: 'tempo', title: 'Rain after four', link: '#/chat/tempo' });
    // One that asks for something.
    const ask = await notifyFromAgent(pool, deps, { agentId: 'ledger', title: 'Charged twice at Monoprix', action: '  Confirm with the bank?  ' });
    expect(sent.map((m) => m.title)).toEqual([
      'Morning brief: three meetings', '@scout: The parcel was delivered', '@tempo: Rain after four', '@ledger: Charged twice at Monoprix',
    ]);
    expect(sent[3]).toMatchObject({ action: 'Confirm with the bank?' });
    expect(sent[0]?.action).toBeUndefined();

    const rows = await listNotifications(pool);
    expect(rows.every((r) => r.state === 'sent')).toBe(true);
    expect(rows.filter(needsOwner).map((r) => r.id)).toEqual([ask.id]);
    expect(rows.filter(openForOwner).map((r) => r.id)).toEqual([ask.id]);
    expect(needsOwner({ kind: 'approval', action: null })).toBe(true);
    expect(needsOwner({ kind: 'question', action: null })).toBe(true);
    expect(needsOwner({ kind: 'agent', action: '   ' })).toBe(false);
    expect(await countOpenAsks(pool)).toBe(1);
    expect((await listOpenAsks(pool)).map((r) => r.action)).toEqual(['Confirm with the bank?']);

    // A month old and still unresolved: it waits, in the count and the list.
    await pool.query(`update core.owner_notifications set created_at = now() - interval '30 days' where id = $1`, [ask.id]);
    expect(await countOpenAsks(pool)).toBe(1);
    expect((await listOpenAsks(pool)).map((r) => r.id)).toEqual([ask.id]);
    // The list pages; the count stays the total.
    const second = await notifyFromAgent(pool, deps, { agentId: 'ledger', title: 'Rent went up', action: 'Approve the new amount?' });
    expect(await countOpenAsks(pool)).toBe(2);
    expect((await listOpenAsks(pool, { limit: 1 })).map((r) => r.id)).toEqual([second.id]);
    expect((await listOpenAsks(pool, { limit: 1, offset: 1 })).map((r) => r.id)).toEqual([ask.id]);
    await pool.query('update core.owner_notifications set seen_at = $2 where id = $1', [second.id, clock]);

    await pool.query('update core.owner_notifications set seen_at = $2 where id = $1', [ask.id, clock]);
    expect(await countOpenAsks(pool)).toBe(0);
  });
});
