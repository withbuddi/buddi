/** Reactions on Telegram: what is asked for, and how an emoji is read. No network, no database. */
import { describe, expect, it } from 'vitest';
import { reactionValue } from '@buddi/core';
import { ALLOWED_UPDATES, TelegramApi, type FetchLike } from './api.js';
import { currentEmoji } from './reactions.js';

describe('reactions on Telegram', () => {
  it('asks Telegram for message_reaction updates on every poll', async () => {
    const bodies: any[] = [];
    const fetchLike: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }) };
    };
    await new TelegramApi({ token: 't', fetch: fetchLike }).getUpdates(undefined);
    expect(ALLOWED_UPDATES).toContain('message_reaction');
    expect(bodies[0].allowed_updates).toEqual(['message', 'callback_query', 'message_reaction']);
  });

  it('reads 👍 and friends as up, 👎 💩 🤮 as down, anything else as neutral', () => {
    for (const e of ['👍', '❤', '❤️', '🔥', '👏', '🎉', '🙏']) expect(reactionValue(e)).toBe('up');
    for (const e of ['👎', '💩', '🤮']) expect(reactionValue(e)).toBe('down');
    for (const e of ['🤔', '😁', '🐳']) expect(reactionValue(e)).toBe('neutral');
  });

  it('takes the emoji the owner is reacting with now, and none for a take-back or a custom emoji', () => {
    const base = { chat: { id: 1, type: 'private' }, message_id: 2, old_reaction: [] };
    expect(currentEmoji({ ...base, new_reaction: [{ type: 'emoji', emoji: '👎' }] })).toBe('👎');
    expect(currentEmoji({ ...base, new_reaction: [] })).toBeUndefined();
    expect(currentEmoji({ ...base, new_reaction: [{ type: 'custom_emoji', custom_emoji_id: 'x' }] })).toBeUndefined();
  });
});
