/**
 * The xlsx preview's calculation runs in a worker the page ends at its
 * deadline (`sheet-job.ts`), so a workbook built to expand a huge range
 * cannot hang the page; and the Canvas's turn-end rule reads the turn and
 * the conversation it ended in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { turnEndHolds } from '../ChatPage';
import { runSheetJob, type WorkerLike } from './sheet-job';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../core/src/__fixtures__/office');
const trip = (): ArrayBuffer => new Uint8Array(readFileSync(path.join(FIXTURES, 'trip.xlsx'))).buffer;

describe('the preview’s calculation', () => {
  it('ends a worker that runs past its deadline: the sheet is too large to calculate', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const worker: WorkerLike = { postMessage: vi.fn(), terminate, onmessage: null, onerror: null };
    const job = runSheetJob(trip(), { timeoutMs: 1_000, makeWorker: () => worker });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(await job.computed).toBe('too-large');
    expect(terminate).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('hands back the read workbook, then the values, from the worker, and ends it', async () => {
    const terminate = vi.fn();
    const worker: WorkerLike = { postMessage: vi.fn(), terminate, onmessage: null, onerror: null };
    const job = runSheetJob(trip(), { makeWorker: () => worker });
    const model = { sheets: [], styles: { cells: [], dxfs: [] }, date1904: false };
    worker.onmessage!({ data: { type: 'model', model } } as MessageEvent);
    expect(await job.model).toBe(model);
    worker.onmessage!({ data: { type: 'computed', computed: { evaluation: null, conditional: [] } } } as MessageEvent);
    expect(await job.computed).toEqual({ evaluation: null, conditional: [] });
    expect(terminate).toHaveBeenCalled();
  });

  it('runs on this thread where there is no Worker, with the same results', async () => {
    const job = runSheetJob(trip(), { makeWorker: () => null });
    expect((await job.model)?.sheets.map((s) => s.name)).toEqual(['Summary', 'Costs']);
    const computed = await job.computed;
    expect(computed).not.toBe('too-large');
    if (computed === 'too-large' || computed === 'failed') return;
    expect(computed.evaluation?.values.get('Costs')?.size).toBeGreaterThan(0);
  });
});

describe('the end of a turn', () => {
  it('holds only for the conversation and the turn it ended in', () => {
    const ended = { conversationId: 'c1', turn: '2026-10-14T10:00:00.000Z' };
    expect(turnEndHolds(ended, 'c1', '2026-10-14T10:00:00.000Z')).toBe(true);
    expect(turnEndHolds(ended, 'c2', '2026-10-14T10:00:00.000Z')).toBe(false);
    expect(turnEndHolds(ended, 'c1', '2026-10-14T11:00:00.000Z')).toBe(false);
    expect(turnEndHolds(null, 'c1', '2026-10-14T10:00:00.000Z')).toBe(false);
  });
});
