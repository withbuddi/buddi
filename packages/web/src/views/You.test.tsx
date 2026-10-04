/**
 * Settings → You: how times and dates read (saved with the profile, applied
 * to the open pages at once) and the owner's places — Home and Work offered
 * until set, a place found from its address with its zone, saved, removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type OwnerView } from '../api';
import { displayFormats, setDisplayFormats } from '../format';
import { answered } from '../test/answered';
import { You } from './You';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return { ...real, api: { owner: vi.fn(), setOwner: vi.fn(), findPlace: vi.fn(), savePlace: vi.fn(), removePlace: vi.fn() } };
});

const HOME = { id: 'home', label: 'Home', address: '12 Elm St, Portland, Maine', name: 'Portland, Maine, United States', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York' };

function owner(over: Partial<OwnerView> = {}): OwnerView {
  return {
    preferredName: 'Amen',
    timezone: 'America/New_York',
    language: null,
    about: null,
    displayName: null,
    timeFormat: null,
    dateFormat: null,
    places: [],
    detectedTimezone: 'America/New_York',
    zones: ['America/New_York', 'Europe/Paris', 'America/Los_Angeles'],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => setDisplayFormats({ timeFormat: null, dateFormat: null, locale: 'en-GB' }));

describe('You', () => {
  it('saves Time and Dates with the profile, and the open pages read them at once', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner());
    vi.mocked(api.setOwner).mockResolvedValue(owner({ timeFormat: '12h', dateFormat: 'short' }));
    render(<You />);
    await answered(api.owner);
    expect(await screen.findByDisplayValue('Amen')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '12h' } });
    fireEvent.change(screen.getByLabelText(/^Dates/), { target: { value: 'short' } });
    expect(screen.getByLabelText('Time')).toHaveValue('12h');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setOwner).toHaveBeenCalledWith(expect.objectContaining({ timeFormat: '12h', dateFormat: 'short' })));
    await waitFor(() => expect(displayFormats()).toEqual({ time: '12h', date: 'short' }));
  });

  it('saves who the owner is: full name, pronouns and a birthday with or without a year', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner());
    vi.mocked(api.setOwner).mockResolvedValue(owner({ fullName: 'Amenophis Mouzou', pronouns: 'he/him', birthday: { day: 2, month: 10, year: null } }));
    render(<You />);
    await answered(api.owner);
    fireEvent.change(await screen.findByLabelText(/^Full name/), { target: { value: 'Amenophis Mouzou' } });
    fireEvent.change(screen.getByLabelText(/^Pronouns/), { target: { value: 'he/him' } });
    // Half a date is not saved, and says what it needs.
    fireEvent.change(screen.getByLabelText('Birthday: day'), { target: { value: '2' } });
    expect(screen.getByText('A day and a month; the year is optional, four digits.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Birthday: month'), { target: { value: '10' } });
    expect(screen.getByText('The year is optional. Your team greets you on the day.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setOwner).toHaveBeenCalledWith(expect.objectContaining({
      fullName: 'Amenophis Mouzou', pronouns: 'he/him', birthday: { day: 2, month: 10, year: null },
    })));
  });

  it('shows a saved birthday and clears it when emptied', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ birthday: { day: 14, month: 3, year: 1990 } }));
    vi.mocked(api.setOwner).mockResolvedValue(owner());
    render(<You />);
    await answered(api.owner);
    expect(await screen.findByLabelText('Birthday: year (optional)')).toHaveValue('1990');
    expect(screen.getByLabelText('Birthday: month')).toHaveValue('3');
    fireEvent.change(screen.getByLabelText('Birthday: day'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Birthday: month'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Birthday: year (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setOwner).toHaveBeenCalledWith(expect.objectContaining({ birthday: null })));
  });

  it('offers Home and Work until they are set, and shows a place’s address and country', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ places: [{ ...HOME, address: '12 Elm St, Portland' }] }));
    render(<You />);
    await answered(api.owner);
    expect(await screen.findByText('12 Elm St, Portland · United States')).toBeInTheDocument();
    expect(screen.getByLabelText('Work: add')).toBeInTheDocument();
    expect(screen.queryByLabelText('Home: add')).not.toBeInTheDocument();
  });

  it('finds a place from its address, takes its zone, and saves it', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner());
    vi.mocked(api.findPlace).mockResolvedValue({
      found: [
        { name: 'Portland, Oregon, United States', latitude: 45.52, longitude: -122.68, timezone: 'America/Los_Angeles' },
        { name: 'Portland, Maine, United States', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York' },
      ],
    });
    vi.mocked(api.savePlace).mockResolvedValue({ place: HOME, places: [HOME] });
    render(<You />);
    await answered(api.owner);
    fireEvent.click(within(await screen.findByLabelText('Home: add')).getByRole('button', { name: 'Add' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(sheet).getByLabelText(/^Address/), { target: { value: '12 Elm St, Portland, Maine' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Find' }));
    const maine = await within(sheet).findByRole('radio', { name: /Portland, Maine/ });
    fireEvent.click(maine);
    expect(within(sheet).getByLabelText(/^Its timezone/)).toHaveValue('America/New_York');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.savePlace).toHaveBeenCalledWith({
        label: 'Home',
        address: '12 Elm St, Portland, Maine',
        name: 'Portland, Maine, United States',
        latitude: 43.66,
        longitude: -70.26,
        timezone: 'America/New_York',
      }),
    );
    expect(await screen.findByText('12 Elm St, Portland, Maine · United States')).toBeInTheDocument();
  });

  it('removes a place from its sheet', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ places: [HOME] }));
    vi.mocked(api.removePlace).mockResolvedValue({ places: [] });
    render(<You />);
    await answered(api.owner);
    fireEvent.click(await screen.findByLabelText('Home: edit'));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removePlace).toHaveBeenCalledWith('home'));
    expect(await screen.findByLabelText('Home: add')).toBeInTheDocument();
  });
});
