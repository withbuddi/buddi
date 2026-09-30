import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sessions } from './session.js';

afterEach(() => { vi.useRealTimers(); });

describe('the idle clock', () => {
  it('does not run while a request uses the session, and starts when the last one ends', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const sessions = new Sessions(400);
    const open = async () => ({ close, closed: () => false } as never);
    await sessions.get('a', open);
    await sessions.get('a', open);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(close).not.toHaveBeenCalled();
    sessions.release('a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(close).not.toHaveBeenCalled();
    sessions.release('a');
    await vi.advanceTimersByTimeAsync(399);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(close).toHaveBeenCalledOnce();
    expect(sessions.has('a')).toBe(false);
  });
});
