import { describe, expect, it } from 'vitest';
import { pictureMediaType } from './anthropic.js';

describe('pictureMediaType', () => {
  it('trusts the bytes over the label, and keeps the label when the bytes say nothing', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
    expect(pictureMediaType('image/png', jpeg)).toBe('image/jpeg');
    expect(pictureMediaType('image/jpeg', png)).toBe('image/png');
    expect(pictureMediaType('image/png', Buffer.from('not a picture').toString('base64'))).toBe('image/png');
  });
});
