import { describe, expect, it } from 'vitest';
import { imageMime } from './index.js';

describe('imageMime', () => {
  it('names the picture from its bytes, so a provider never refuses the label', () => {
    expect(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(imageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(imageMime(Buffer.from('GIF89a'))).toBe('image/gif');
  });
});
