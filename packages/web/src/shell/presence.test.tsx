/**
 * Presence: `active` on load, every 30 seconds while in front, `away` on
 * blur and hide, never more than one request a second, nothing signed out.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api';
import { PRESENCE_EVERY_MS, usePresence } from './presence';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, api: { ...original.api, presence: vi.fn(async () => ({ ok: true })) } };
});

const sent = (): string[] => vi.mocked(api.presence).mock.calls.map(([state]) => state);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.presence).mockClear();
  vi.mocked(api.presence).mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

describe('usePresence', () => {
  it('says active on load and every 30 seconds, and runs the beat each time', () => {
    const beat = vi.fn();
    renderHook(() => usePresence(true, beat));
    expect(sent()).toEqual(['active']);
    vi.advanceTimersByTime(PRESENCE_EVERY_MS);
    vi.advanceTimersByTime(PRESENCE_EVERY_MS);
    expect(sent()).toEqual(['active', 'active', 'active']);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('says away on blur, stops the heartbeat, and is back on focus', () => {
    renderHook(() => usePresence(true));
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('blur'));
    expect(sent()).toEqual(['active', 'away']);
    vi.advanceTimersByTime(PRESENCE_EVERY_MS * 2);
    expect(sent()).toEqual(['active', 'away']);
    window.dispatchEvent(new Event('focus'));
    expect(sent()).toEqual(['active', 'away', 'active']);
  });

  it('sends one request a second at most through a focus and blur flutter, the last state winning', () => {
    renderHook(() => usePresence(true));
    // The load's `active` just went; everything below lands inside the same second.
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    expect(sent()).toEqual(['active']);
    vi.advanceTimersByTime(1_000);
    expect(sent()).toEqual(['active', 'away']);
  });

  it('says away when the tab is hidden', () => {
    renderHook(() => usePresence(true));
    vi.advanceTimersByTime(2_000);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()).toEqual(['active', 'away']);
    visibility.mockRestore();
  });

  it('sends nothing while signed out, and stops at a 401', async () => {
    renderHook(() => usePresence(false));
    vi.advanceTimersByTime(PRESENCE_EVERY_MS);
    expect(sent()).toEqual([]);

    vi.mocked(api.presence).mockRejectedValue(new ApiError(401, 'expired'));
    const out = vi.fn();
    renderHook(() => usePresence(true, undefined, out));
    await vi.advanceTimersByTimeAsync(PRESENCE_EVERY_MS * 2);
    expect(sent()).toEqual(['active']);
    expect(out).toHaveBeenCalledTimes(1);
  });
});
