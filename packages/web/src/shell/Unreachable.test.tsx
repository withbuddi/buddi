/** buddi isn't answering: both hints, Retry, the quiet retry, and the bar. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetLink } from '../api';
import { BootGate, LostBar, RETRY_MS, Unreachable, hintFor } from './Unreachable';

const answer = (status: number, body: unknown = { current: '0.1.0', checkEnabled: false, updateAvailable: false, history: [], supervised: false }) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => resetLink());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('hintFor', () => {
  it('asks about this Mac on a loopback address', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const { container, unmount } = render(<p>{hintFor(host)}</p>);
      expect(container.textContent).toBe('Is buddi running on this Mac? buddi status says.');
      unmount();
    }
  });

  it('asks about Tailscale and the Mac anywhere else', () => {
    for (const host of ['mac.tail1234.ts.net', '100.101.102.103', 'buddi.lan']) {
      const { container, unmount } = render(<p>{hintFor(host)}</p>);
      expect(container.textContent).toBe('Is Tailscale on, and the Mac it runs on awake?');
      unmount();
    }
  });
});

describe('Unreachable', () => {
  it('names the address and retries on the button', () => {
    const onRetry = vi.fn();
    render(<Unreachable host="mac.tail1234.ts.net" onRetry={onRetry} retrying={false} />);
    expect(screen.getByRole('heading').textContent).toBe("buddi isn't answering at mac.tail1234.ts.net.");
    expect(screen.getByText('Is Tailscale on, and the Mac it runs on awake?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('BootGate', () => {
  it('draws the shell when the gateway answers, even with a no', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    render(<BootGate><p>shell</p></BootGate>);
    expect(await screen.findByText('shell')).toBeTruthy();
  });

  it('says so on a network error, and Retry brings the shell back', async () => {
    const fetch = vi.fn(async (): Promise<Response> => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetch);
    render(<BootGate><p>shell</p></BootGate>);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('shell')).toBeNull();
    fetch.mockImplementation(async () => answer(200));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('shell')).toBeTruthy();
  });

  it('treats a proxy 502 as nobody there, and comes back on the quiet retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    render(<BootGate><p>shell</p></BootGate>);
    await screen.findByRole('alert');
    fetch.mockImplementation(async () => answer(200));
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    await waitFor(() => expect(screen.getByText('shell')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 503 buddi explains is an answer, not an outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(503, { error: 'starting' })));
    render(<BootGate><p>shell</p></BootGate>);
    expect(await screen.findByText('shell')).toBeTruthy();
  });
});

describe('LostBar', () => {
  it('shows after thirty seconds of silence and goes on recovery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.fn(async (): Promise<Response> => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetch);
    render(<LostBar />);
    await api.version().catch(() => {});
    expect(screen.queryByText('Lost buddi. Retrying…')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText('Lost buddi. Retrying…')).toBeTruthy();
    fetch.mockImplementation(async () => answer(200));
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    await waitFor(() => expect(screen.queryByText('Lost buddi. Retrying…')).toBeNull());
  });
});
