/**
 * How the gateway runs a conversion: one at a time, in a worker thread with
 * a memory limit, stopped at a deadline. A refusal says why and what to do
 * (`ExportRefused.status`: 413 too large or complex, 503 busy, 504 too slow).
 *
 * The worker is the compiled `worker.js` beside this file. Run from source
 * (the tests), there is none: the conversion runs in this thread, still one
 * at a time and still answered at the deadline.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  DocumentTooComplex,
  MAX_EXPORT_SOURCE_BYTES,
  TableTooLarge,
  exportDocument,
  exportFormats,
  type ExportFormat,
} from './document.js';

export class ExportRefused extends Error {
  override name = 'ExportRefused';
  constructor(
    message: string,
    readonly status: 413 | 503 | 504,
    /** Seconds, for a busy refusal's Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export interface ExportLimits {
  /** A conversion still running after this is stopped. */
  timeoutMs: number;
  /** The worker's heap. */
  memoryMb: number;
}

export const EXPORT_LIMITS: ExportLimits = { timeoutMs: 15_000, memoryMb: 384 };

export interface ExportSource {
  bytes: Buffer;
  mime: string;
  filename: string | null;
}

/* One conversion at a time per process: the rest wait (Telegram) or are told to retry (the route). */
let running = false;
const waiting: Array<() => void> = [];

function acquire(wait: boolean): Promise<void> | null {
  if (!running) {
    running = true;
    return Promise.resolve();
  }
  if (!wait) return null;
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running = false;
}

const workerUrl = new URL('./worker.js', import.meta.url);
const hasWorker = import.meta.url.endsWith('.js') && existsSync(fileURLToPath(workerUrl));

function inWorker(source: ExportSource, format: ExportFormat, limits: ExportLimits): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const bytes = new Uint8Array(source.bytes);
    const worker = new Worker(workerUrl, {
      workerData: { bytes, mime: source.mime, filename: source.filename, format },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => done(() => reject(tooSlow())), limits.timeoutMs);
    worker.once('message', (msg: { ok: boolean; bytes?: Uint8Array | null; refused?: boolean; message?: string }) => {
      done(() => {
        if (msg.ok) resolve(msg.bytes ? Buffer.from(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength) : null);
        else if (msg.refused) reject(new ExportRefused(msg.message ?? 'this document cannot be converted', 413));
        else reject(new Error(msg.message ?? 'the conversion failed'));
      });
    });
    worker.once('error', (err: Error & { code?: string }) => {
      done(() => reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooComplex() : err));
    });
    worker.once('exit', (code) => {
      done(() => reject(new Error(`the conversion stopped (exit ${code})`)));
    });
  });
}

function tooSlow(): ExportRefused {
  return new ExportRefused('this document takes too long to convert; download it as it is', 504);
}

function tooComplex(): ExportRefused {
  return new ExportRefused('this document is too large or too complex to convert; download it as it is', 413);
}

async function inThread(source: ExportSource, format: ExportFormat, limits: ExportLimits): Promise<Buffer | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exportDocument(source, format).catch((err: unknown) => {
        if (err instanceof DocumentTooComplex || err instanceof TableTooLarge) throw new ExportRefused(err.message, 413);
        throw err;
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(tooSlow()), limits.timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert a stored document to `format`. `null` when the file does not offer
 * it. The stored format is never converted: it comes back as it is, at any
 * size. `wait: false` (the download route) refuses with 503 while another
 * conversion runs; `wait: true` (Telegram) queues.
 */
export async function runExport(
  source: ExportSource,
  format: ExportFormat,
  opts: { wait?: boolean; limits?: Partial<ExportLimits>; inThread?: boolean } = {},
): Promise<Buffer | null> {
  const formats = exportFormats(source.mime, source.filename);
  if (!formats.includes(format)) return null;
  if (format === formats[0]) return source.bytes;
  if (source.bytes.length > MAX_EXPORT_SOURCE_BYTES) {
    throw new ExportRefused(`this file is larger than ${MAX_EXPORT_SOURCE_BYTES / 1024} KiB, too large to convert; download it as it is`, 413);
  }
  const limits = { ...EXPORT_LIMITS, ...opts.limits };
  const slot = acquire(opts.wait === true);
  if (slot === null) throw new ExportRefused('another document is being converted; try again in a few seconds', 503, 5);
  await slot;
  try {
    return hasWorker && opts.inThread !== true ? await inWorker(source, format, limits) : await inThread(source, format, limits);
  } finally {
    release();
  }
}

/** Whether a conversion is running now (for tests). */
export function exportBusy(): boolean {
  return running;
}
