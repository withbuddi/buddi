/** A screencast frame as one binary message, in the layout the gateway and the dashboard read. */
import { describe, expect, it } from 'vitest';
import { base64Bytes, packFrame, unpackFrame } from './frames.js';

describe('packing a frame', () => {
  it('writes a version byte, the header length big-endian, the header as JSON, then the JPEG', () => {
    const jpeg = base64Bytes(btoa('\xff\xd8\xff\xe0jpeg'));
    const packed = packFrame({ session: 's1', deviceWidth: 1280, url: 'https://example.test/' }, jpeg);
    const head = JSON.stringify({ session: 's1', deviceWidth: 1280, url: 'https://example.test/' });
    expect(packed[0]).toBe(1);
    expect((packed[1]! << 8) | packed[2]!).toBe(head.length);
    expect(new TextDecoder().decode(packed.subarray(3, 3 + head.length))).toBe(head);
    expect([...packed.subarray(3 + head.length)]).toEqual([0xff, 0xd8, 0xff, 0xe0, ...'jpeg'].map((c) => typeof c === 'number' ? c : c.charCodeAt(0)));
  });

  it('reads back what it wrote, and nothing that is not a frame', () => {
    const packed = packFrame({ session: 's1', scrollOffsetY: 40 }, new Uint8Array([1, 2, 3]));
    expect(unpackFrame(packed)).toEqual({ header: { session: 's1', scrollOffsetY: 40 }, jpeg: new Uint8Array([1, 2, 3]) });
    expect(unpackFrame(new Uint8Array([2, 0, 1, 0x7b]))).toBeNull();
    expect(unpackFrame(new Uint8Array([1, 0, 9, 0x7b]))).toBeNull();
    expect(unpackFrame(packFrame({ session: 's1' }, new Uint8Array()).subarray(0, 4))).toBeNull();
  });

  it('refuses a header too long to be one', () => {
    expect(() => packFrame({ session: 'x', url: `https://example.test/${'a'.repeat(9000)}` }, new Uint8Array())).toThrow();
  });
});
