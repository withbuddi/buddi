/**
 * The shell's list of plugin pages is read again when a plugin is disabled or
 * enabled, so the rail and Settings drop (or gain) its entries at once.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { api } from '../api';
import { announcePagesChanged, usePluginPages } from './usePages';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => {
  const actual = await load<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, pages: vi.fn() } };
});

const calendar = { plugin: 'calendar', id: 'week', title: 'Calendar', place: 'rail' } as unknown as PluginPageDescriptor;

describe('usePluginPages', () => {
  it('reads the pages again when a plugin was toggled', async () => {
    vi.mocked(api.pages).mockResolvedValueOnce({ pages: [calendar] } as never);
    const { result } = renderHook(() => usePluginPages());
    await waitFor(() => expect(result.current.rail.map((p) => p.plugin)).toEqual(['calendar']));

    vi.mocked(api.pages).mockResolvedValueOnce({ pages: [] } as never);
    act(() => announcePagesChanged());
    await waitFor(() => expect(result.current.rail).toEqual([]));
    expect(api.pages).toHaveBeenCalledTimes(2);
  });
});
