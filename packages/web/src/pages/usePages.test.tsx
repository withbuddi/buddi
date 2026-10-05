/**
 * The shell's list of plugin pages is read again when a plugin is disabled or
 * enabled, so the rail and Settings drop (or gain) its entries at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { api } from '../api';
import { announcePagesChanged, usePluginPages } from './usePages';
import type { PluginPageDescriptor } from './types';
import { useAttention } from '../shell/roster';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the rail after a plugin is installed in the background', () => {
  it('reads the pages again when the dashboard stream says the plugins changed', async () => {
    let emit: ((chunk: string) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/chat/attention/stream')) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              emit = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ at: '2026-10-04T12:00:00Z', agents: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    // First run's shell read the pages before chapter 3's installs finished.
    vi.mocked(api.pages).mockReset().mockResolvedValueOnce({ pages: [] } as never);
    const { result } = renderHook(() => {
      useAttention();
      return usePluginPages();
    });
    await waitFor(() => expect(api.pages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(emit).not.toBeNull());

    // Calendar loaded live; the gateway says so on the stream the shell holds open.
    vi.mocked(api.pages).mockResolvedValueOnce({ pages: [calendar] } as never);
    act(() => emit?.('id: 7\nevent: plugins-changed\ndata: {"at":"2026-10-04T12:00:01Z","plugins":["calendar"]}\n\n'));
    await waitFor(() => expect(result.current.rail.map((p) => p.plugin)).toEqual(['calendar']));
    expect(api.pages).toHaveBeenCalledTimes(2);
  });
});
