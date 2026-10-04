/**
 * "Save this login for amazon.com?" above the Page tab's window: the site and
 * the user name, Save · Not now · Never for this site, each one call to the
 * answer route with the question's id — never a password, which this page
 * never has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../api';
import { SaveLoginCard, LOGIN_CARD_MS } from './SaveLoginCard';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return { ...original, api: { ...original.api, browserLogin: vi.fn() } };
});

const LOGIN = { id: 'q1', site: 'amazon.com', username: 'sam.smith@example.com' };

describe('the save-login card', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('asks about the site, says whose login in short, and offers the three answers with Save on the right', () => {
    render(<SaveLoginCard login={LOGIN} onDone={vi.fn()} />);
    expect(screen.getByText('Save this login for amazon.com?')).toBeInTheDocument();
    expect(screen.getByTestId('save-login')).toHaveTextContent('For sam.smith@….');
    expect(screen.getByTestId('save-login')).not.toHaveTextContent('example.com');
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Never for this site', 'Not now', 'Save']);
  });

  it('Save calls the route with the id and says it was saved', async () => {
    vi.mocked(api.browserLogin).mockResolvedValue({ outcome: 'saved', saved: { name: 'login · amazon.com', site: 'amazon.com', username: LOGIN.username, savedAt: '2026-10-03T09:00:00Z' } });
    const onDone = vi.fn();
    render(<SaveLoginCard login={LOGIN} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.browserLogin).toHaveBeenCalledWith('q1', 'save'));
    expect(await screen.findByText('Saved the login for amazon.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Keys and secrets' })).toBeInTheDocument();
  });

  it('Not now and Never each answer once and close the card', async () => {
    vi.mocked(api.browserLogin).mockResolvedValue({ outcome: 'dismissed' });
    const later = vi.fn();
    const { unmount } = render(<SaveLoginCard login={LOGIN} onDone={later} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(later).toHaveBeenCalled());
    expect(api.browserLogin).toHaveBeenCalledWith('q1', 'later');
    unmount();

    vi.mocked(api.browserLogin).mockResolvedValue({ outcome: 'never' });
    const never = vi.fn();
    render(<SaveLoginCard login={{ ...LOGIN, id: 'q2' }} onDone={never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Never for this site' }));
    await waitFor(() => expect(never).toHaveBeenCalled());
    expect(api.browserLogin).toHaveBeenLastCalledWith('q2', 'never');
  });

  it('says so when the sign-in is no longer held, and goes by itself after two minutes', async () => {
    vi.mocked(api.browserLogin).mockResolvedValue({ outcome: 'gone' });
    render(<SaveLoginCard login={LOGIN} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer held');

    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<SaveLoginCard login={{ ...LOGIN, id: 'q3' }} onDone={onDone} />);
    act(() => { vi.advanceTimersByTime(LOGIN_CARD_MS); });
    expect(onDone).toHaveBeenCalled();
  });
});
