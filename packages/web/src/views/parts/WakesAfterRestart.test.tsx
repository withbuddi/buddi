/**
 * A plugin first run installed that only a restart can load: said with its
 * Restart button, and nothing when every plugin loaded live.
 */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../api';
import { WakesAfterRestart, wakesSentence } from './WakesAfterRestart';

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
});
