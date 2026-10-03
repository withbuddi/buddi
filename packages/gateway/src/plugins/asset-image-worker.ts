/**
 * One plugin-asset decode in a worker thread (asset-image.ts starts it with a
 * memory limit and stops it at a deadline): a decompression bomb costs this
 * thread, never the gateway's event loop.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { AssetRefusal } from '@buddi/core';
import { normaliseAssetHere } from './asset-image.js';

const job = workerData as { bytes: Uint8Array };
try {
  const out = normaliseAssetHere(Buffer.from(job.bytes));
  const sizes = Object.entries(out).map(([side, png]) => [Number(side), new Uint8Array(png)] as [number, Uint8Array]);
  parentPort!.postMessage({ ok: true, sizes }, sizes.map(([, png]) => png.buffer as ArrayBuffer));
} catch (err) {
  parentPort!.postMessage({ ok: false, refused: err instanceof AssetRefusal, message: err instanceof Error ? err.message : String(err) });
}
