/**
 * One Office file's text, in a worker thread with its own heap limit
 * (`extract.ts` starts it): a package that unpacks into more than the
 * limits allow, or parses for too long, takes the worker down, not buddi.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { OfficeKind } from '@buddi/core/plugin';
import { officeText } from './office-text.js';

const { bytes, kind } = workerData as { bytes: Uint8Array; kind: OfficeKind };
officeText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), kind)
  .then((out) => parentPort!.postMessage({ ok: true, out }))
  .catch((err: unknown) => parentPort!.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) }));
