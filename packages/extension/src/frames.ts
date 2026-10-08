/*
 * A screencast frame as one binary message, the shape the dashboard already
 * reads.
 *
 * The gateway's `packFrame` and the dashboard's `readFrame` agree on: a
 * version byte (1), the header's length as two big-endian bytes, the header
 * as UTF-8 JSON, then the JPEG. This side writes the same thing with the
 * session in the header, so the gateway reads it with the same parser and the
 * picture crosses the extension socket as bytes rather than as base64 inside
 * JSON (a third larger, and parsed twice).
 *
 * Only to a gateway that said it reads them (`features` in its handshake); an
 * older one gets the JSON `frame` it always got.
 */

/** What the gateway announces when it reads binary frames on this socket. */
export const BINARY_FRAMES = 'frames.binary';
const VERSION = 1;
/** A header is a handful of numbers, a session id and an address. */
const MAX_HEADER = 8 * 1024;

export interface FrameHeader {
  session: string;
  deviceWidth?: number;
  deviceHeight?: number;
  pageScaleFactor?: number;
  offsetTop?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  /** Where the tab is, so the dashboard's address bar follows the owner's clicks. */
  url?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Chrome hands frames over as base64; the wire wants the bytes. */
export function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function packFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
  const head = encoder.encode(JSON.stringify(header));
  if (head.length > MAX_HEADER) throw new Error('A frame header that long is not a frame header.');
  const out = new Uint8Array(3 + head.length + jpeg.length);
  out[0] = VERSION;
  out[1] = (head.length >> 8) & 0xff;
  out[2] = head.length & 0xff;
  out.set(head, 3);
  out.set(jpeg, 3 + head.length);
  return out;
}

/** The other half, for the tests and for anything that has to check one. */
export function unpackFrame(bytes: Uint8Array): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (bytes.length < 3 || bytes[0] !== VERSION) return null;
  const length = (bytes[1]! << 8) | bytes[2]!;
  if (length === 0 || length > MAX_HEADER || 3 + length > bytes.length) return null;
  try {
    const header = JSON.parse(decoder.decode(bytes.subarray(3, 3 + length))) as FrameHeader;
    if (!header || typeof header.session !== 'string') return null;
    return { header, jpeg: bytes.subarray(3 + length) };
  } catch { return null; }
}
