/**
 * One Office file's text, a composed one's render summary, or a composed
 * workbook's fill, in a worker thread with its own heap limit
 * (`extract.ts` starts it): a package that unpacks into more than the
 * limits allow, or parses for too long, takes the worker down, not buddi.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { OfficeKind } from '@buddi/core/plugin';
import { officeTask, type OfficeTask } from './office-task.js';

const { bytes, kind, task } = workerData as { bytes: Uint8Array; kind: OfficeKind; task: OfficeTask };
const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
officeTask(task, buffer, kind)
  .then((out) => parentPort!.postMessage({ ok: true, out }))
  .catch((err: unknown) => parentPort!.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) }));
