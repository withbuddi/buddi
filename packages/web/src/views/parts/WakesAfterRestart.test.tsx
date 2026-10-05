/**
 * A plugin first run installed that only a restart can load: said with its
 * Restart button, and nothing when every plugin loaded live.
 */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../api';
import { HANDOVER_WAKES_KEY, WakesAfterRestart, wakesSentence } from './WakesAfterRestart';

vi.mock('../../api', async (load) => {
  const real = await load<typeof import('../../api')>();
  return { ...real, api: { ...real.api, serviceAction: vi.fn(), takeOnProgress: vi.fn() } };
});

const calendar = { plugin: 'calendar', title: 'Calendar', state: 'ready' as const, wakesOnRestart: true };
const weather = { plugin: 'weather', title: 'Weather', state: 'ready' as const };

describe('a plugin that wakes up after a restart', () => {
  it('says which, in one sentence', () => {
    expect(wakesSentence([calendar])).toBe('Calendar is installed; it wakes up after a restart.');
    expect(wakesSentence([calendar, { ...weather, wakesOnRestart: true }])).toBe('Calendar and Weather are installed; they wake up after a restart.');
  });

  it('offers Restart on the handover, which asks the supervisor', async () => {
    vi.mocked(api.serviceAction).mockResolvedValue({} as never);
    render(<WakesAfterRestart plugins={[calendar, weather]} />);
    expect(screen.getByText(/Calendar is installed; it wakes up after a restart\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(api.serviceAction).toHaveBeenCalledWith('restart'));
  });

  it('draws nothing on Home when every plugin loaded live', async () => {
    vi.mocked(api.takeOnProgress).mockResolvedValue({ tiles: ['days'], plugins: [weather], running: false, waiting: [] });
    const { container } = render(<WakesAfterRestart />);
    await waitFor(() => expect(api.takeOnProgress).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('skips the read once first run is finished and its progress had nothing waiting', async () => {
    window.localStorage.removeItem(HANDOVER_WAKES_KEY);
    vi.mocked(api.takeOnProgress).mockReset().mockResolvedValue({ tiles: ['days'], plugins: [weather], running: false, waiting: [] });
    // Not read yet: it waits for the shell rather than asking early.
    const first = render(<WakesAfterRestart onboarding="unknown" />);
    await Promise.resolve();
    expect(api.takeOnProgress).not.toHaveBeenCalled();
    first.unmount();
    // The handover saw its progress: nothing waiting.
    render(<WakesAfterRestart plugins={[weather]} />).unmount();
    expect(window.localStorage.getItem(HANDOVER_WAKES_KEY)).toBe('0');
    const { container } = render(<WakesAfterRestart onboarding="done" />);
    await Promise.resolve();
    expect(api.takeOnProgress).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('still reads after first run when the handover had a plugin waiting, or was never seen here', async () => {
    vi.mocked(api.takeOnProgress).mockReset().mockResolvedValue({ tiles: ['days'], plugins: [calendar], running: false, waiting: [] });
    render(<WakesAfterRestart plugins={[calendar]} />).unmount();
    expect(window.localStorage.getItem(HANDOVER_WAKES_KEY)).toBe('1');
    const once = render(<WakesAfterRestart onboarding="done" />);
    expect(await screen.findByText(/Calendar is installed/)).toBeInTheDocument();
    once.unmount();
    window.localStorage.removeItem(HANDOVER_WAKES_KEY);
    vi.mocked(api.takeOnProgress).mockResolvedValue({ tiles: ['days'], plugins: [weather], running: false, waiting: [] });
    render(<WakesAfterRestart onboarding="done" />);
    await waitFor(() => expect(api.takeOnProgress).toHaveBeenCalledTimes(2));
    // What it found is kept, so the next Home does not ask.
    await waitFor(() => expect(window.localStorage.getItem(HANDOVER_WAKES_KEY)).toBe('0'));
  });
});
