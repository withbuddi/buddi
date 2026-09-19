import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ProviderAccountsView } from '../api';
import { Providers } from './Providers';
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: { providerAccounts: vi.fn(), accountModels: vi.fn().mockResolvedValue({ models: [], truncated: false }), saveProviderAccount: vi.fn(), removeProviderAccount: vi.fn(), testProviderAccount: vi.fn(), codexAccountAction: vi.fn(), anthropicAccountAction: vi.fn() } }));
const view: ProviderAccountsView = { vault: { kind: 'file', locked: false, advice: '' }, bindings: [], accounts: [{
  id: 'one', label: 'Personal OpenAI', kind: 'openai', auth: 'api-key', baseUrl: '',
  defaultModel: 'gpt-5', enabled: true, revision: 1, configured: true, refreshable: false,
  tokenExpiresAt: null, subscriptionRenewsAt: null, assignedAgents: [], test: null,
}] };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.providerAccounts).mockResolvedValue(view); vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'two' }); });
it('creates a separate Claude OAuth account without a pasted API key', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, anthropicOAuthEnabled: true });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic-oauth' } });
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Claude personal' } });
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({ kind: 'anthropic', auth: 'anthropic-oauth', label: 'Claude personal' })));
  expect(api.anthropicAccountAction).not.toHaveBeenCalled();
});
it('completes Claude consent from the account card, clears the code, and does not put it in browser storage', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, anthropicOAuthEnabled: true, accounts: [{ ...view.accounts[0]!, kind: 'anthropic', auth: 'anthropic-oauth',
    login: { state: 'pending', attemptId: 'attempt', verificationUrl: 'http://localhost/consent-fixture', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  }] });
  render(<Providers />);
  expect(await screen.findByRole('link', { name: /Open Claude consent/ })).toHaveAttribute('rel', 'noreferrer');
  fireEvent.change(screen.getByLabelText('Claude authorization code'), { target: { value: 'fixture-secret#state' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete Claude sign-in' }));
  await waitFor(() => expect(api.anthropicAccountAction).toHaveBeenCalledWith('one', 'complete-login', 1, { attemptId: 'attempt', code: 'fixture-secret#state' }));
  expect(screen.getByLabelText('Claude authorization code')).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('fixture-secret');
});
it('shows Codex account creation only when the experiment is enabled', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, codexEnabled: true });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'My subscription' } });
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Default model')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex', auth: 'chatgpt', label: 'My subscription' })));
  expect(api.codexAccountAction).not.toHaveBeenCalled();
});
it('renders device sign-in inside the account card with cancellation and no paid test', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, codexEnabled: true, accounts: [{ ...view.accounts[0]!,
    kind: 'codex', auth: 'chatgpt', login: { state: 'pending', verificationUrl: 'http://localhost/device', userCode: 'ABCD-1234', expiresAt: '2026-09-19T12:00:00Z' },
  }] });
  render(<Providers />);
  expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'http://localhost/device' })).toHaveAttribute('rel', 'noreferrer');
  expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() => expect(api.codexAccountAction).toHaveBeenCalledWith('one', 'cancel-login', 1));
  expect(JSON.stringify(localStorage)).not.toContain('ABCD-1234');
});
it('renders named accounts without modifying or testing them on load', async () => {
  render(<Providers />);
  expect((await screen.findAllByText('Personal OpenAI'))[0]).toBeInTheDocument();
  expect(api.testProviderAccount).not.toHaveBeenCalled();
  expect(api.saveProviderAccount).not.toHaveBeenCalled();
});
it('labels test time separately from provider retry advice', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0]!, test: {
    state: 'rate-limited', message: 'Provider limit.', checkedAt: '2026-09-19T02:00:00Z', httpStatus: 429, retryAt: '2026-09-19T04:00:00.000Z',
  } }] });
  render(<Providers />);
  expect(await screen.findByText(/HTTP 429/)).toBeInTheDocument();
  expect(screen.getByText(/Tested at:/)).toHaveTextContent('not a quota reset or subscription renewal date');
  expect(screen.getByText(/Provider suggested retry time:/)).toHaveTextContent('not a guaranteed quota reset');
  expect(api.testProviderAccount).not.toHaveBeenCalled();
});
it('states reset time is unknown when no retry advice was supplied', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0]!, test: {
    state: 'rate-limited', message: 'Provider limit.', checkedAt: '2026-09-19T02:00:00Z', retryAt: null,
  } }] });
  render(<Providers />);
  expect(await screen.findByText(/Reset time is unknown/)).toBeInTheDocument();
  expect(screen.queryByText(/Provider suggested retry time:/)).not.toBeInTheDocument();
});
it('opens the add sheet, focuses its name, and explains the disabled save button', async () => {
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  expect(screen.getByLabelText('Account name')).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
  expect(screen.getByText(/The example name is a placeholder/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Account name')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add account' })).toHaveAttribute('aria-expanded', 'false');
});
it('shows refresh progress and completion without testing or changing credentials', async () => {
  render(<Providers />);
  const button = await screen.findByRole('button', { name: 'Refresh status' });
  let finish!: (value: ProviderAccountsView) => void;
  vi.mocked(api.providerAccounts).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(button);
  expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing account status');
  finish({ ...view, accounts: [{ ...view.accounts[0]!, configured: false }] });
  expect((await screen.findAllByText('Needs credential'))[0]).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Account status refreshed');
  expect(api.providerAccounts).toHaveBeenCalledTimes(2);
  expect(api.testProviderAccount).not.toHaveBeenCalled();
  expect(api.saveProviderAccount).not.toHaveBeenCalled();
});
it('reports refresh failures and allows a successful retry', async () => {
  render(<Providers />);
  const button = await screen.findByRole('button', { name: 'Refresh status' });
  vi.mocked(api.providerAccounts).mockRejectedValueOnce(new Error('Connection unavailable'));
  fireEvent.click(button);
  expect(await screen.findByText(/Could not refresh account status/)).toBeInTheDocument();
  expect(screen.getByText(/Error: Connection unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByText(/Account status refreshed/)).toBeInTheDocument();
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
  expect(screen.getByText('ledger')).toBeInTheDocument();
});
