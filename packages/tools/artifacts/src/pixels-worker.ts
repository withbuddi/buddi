/**
 * One picture made smaller (`fitPicture`), in a worker thread with its own
 * heap limit (`view.ts` starts it): a picture that decodes into more than
 * the limits allow, or takes too long, takes the worker down, not buddi.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { PixelsError, fitPicture } from './pixels.js';

const { bytes, opts } = workerData as { bytes: Uint8Array; opts: { longSide: number; maxBytes: number } };
try {
  const out = fitPicture(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), opts);
  parentPort!.postMessage({ ok: true, out: { ...out, jpeg: new Uint8Array(out.jpeg) } });
} catch (err) {
  parentPort!.postMessage({ ok: false, pixels: err instanceof PixelsError ? err.reason : null, message: err instanceof Error ? err.message : String(err) });
}
