/** Settings → Lock screen: set a PIN, then the delay, the background, change and remove — each through the server. */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ApiError, api, type LockState } from '../api';
import manifest from '../../public/backgrounds/manifest.json';
import { forgetLockPictures } from '../shell/backgrounds';
import { LockSettings } from './LockSettings';

const none: LockState = { pin: false, locked: false, lockedAt: null, reason: null, delayMinutes: 5, background: 'field', image: null, waitUntil: null, triesLeft: null };
const set: LockState = { ...none, pin: true };

beforeEach(() => {
  forgetLockPictures();
  // The manifest answers; anything else fails as an unbuilt page's relative fetch does.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url) === 'backgrounds/manifest.json') return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new TypeError('Failed to parse URL');
    }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); forgetLockPictures(); });

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

  it('puts the colours in one row and the pictures in another: Earth, the shipped ones, then Add', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue({ ...set, background: 'earth' });
    render(<LockSettings navigate={() => {}} />);
    const colours = within(await screen.findByRole('group', { name: 'Colours' })).getAllByRole('button');
    expect(colours.map((b) => b.getAttribute('aria-label'))).toEqual(['Buddi', 'Dawn', 'Sea', 'Moss', 'Dusk']);
    const pictures = screen.getByRole('group', { name: 'Pictures' });
    await waitFor(() => expect(within(pictures).getAllByRole('button')).toHaveLength(3));
    expect(within(pictures).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Earth', 'Peoria autumn waterfront', 'Golden streak']);
    expect(within(pictures).getByRole('button', { name: 'Golden streak' }).querySelector('img')).toHaveAttribute('src', 'backgrounds/golden-streak-thumb.jpg');
    expect(within(pictures).getByText('Add')).toBeInTheDocument();
    expect(within(pictures).getByLabelText('Add your picture')).toHaveAttribute('type', 'file');
  });

  it('says the chosen picture’s credit under the pictures, and none for a colour', async () => {
    const state = vi.spyOn(api, 'lockState').mockResolvedValue({ ...set, background: 'picture:peoria-autumn-waterfront' });
    const save = vi.spyOn(api, 'setLockSettings').mockResolvedValue({ ...set, background: 'picture:golden-streak' });
    render(<LockSettings navigate={() => {}} />);
    const peoria = await screen.findByRole('button', { name: 'Peoria autumn waterfront' });
    expect(peoria).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Made with AI')).toHaveClass('lk-credit');
    state.mockResolvedValue({ ...set, background: 'picture:golden-streak' });
    await user().click(screen.getByRole('button', { name: 'Golden streak' }));
    expect(save).toHaveBeenLastCalledWith({ background: 'picture:golden-streak' });
    expect(await screen.findByText(/^After a photo by Valentine Rutto on Unsplash, reworked with AI/)).toHaveTextContent(
      'After a photo by Valentine Rutto on Unsplash, reworked with AI. Made for phones: a wide screen shows it whole, in the middle.',
    );
    // Credits are text: no link to a host the page does not fetch.
    expect(screen.queryByRole('link', { name: /Valentine Rutto|Unsplash/ })).toBeNull();
    state.mockResolvedValue({ ...set, background: 'moss' });
    save.mockResolvedValue({ ...set, background: 'moss' });
    await user().click(screen.getByRole('button', { name: 'Moss' }));
    await waitFor(() => expect(screen.queryByText(/Valentine Rutto/)).toBeNull());
    expect(document.querySelector('.lk-credit')).toBeNull();
  });

  it('takes a portrait version of the owner’s picture for phones, and removes it', async () => {
    const withImage: LockState = { ...set, background: 'image', image: '/api/lock/background?v=1', imagePortrait: null };
    const state = vi.spyOn(api, 'lockState').mockResolvedValue(withImage);
    const withPortrait: LockState = { ...withImage, imagePortrait: '/api/lock/background/portrait?v=2' };
    const upload = vi.spyOn(api, 'uploadLockPortrait').mockResolvedValue(withPortrait);
    const remove = vi.spyOn(api, 'removeLockPortrait').mockResolvedValue(withImage);
    render(<LockSettings navigate={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Your picture' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Phones show the middle of it/)).toBeInTheDocument();
    expect(screen.getByText('Replace')).toBeInTheDocument();
    const u = user();
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'tall.jpg', { type: 'image/jpeg' });
    state.mockResolvedValue(withPortrait);
    await u.upload(screen.getByLabelText('Portrait version for phones'), file);
    expect(upload).toHaveBeenCalledWith(file);
    expect(await screen.findByText('Phones show its portrait version.')).toBeInTheDocument();
    state.mockResolvedValue(withImage);
    await u.click(screen.getByRole('button', { name: 'Remove portrait' }));
    expect(remove).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Add portrait…' })).toBeInTheDocument();
  });

  it('offers Earth first among the pictures, pressed when it is the background, with the photo’s credit linked under the swatches', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue({ ...set, background: 'earth' });
    const save = vi.spyOn(api, 'setLockSettings').mockResolvedValue({ ...set, background: 'field' });
    render(<LockSettings navigate={() => {}} />);
    const earth = await screen.findByRole('button', { name: 'Earth' });
    expect(earth).toHaveAttribute('aria-pressed', 'true');
    expect(earth.querySelector('img')).not.toBeNull();
    expect(within(screen.getByRole('group', { name: 'Pictures' })).getAllByRole('button')[0]).toBe(earth);
    expect(screen.getByText(/Earth: photo by/)).toHaveTextContent('Earth: photo by ActionVance on Unsplash');
    expect(screen.getByRole('link', { name: 'ActionVance' })).toHaveAttribute('href', 'https://unsplash.com/@actionvance');
    expect(screen.getByRole('link', { name: 'Unsplash' })).toHaveAttribute('href', 'https://unsplash.com/photos/outer-space-photography-of-earth-t7EL2iG3jMc');
    await user().click(screen.getByRole('button', { name: 'Buddi' }));
    expect(save).toHaveBeenLastCalledWith({ background: 'field' });
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
