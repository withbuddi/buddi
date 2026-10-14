/**
 * The xlsx preview's sheet engine in a Web Worker (`sheet-job.ts`): the page
 * posts the workbook's bytes and ends the worker if it runs past its time.
 */
import { computeSheet, type SheetMessage } from './sheet-job';

const scope = self as unknown as { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null; postMessage(message: SheetMessage): void };
scope.onmessage = (event) => {
  void computeSheet(event.data, (message) => scope.postMessage(message)).catch(() => scope.postMessage({ type: 'failed' }));
};
