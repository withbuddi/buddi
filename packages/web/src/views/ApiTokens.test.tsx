/**
 * Settings → API tokens: the rows say which token is which without showing
 * one, a new token is shown once with Copy, and revoking asks first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type ApiTokenView } from '../api';
import { ApiTokens, tokenLine } from './ApiTokens';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { apiTokens: vi.fn(), createApiToken: vi.fn(), revokeApiToken: vi.fn() },
}));

const HOME: ApiTokenView = {
  id: '6f1c2b9a-4d7e-4a03-9c55-2e8b1d7f4a10',
  name: 'Home Assistant',
  hint: 'k3Qz',
  scope: 'owner',
  createdVia: 'dashboard',
  createdAt: '2026-09-28T09:00:00.000Z',
  lastUsedAt: null,
};
const SECRET = 'buddi_Qm9yZXN0LWdyZWVuLWtpdGUtNzQxOS1zYW1wbGUtdG9rZW4';

beforeEach(() => { vi.clearAllMocks(); });

describe('Settings → API tokens', () => {
  it('lists each token by its name and last four characters, never the token', async () => {
    vi.mocked(api.apiTokens).mockResolvedValue({ tokens: [HOME, { ...HOME, id: 'b04e7d21-93a6-4f8c-a1d2-5c6e0f9b3e77', name: 'Cron', hint: 'W9_d', createdVia: 'cli', lastUsedAt: new Date(Date.now() - 120_000).toISOString() }] });
    render(<ApiTokens timezone="UTC" />);
    expect(await screen.findByText('Home Assistant')).toBeInTheDocument();
    expect(screen.getByText(/^buddi_…k3Qz · made .* here · never used$/)).toBeInTheDocument();
    expect(screen.getByText(/^buddi_…W9_d · made .* in the terminal · last used/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Revoke…' })).toHaveLength(2);
    expect(screen.getByText('What a token can’t do')).toBeInTheDocument();
  });

  it('says how to make one when there are none', async () => {
    vi.mocked(api.apiTokens).mockResolvedValue({ tokens: [] });
    render(<ApiTokens timezone="UTC" />);
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
    expect(screen.getByText('buddi api-token create <name>')).toBeInTheDocument();
  });

  it('asks what will use it, then shows the token once, with Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(api.apiTokens).mockResolvedValue({ tokens: [] });
    vi.mocked(api.createApiToken).mockResolvedValue({ token: SECRET, apiToken: { ...HOME, hint: SECRET.slice(-4) } });
    render(<ApiTokens timezone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make a token' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Make token' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' Home Assistant ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make token' }));
    await waitFor(() => expect(api.createApiToken).toHaveBeenCalledWith('Home Assistant'));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText('Copy it now')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    // The list is read again; Done closes, and the token is gone from the page.
    expect(api.apiTokens).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText(SECRET)).not.toBeInTheDocument());
  });

  it('asks before revoking, then reads the list again', async () => {
    vi.mocked(api.apiTokens).mockResolvedValue({ tokens: [HOME] });
    vi.mocked(api.revokeApiToken).mockResolvedValue(undefined);
    render(<ApiTokens timezone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke…' }));
    expect(await screen.findByText('Revoke “Home Assistant”?')).toBeInTheDocument();
    expect(api.revokeApiToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokeApiToken).toHaveBeenCalledWith(HOME.id));
    await waitFor(() => expect(api.apiTokens).toHaveBeenCalledTimes(2));
  });

  it('writes a row the way the kit does', () => {
    expect(tokenLine({ ...HOME, lastUsedAt: null }, 'UTC')).toMatch(/^buddi_…k3Qz · made .+ here · never used$/);
  });
});
