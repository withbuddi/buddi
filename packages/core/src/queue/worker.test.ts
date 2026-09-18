import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { runWorker, type JobContext } from './worker.js';
import { claimJob, completeJob, failJob, heartbeat } from './jobs.js';
import type { Job } from './types.js';

vi.mock('./jobs.js', () => ({
  claimJob: vi.fn(), completeJob: vi.fn(), failJob: vi.fn(), heartbeat: vi.fn(),
  releaseStaleLeases: vi.fn(), suspendJob: vi.fn(),
}));

async function runningWorker(leaseMs = 1000) {
  vi.clearAllMocks();
  vi.mocked(claimJob).mockResolvedValueOnce({ id: 'job-1', kind: 'probe' } as Job).mockResolvedValue(null);
  let entered!: (ctx: JobContext) => void;
  const started = new Promise<JobContext>((resolve) => { entered = resolve; });
  const worker = runWorker({
    pool: {} as Pool, worker: 'test', now: () => new Date(), pollMs: 1000,
    leaseMs, heartbeatMs: 10000, recoverOnStart: false,
    handlers: { probe: async (_job, ctx) => {
      entered(ctx);
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    } },
  });
  return { worker, ctx: await started };
}

describe('worker cancellation', () => {
  it('aborts a handler when its heartbeat loses the lease', async () => {
    const { worker, ctx } = await runningWorker();
    vi.mocked(heartbeat).mockResolvedValue(false);
    expect(await ctx.heartbeat()).toBe(false);
    expect(ctx.signal.aborted).toBe(true);
    await worker.stop();
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });

  it('stops on the local lease deadline if the database cannot confirm renewal', async () => {
    const { worker, ctx } = await runningWorker(20);
    vi.mocked(heartbeat).mockRejectedValue(new Error('database unavailable'));
    await ctx.heartbeat();
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    expect(ctx.lost).toBe(true);
    await worker.stop();
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });

  it('aborts active work on shutdown and leaves the lease for recovery', async () => {
    const { worker, ctx } = await runningWorker();
    await worker.stop();
    expect(ctx.signal.aborted).toBe(true);
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });
});
