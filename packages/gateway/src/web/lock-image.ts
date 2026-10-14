/**
 * The owner's picture behind the lock screen, made safe and small enough to
 * serve: whatever came in (a JPEG or a PNG of at most 10 MB), a JPEG of at most
 * 2560 pixels on its long side goes out, turned the way the camera meant it.
 *
 * Pure JavaScript, like the agent pictures (`agents/avatar-image.ts`): the
 * release installs without native image libraries. Nothing but pixels
 * survives the round trip — no EXIF (so no location), no comments, no ICC.
 * The pixel work is the artifacts plugin's (`pixels.ts`), the same that
 * makes a picture small enough for a model to look at.
 */
import { createHash } from 'node:crypto';
import { PixelsError, decodeRaster, encodeJpeg, exifOrientation, orient, shrink as shrinkOnto, sniffRaster, type Rgba } from '@buddi/tool-artifacts';

export { exifOrientation, orient };

/** The largest file the owner may hand over. */
export const MAX_LOCK_IMAGE_BYTES = 10 * 1024 * 1024;
/** The long side of what is kept, at most. */
export const LOCK_IMAGE_LONG_SIDE = 2560;
/** What a transparent pixel is laid on: the dark field the lock screen draws a picture over. */
const UNDER = [16, 27, 46] as const;

export interface LockImage {
  jpeg: Buffer;
  sha256: string;
  width: number;
  height: number;
}

/** A refusal the owner reads as it is. */
export class LockImageRefusal extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415 = 400) {
    super(message);
    this.name = 'LockImageRefusal';
  }
}

/** Area-average downscale, transparency laid on the lock screen's dark field. */
export function shrink(image: Rgba, width: number, height: number): Rgba {
  return shrinkOnto(image, width, height, UNDER);
}

/** Check, decode, turn, shrink and re-encode one upload. */
export function normaliseLockImage(bytes: Buffer, claimedMime?: string): LockImage {
  if (bytes.length === 0) throw new LockImageRefusal('The file is empty.');
  if (bytes.length > MAX_LOCK_IMAGE_BYTES) throw new LockImageRefusal('A picture can be at most 10 MB.', 413);
  const kind = sniffRaster(bytes);
  if (!kind) throw new LockImageRefusal('A picture must be a JPEG or a PNG.', 415);
  const claimed = (claimedMime ?? '').toLowerCase().split(';')[0]!.trim();
  if (claimed === 'image/png' && kind !== 'png') throw new LockImageRefusal(`The file says it is ${claimed} but its contents are a JPEG.`, 415);
  if ((claimed === 'image/jpeg' || claimed === 'image/jpg') && kind !== 'jpeg') throw new LockImageRefusal(`The file says it is ${claimed} but its contents are a PNG.`, 415);
  let decoded: Rgba;
  try {
    decoded = decodeRaster(bytes, kind);
  } catch (err) {
    throw err instanceof PixelsError ? new LockImageRefusal(err.message) : err;
  }
  const scale = Math.min(1, LOCK_IMAGE_LONG_SIDE / Math.max(decoded.width, decoded.height));
  const small = shrink(decoded, Math.max(1, Math.round(decoded.width * scale)), Math.max(1, Math.round(decoded.height * scale)));
  const turned = kind === 'jpeg' ? orient(small, exifOrientation(bytes)) : small;
  const encoded = encodeJpeg(turned, 82);
  return { jpeg: encoded, sha256: createHash('sha256').update(encoded).digest('hex'), width: turned.width, height: turned.height };
}
