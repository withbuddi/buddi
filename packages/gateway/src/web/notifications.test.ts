/**
 * "Send a test" on Settings → Notifications: one line through the named
 * channel, with no database and no record.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearChannels, registerChannel, type DeliverableMessage } from '@buddi/core';
import { TEST_MESSAGE_TITLE, testChannelRoute } from './notifications.js';

const NOW = new Date('2026-09-25T10:00:00.000Z');

function channel(kind: string, deliver: (m: DeliverableMessage) => Promise<{ id: string } | 'refused'>): void {
  registerChannel({
    kind,
    describe: () => ({ label: 'Telegram', where: '@buddi_test_bot' }),
    can: { offers: true, attachments: false, markdown: false },
    deliver,
  });
}

describe('POST /api/notifications/test', () => {
  afterEach(() => clearChannels());

  it('sends one line through the channel it names', async () => {
    const sent: DeliverableMessage[] = [];
    channel('telegram.chat', async (m) => { sent.push(m); return { id: '1' }; });
    expect(await testChannelRoute({ channel: 'telegram.chat' }, NOW)).toEqual({ status: 200, body: { ok: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: TEST_MESSAGE_TITLE, urgency: 'now' });
    expect(sent[0]!.actionId).toBeUndefined();
  });

  it('says so when the channel refuses or throws', async () => {
    channel('telegram.chat', async () => 'refused');
    expect(await testChannelRoute({ channel: 'telegram.chat' }, NOW)).toEqual({
      status: 502,
      body: { error: 'The test did not go through: Telegram refused it.' },
    });
    clearChannels();
    channel('telegram.chat', async () => { throw new Error('the owner has not paired'); });
    expect((await testChannelRoute({ channel: 'telegram.chat' }, NOW)).body).toEqual({
      error: 'The test did not go through: the owner has not paired.',
    });
  });

  it('refuses a channel that is not there, or none', async () => {
    expect((await testChannelRoute({ channel: 'email.self' }, NOW)).status).toBe(404);
    expect((await testChannelRoute({}, NOW)).status).toBe(400);
  });
});
