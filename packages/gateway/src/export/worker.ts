/**
 * One conversion in a worker thread (convert.ts starts it with a memory
 * limit and stops it at a deadline): the gateway's event loop never draws a
 * PDF, and a document that would take minutes or gigabytes costs only this
 * thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DocumentTooComplex, TableTooLarge, exportDocument, type ExportFormat } from './document.js';

interface Job {
  bytes: Uint8Array;
  mime: string;
  filename: string | null;
  format: ExportFormat;
}

const job = workerData as Job;
try {
  const out = await exportDocument({ bytes: Buffer.from(job.bytes), mime: job.mime, filename: job.filename }, job.format);
  if (out === null) parentPort!.postMessage({ ok: true, bytes: null });
  else {
    const copy = new Uint8Array(out);
    parentPort!.postMessage({ ok: true, bytes: copy }, [copy.buffer]);
  }
} catch (err) {
  const refused = err instanceof DocumentTooComplex || err instanceof TableTooLarge;
  parentPort!.postMessage({ ok: false, refused, message: err instanceof Error ? err.message : String(err) });
}
