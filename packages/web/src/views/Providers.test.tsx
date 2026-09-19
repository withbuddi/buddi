import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ProviderAccountsView } from '../api';
import { Providers } from './Providers';
vi.mock('../api', () => ({ api: { providerAccounts: vi.fn(), saveProviderAccount: vi.fn(), removeProviderAccount: vi.fn(), testProviderAccount: vi.fn() } }));
const view: ProviderAccountsView = { vault: { kind: 'file', locked: false, advice: '' }, bindings: [], accounts: [{
  id: 'one', label: 'Personal OpenAI', kind: 'openai', auth: 'api-key', baseUrl: '',
  defaultModel: 'gpt-5', enabled: true, revision: 1, configured: true, refreshable: false,
  tokenExpiresAt: null, subscriptionRenewsAt: null, assignedAgents: [], test: null,
}] };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.providerAccounts).mockResolvedValue(view); vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'two' }); });
it('renders named accounts without modifying or testing them on load', async () => {
  render(<Providers />);
  expect(await screen.findByText('Personal OpenAI')).toBeInTheDocument();
  expect(api.testProviderAccount).not.toHaveBeenCalled();
  expect(api.saveProviderAccount).not.toHaveBeenCalled();
});
it('saves a new independent credential from a password field and clears the field', async () => {
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Second Anthropic' } });
  const field = screen.getByLabelText('API key');
  expect(field).toHaveAttribute('type', 'password');
  fireEvent.change(field, { target: { value: 'fixture-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({ label: 'Second Anthropic', secret: 'fixture-secret', kind: 'anthropic' })));
  expect(field).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('fixture-secret');
});
it('requires confirmation before removal and sends the account revision', async () => {
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove account' }));
  expect(api.removeProviderAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await waitFor(() => expect(api.removeProviderAccount).toHaveBeenCalledWith('one', 1));
});
it('blocks removal of assigned accounts and shows vault guidance', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, vault: { kind: 'file', locked: true, advice: 'Unlock the host vault.' }, accounts: [{ ...view.accounts[0]!, assignedAgents: ['ledger'] }] });
  render(<Providers />);
  expect(await screen.findByText('Unlock the host vault.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove account' })).toBeDisabled();
  expect(screen.getByText('Used by: ledger')).toBeInTheDocument();
});
