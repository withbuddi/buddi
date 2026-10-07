import { expect, it, vi } from 'vitest';
import { sendStoryPhoto } from './story-photo.js';
const story = { id: 's_123', title: 'Debate recap', image: { key: 'story-a_456', outlet: 'Publisher', credit: 'Photographer', caption: 'The candidates.' } };
it('sends the selected story cached image with attribution', async () => {
  const sendPhoto = vi.fn(async () => 42); const read = vi.fn(async () => Buffer.from('png'));
  const sent = await sendStoryPhoto({ sendPhoto }, 'owner', story, {}, read);
  expect(sent).toBe(true);
  expect(read).toHaveBeenCalledWith('news', 'story-a_456', 768, {});
  expect(sendPhoto).toHaveBeenCalledWith('owner', Buffer.from('png'), expect.objectContaining({ contentType: 'image/png', caption: 'Debate recap\nThe candidates.\nPhotographer · Publisher' }));
});
it('does not fetch remote URLs or read arbitrary asset paths', async () => {
  const sendPhoto = vi.fn(); const read = vi.fn();
  for (const key of ['../secret', 'https://example.com/photo.jpg', 'logo']) {
    await sendStoryPhoto({ sendPhoto }, 'owner', { ...story, image: { key } }, {}, read);
  }
  expect(read).not.toHaveBeenCalled(); expect(sendPhoto).not.toHaveBeenCalled();
});
it('keeps an evicted or absent image optional', async () => {
  const sendPhoto = vi.fn(); const read = vi.fn(async () => null);
  expect(await sendStoryPhoto({ sendPhoto }, 'owner', story, {}, read)).toBe(false);
  await sendStoryPhoto({ sendPhoto }, 'owner', { id: 's_123' }, {}, read);
  expect(sendPhoto).not.toHaveBeenCalled();
});
