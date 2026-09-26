/** The registry's pure parts: the default channel's order and a refusal's reason. */
import { afterEach, describe, expect, it } from 'vitest';
import { channelFor, clearChannels, deliverTo, listChannels, registerChannel } from './channels.js';
import type { ChannelAnswer, NotificationSettings } from './types.js';

const SETTINGS: NotificationSettings = { defaultChannel: null, perKind: {}, quietStart: null, quietEnd: null, endOfDay: '18:00' };

function add(kind: string, priority?: number, answer: ChannelAnswer = { id: kind }): void {
  registerChannel({
    kind,
    describe: () => ({ label: kind }),
    can: { offers: false, attachments: false, markdown: false },
    ...(priority === undefined ? {} : { priority }),
    deliver: async () => answer,
  });
}

describe('channels', () => {
  afterEach(() => clearChannels());

  it('defaults to the lowest priority, then the first registered', async () => {
    add('email.self');
    expect(await channelFor(SETTINGS)).toBe('email.self');
    add('local.notification', 10);
    add('other.thing', 10);
    expect(await channelFor(SETTINGS)).toBe('local.notification');
    add('telegram.chat', 0);
    expect(await channelFor(SETTINGS)).toBe('telegram.chat');
    expect((await listChannels()).map((c) => c.kind)).toEqual(['telegram.chat', 'local.notification', 'other.thing', 'email.self']);
    expect(await channelFor({ ...SETTINGS, defaultChannel: 'email.self' })).toBe('email.self');
  });

  it('writes a refusal with its reason, or with the channel label', async () => {
    add('a.b', undefined, { refused: 'osascript: not allowed' });
    add('c.d', undefined, 'refused');
    const msg = { id: 'x', kind: 'recap' as const, urgency: 'now' as const, title: 't' };
    expect(await deliverTo('a.b', msg)).toEqual({ ok: false, error: 'osascript: not allowed' });
    expect(await deliverTo('c.d', msg)).toEqual({ ok: false, error: 'c.d refused it' });
  });

  it('neither lists nor picks a channel with nothing to carry a message now', async () => {
    add('telegram.chat', 0);
    registerChannel({
      kind: 'email.self',
      describe: async () => null,
      can: { offers: false, attachments: false, markdown: false },
      deliver: async () => ({ id: 'x' }),
    });
    registerChannel({
      kind: 'broken.one',
      describe: async () => { throw new Error('boom'); },
      can: { offers: false, attachments: false, markdown: false },
      deliver: async () => ({ id: 'x' }),
    });
    expect((await listChannels()).map((c) => c.kind)).toEqual(['telegram.chat']);
    expect(await channelFor({ ...SETTINGS, defaultChannel: 'email.self' })).toBe('telegram.chat');
    expect(await channelFor({ ...SETTINGS, perKind: { recap: 'email.self' } }, 'recap')).toBe('telegram.chat');
  });
});
