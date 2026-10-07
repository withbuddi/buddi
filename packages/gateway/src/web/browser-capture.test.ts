import { describe, expect, it } from 'vitest';
import { captureFilename } from './browser-capture.js';

describe('a capture’s name in Files', () => {
  const at = new Date('2026-10-07T12:32:10Z');
  it('is the page title and the time, in the owner’s zone', () => {
    expect(captureFilename({ title: 'Your orders', url: 'https://www.amazon.com/orders', at, timezone: 'Europe/Ljubljana' })).toBe('Your orders 2026-10-07 14.32.png');
  });
  it('falls back to the site, and keeps nothing a file system refuses', () => {
    expect(captureFilename({ title: '  ', url: 'https://www.amazon.com/orders', at, timezone: 'UTC' })).toBe('amazon.com 2026-10-07 12.32.png');
    expect(captureFilename({ title: 'a/b: "c" <d>\n', url: 'about:blank', at, timezone: 'UTC' })).toBe('a b c d 2026-10-07 12.32.png');
    expect(captureFilename({ title: 'x'.repeat(200), url: '', at, timezone: 'UTC' })).toHaveLength(80 + ' 2026-10-07 12.32.png'.length);
  });
});
