/**
 * The sheet engine's work for the xlsx preview, off the page's thread: the
 * workbook read (`readWorkbook`, within the Office zip limits, its cells
 * kept sparsely) — everything the table draws — then the
 * values of formulas the file carries none for and each sheet's conditional
 * colours (`sheetEngine`, `conditionalStyles`). It runs in a Web Worker
 * (`sheet-worker.ts`) the page ends if it takes longer than `SHEET_JOB_MS`,
 * so no workbook can hang the page: ended before the read, the preview says
 * the file is too large; after it, the table stands without the computed
 * values, and the sheet says it was too large to calculate. Where
 * there is no Worker (a test's jsdom) it runs here.
 */
import { SHEET_PREVIEW_COLS, SHEET_PREVIEW_ROWS } from '@buddi/core/office-files';
import {
  conditionalNeedsEngine, conditionalStyles, readWorkbook, sheetEngine, valueOf, cellKey,
  type CellStyle, type Evaluation, type WorkbookModel,
} from '@buddi/core/sheet';

/** How long the preview's calculation may take before its worker is ended. */
export const SHEET_JOB_MS = 15_000;

/** What the calculation adds to the read workbook: values, and each sheet's conditional colours (by `cellKey`). */
export interface SheetComputed {
  evaluation: Evaluation | null;
  conditional: Array<Map<number, Partial<CellStyle>>>;
}

export type SheetMessage =
  | { type: 'model'; model: WorkbookModel }
  | { type: 'computed'; computed: SheetComputed }
  | { type: 'failed' };

/** Whether any shown formula has no value in the file. */
function needsValues(model: WorkbookModel): boolean {
  return model.sheets.some((sheet) => [...sheet.cells.values()].some((c) => c.formula !== undefined && !c.hasValue && c.row <= SHEET_PREVIEW_ROWS && c.col <= SHEET_PREVIEW_COLS));
}

/** The work itself, reporting the read workbook first and the calculation after. */
export async function computeSheet(bytes: ArrayBuffer, post: (message: SheetMessage) => void): Promise<void> {
  let model: WorkbookModel;
  try { model = readWorkbook(new Uint8Array(bytes)); } catch { post({ type: 'failed' }); return; }
  post({ type: 'model', model });
  const engine = needsValues(model) || model.sheets.some(conditionalNeedsEngine)
    ? await sheetEngine(model, { want: (_sheet, cell) => !cell.hasValue && cell.row <= SHEET_PREVIEW_ROWS && cell.col <= SHEET_PREVIEW_COLS })
    : null;
  const conditional = model.sheets.map((sheet) => {
    if (sheet.conditional.length === 0) return new Map<number, Partial<CellStyle>>();
    const window = { r1: 1, c1: 1, r2: Math.min(SHEET_PREVIEW_ROWS, Math.max(sheet.maxRow, 1)), c2: Math.min(SHEET_PREVIEW_COLS, Math.max(sheet.maxCol, 1)) };
    const valueAt = (r: number, c: number) => {
      const cell = sheet.cells.get(cellKey(r, c));
      return cell ? valueOf(engine?.evaluation ?? null, sheet, cell) : null;
    };
    return conditionalStyles(model, sheet, window, valueAt, engine);
  });
  post({ type: 'computed', computed: { evaluation: engine?.evaluation ?? null, conditional } });
}

/** Why a calculation ended without values. */
export type SheetStop = 'too-large' | 'failed' | 'unstarted';

export interface SheetJob {
  /** The read workbook, or null when it could not be read. */
  model: Promise<WorkbookModel | null>;
  /** The calculation, or `too-large` when it was ended at the deadline, `failed` when it broke, `unstarted` when its worker never ran (a hint its script is gone in an update). */
  computed: Promise<SheetComputed | SheetStop>;
  cancel(): void;
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<SheetMessage>) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

function defaultWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./sheet-worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

/** The preview's calculation, in a worker ended after `timeoutMs`. */
export function runSheetJob(bytes: ArrayBuffer, opts: { timeoutMs?: number; makeWorker?: () => WorkerLike | null } = {}): SheetJob {
  let resolveModel!: (model: WorkbookModel | null) => void;
  let resolveComputed!: (computed: SheetComputed | SheetStop) => void;
  const model = new Promise<WorkbookModel | null>((resolve) => { resolveModel = resolve; });
  const computed = new Promise<SheetComputed | SheetStop>((resolve) => { resolveComputed = resolve; });
  let done = false;
  const receive = (message: SheetMessage): void => {
    if (done) return;
    if (message.type === 'model') { resolveModel(message.model); return; }
    done = true;
    if (message.type === 'failed') { resolveModel(null); resolveComputed('failed'); return; }
    resolveComputed(message.computed);
  };
  const worker = (opts.makeWorker ?? defaultWorker)();
  if (!worker) {
    // No Worker here: the same work on this thread.
    void computeSheet(bytes, receive).catch(() => receive({ type: 'failed' }));
    return { model, computed, cancel: () => { done = true; } };
  }
  const stop = (why: SheetStop): void => {
    if (done) return;
    done = true;
    worker.terminate();
    resolveModel(null);
    resolveComputed(why);
  };
  const timer = setTimeout(() => stop('too-large'), opts.timeoutMs ?? SHEET_JOB_MS);
  let heard = false;
  worker.onmessage = (event) => {
    heard = true;
    receive(event.data);
    if (done) { clearTimeout(timer); worker.terminate(); }
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    // A worker that never started (no message yet, no error of its own to report): its script may be gone in an update.
    stop(!heard && !(typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent && event.message) ? 'unstarted' : 'failed');
  };
  // A copy: the bytes are the preview's state, and a transfer would empty them.
  const copy = bytes.slice(0);
  worker.postMessage(copy, [copy]);
  return { model, computed, cancel: () => { clearTimeout(timer); if (!done) { done = true; worker.terminate(); } } };
}
