/** Settings → Lock screen: set a PIN, then the delay, the background, change and remove — each through the server. */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ApiError, api, type LockState } from '../api';
import { LockSettings } from './LockSettings';

const none: LockState = { pin: false, locked: false, lockedAt: null, reason: null, delayMinutes: 5, background: 'field', image: null, waitUntil: null, triesLeft: null };
const set: LockState = { ...none, pin: true };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Settings → Lock screen', { timeout: 180_000 }, () => {
  const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

  it('says what it is, and sets a PIN only when the two match', async () => {
    const state = vi.spyOn(api, 'lockState').mockResolvedValue(none);
    const setPin = vi.spyOn(api, 'setPin').mockResolvedValue(set);
    render(<LockSettings navigate={() => {}} />);
    expect(await screen.findByText(/It isn’t a second sign-in/)).toBeInTheDocument();
    expect(screen.getByText('Set a PIN first.')).toBeInTheDocument();
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Set a PIN' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Set a PIN' });
    await u.type(within(dialog).getByLabelText('PIN'), '2468');
    await u.type(within(dialog).getByLabelText('The same again'), '2469');
    await u.click(within(dialog).getByRole('button', { name: 'Set PIN' }));
    expect(await within(dialog).findByText('The two PINs aren’t the same.')).toBeInTheDocument();
    expect(setPin).not.toHaveBeenCalled();
    await u.clear(within(dialog).getByLabelText('The same again'));
    await u.type(within(dialog).getByLabelText('The same again'), '2468');
    state.mockResolvedValue(set);
    await u.click(within(dialog).getByRole('button', { name: 'Set PIN' }));
    expect(setPin).toHaveBeenCalledWith('2468', undefined);
    expect(await screen.findByRole('button', { name: 'Change…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lock now/ })).toBeInTheDocument();
  });

  it('changes the delay and the background through the server', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue(set);
    const save = vi.spyOn(api, 'setLockSettings').mockResolvedValue({ ...set, delayMinutes: 15 });
    render(<LockSettings navigate={() => {}} />);
    const u = user();
    await u.click(await screen.findByRole('radio', { name: '15 min' }));
    expect(save).toHaveBeenCalledWith({ delayMinutes: 15 });
    await u.click(screen.getByRole('radio', { name: 'Never' }));
    expect(save).toHaveBeenLastCalledWith({ delayMinutes: null });
    await u.click(screen.getByRole('button', { name: 'Dawn' }));
    expect(save).toHaveBeenLastCalledWith({ background: 'dawn' });
    expect(screen.getByRole('button', { name: 'Buddi' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('removes the PIN only with the current one, and says how many tries are left', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue(set);
    const remove = vi.spyOn(api, 'removePin')
      .mockRejectedValueOnce(new ApiError(403, 'That isn’t your current PIN.', { triesLeft: 4, waitUntil: null }))
      .mockResolvedValueOnce(none);
    render(<LockSettings navigate={() => {}} />);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the PIN?' });
    await u.type(within(dialog).getByLabelText('Current PIN'), '1111');
    await u.click(within(dialog).getByRole('button', { name: 'Remove PIN' }));
    expect(await within(dialog).findByText('That isn’t your current PIN. 4 tries left.')).toBeInTheDocument();
    await u.clear(within(dialog).getByLabelText('Current PIN'));
    await u.type(within(dialog).getByLabelText('Current PIN'), '2468');
    await u.click(within(dialog).getByRole('button', { name: 'Remove PIN' }));
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith('2468'));
  });
});
