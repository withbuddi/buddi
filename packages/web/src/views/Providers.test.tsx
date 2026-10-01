import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ProviderAccountsView } from '../api';
import { Providers } from './Providers';
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: { providerAccounts: vi.fn(), accountModels: vi.fn().mockResolvedValue({ models: [], truncated: false }), probeModels: vi.fn(), saveProviderAccount: vi.fn(), removeProviderAccount: vi.fn(), testProviderAccount: vi.fn(), codexAccountAction: vi.fn(), anthropicAccountAction: vi.fn(), ollamaConnect: vi.fn(), ollamaPoll: vi.fn(), ollamaDisconnect: vi.fn(), ollama: vi.fn(), mlxh: vi.fn() } }));
const view: ProviderAccountsView = { vault: { kind: 'file', locked: false, advice: '' }, bindings: [], accounts: [{
  id: 'one', label: 'Personal OpenAI', kind: 'openai', auth: 'api-key', baseUrl: '',
  defaultModel: 'gpt-5', enabled: true, revision: 1, configured: true, refreshable: false,
  tokenExpiresAt: null, subscriptionRenewsAt: null, assignedAgents: [], test: null,
}] };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.providerAccounts).mockResolvedValue(view); vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'two' }); vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' }); });
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
it('offers Codex account creation when the host allows it', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, codexEnabled: true });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  expect(screen.getByLabelText('Account name')).toHaveValue('Anthropic API');
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
  expect(screen.getByLabelText('Account name')).toHaveValue('ChatGPT subscription');
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
  expect(screen.getByDisplayValue('ABCD-1234')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open openai.com' })).toHaveAttribute('href', 'http://localhost/device');
  expect(screen.getByRole('link', { name: 'Open openai.com' })).toHaveAttribute('rel', 'noreferrer');
  expect(screen.getByText(/The code works until/)).toBeInTheDocument();
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
  expect(screen.getByText(/Tested at/)).toHaveTextContent('not a quota reset or subscription renewal date');
  expect(screen.getByText(/Tested at/).closest('.ui-notice')).toBeNull();
  expect(screen.getByText('Provider limit.').closest('.ui-notice')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByText(/Provider suggested retry time:/)).toHaveTextContent('not a guaranteed quota reset');
  expect(api.testProviderAccount).not.toHaveBeenCalled();
});
it('draws a successful test in the good tone without a state label', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0]!, test: {
    state: 'connected', message: 'Connection succeeded.', checkedAt: '2026-09-19T02:00:00Z',
  } }] });
  render(<Providers />);
  const verdict = await screen.findByText('Connection succeeded.');
  expect(verdict.closest('.ui-notice')).toHaveAttribute('data-tone', 'good');
  expect(screen.queryByText(/connected:/)).not.toBeInTheDocument();
});
it('states reset time is unknown when no retry advice was supplied', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0]!, test: {
    state: 'rate-limited', message: 'Provider limit.', checkedAt: '2026-09-19T02:00:00Z', retryAt: null,
  } }] });
  render(<Providers />);
  expect(await screen.findByText(/Reset time is unknown/)).toBeInTheDocument();
  expect(screen.queryByText(/Provider suggested retry time:/)).not.toBeInTheDocument();
});
it('opens the add sheet with a proposed name, and explains the disabled save button once it is cleared', async () => {
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  expect(screen.getByLabelText('Account name')).toHaveFocus();
  expect(screen.getByLabelText('Account name')).toHaveValue('Anthropic API');
  expect(screen.getByRole('button', { name: 'Save account' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
  expect(screen.getByText(/Enter an account name/)).toBeInTheDocument();
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

it('proposes a name per provider and numbers a taken one', async () => {
  const { suggestedLabel } = await import('./Providers');
  expect(suggestedLabel('anthropic', 'api-key', [])).toBe('Anthropic API');
  expect(suggestedLabel('anthropic', 'anthropic-oauth', [])).toBe('Claude subscription');
  expect(suggestedLabel('codex', 'chatgpt', [])).toBe('ChatGPT subscription');
  expect(suggestedLabel('openai-compatible', 'none', ['Local endpoint', 'local endpoint 2'])).toBe('Local endpoint 3');
});
it('loads models from an endpoint before saving, and saves the picked one', async () => {
  vi.mocked(api.probeModels).mockResolvedValue({ models: [{ id: 'qwen3:8b', name: 'qwen3:8b', isDefault: false }, { id: 'llama3', name: 'llama3', isDefault: true }], truncated: false });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } });
  expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
  await waitFor(() => expect(api.probeModels).toHaveBeenCalledWith({ kind: 'openai-compatible', auth: 'none', baseUrl: 'http://localhost:11434/v1' }));
  expect(await screen.findByLabelText('Model')).toHaveValue('llama3');
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({ kind: 'openai-compatible', auth: 'none', defaultModel: 'llama3', label: 'Local endpoint' })));
});
it('adds Ollama Cloud with a device key by default, or a key when asked', async () => {
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'ollama-cloud' } });
  expect(screen.getByLabelText('Account name')).toHaveValue('Ollama Cloud');
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('API base URL')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Use a key instead')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({ kind: 'openai-compatible', auth: 'device-key', baseUrl: '', defaultModel: 'gpt-oss:120b', label: 'Ollama Cloud' })));
  expect(api.saveProviderAccount).not.toHaveBeenCalledWith(expect.objectContaining({ secret: expect.anything() }));
});
it('switches Ollama Cloud to a key, with the address the gateway names', async () => {
  vi.mocked(api.ollama).mockResolvedValue({ running: false, models: [], downloadUrl: 'd', baseUrl: 'b', cloudBaseUrl: 'http://localhost/cloud-fixture/v1' });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'ollama-cloud' } });
  fireEvent.click(screen.getByLabelText('Use a key instead'));
  expect(await screen.findByDisplayValue('http://localhost/cloud-fixture/v1')).toBeInTheDocument();
  expect(screen.getByLabelText('API key')).toBeInTheDocument();
});
it('connects Ollama from the account card: window in the click, poll, connected-as line, disconnect', async () => {
  const cloud = { ...view.accounts[0]!, id: 'cloud', label: 'Ollama Cloud', kind: 'openai-compatible' as const, auth: 'device-key' as const, baseUrl: 'https://ollama.com/v1', configured: false, device: null };
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [cloud] });
  vi.mocked(api.ollamaConnect).mockResolvedValue({ state: 'pending', attemptId: 'try', verificationUrl: 'http://localhost/connect-fixture', deviceName: 'buddi on studio', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const opened = { location: { href: '' }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
  render(<Providers />);
  expect(await screen.findByText('Ollama Cloud', { selector: '.accounts-row-sub' , exact: false })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Connect Ollama' }));
  expect(open).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(opened.location.href).toBe('http://localhost/connect-fixture'));
  expect(api.ollamaConnect).toHaveBeenCalledWith('cloud', 1);

  // The server now says the attempt is pending; the card polls it.
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...cloud, revision: 2, device: { deviceName: 'buddi on studio', username: null, connectedAt: null },
    login: { state: 'pending', attemptId: 'try', verificationUrl: 'http://localhost/connect-fixture', expiresAt: new Date(Date.now() + 60_000).toISOString() } }] });
  vi.mocked(api.ollamaPoll).mockResolvedValue({ state: 'connected', username: 'amen', deviceName: 'buddi on studio' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByRole('link', { name: 'Open the ollama.com page' })).toHaveAttribute('rel', 'noreferrer');
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...cloud, revision: 2, configured: true, device: { deviceName: 'buddi on studio', username: 'amen', connectedAt: '2026-09-26T10:00:00Z' } }] });
  expect(await screen.findByText('Connected as amen, device buddi on studio.', undefined, { timeout: 4_000 })).toBeInTheDocument();
  expect(api.ollamaPoll).toHaveBeenCalledWith('cloud', 'try');

  vi.mocked(api.ollamaDisconnect).mockResolvedValue({ removed: true, unpaired: true, note: 'Disconnected. The key is gone from buddi, and ollama.com no longer lists this device.' });
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(api.ollamaDisconnect).toHaveBeenCalledWith('cloud', 2));
  // The server's own sentence: whether ollama.com confirmed it forgot the device.
  expect(await screen.findByText(/no longer lists this device/)).toBeInTheDocument();
}, 10_000);

it('says whose the detected context window is', async () => {
  const { detectedWindowSource } = await import('./Providers');
  expect(detectedWindowSource({ kind: 'codex', detectedContextWindowSource: 'provider' })).toBe('from ChatGPT');
  expect(detectedWindowSource({ kind: 'openai-compatible', detectedContextWindowSource: 'provider' })).toBe('from the provider');
  expect(detectedWindowSource({ kind: 'openai', detectedContextWindowSource: 'table' })).toBe('assumed');
  expect(detectedWindowSource({ kind: 'codex' })).toBe('assumed');
});
it('names mlxh\'s prompt limit as the window source, with how to raise it', async () => {
  const { detectedWindowSource, providerName } = await import('./Providers');
  expect(detectedWindowSource({ kind: 'openai-compatible', detectedContextWindowSource: 'mlxh', detectedContextWindowTokens: 8192 }))
    .toBe('mlxh’s max_prompt_tokens; raise it with `mlxh config max_prompt_tokens 40960` for long conversations');
  expect(detectedWindowSource({ kind: 'openai-compatible', detectedContextWindowSource: 'mlxh', detectedContextWindowTokens: 40960 })).toBe('mlxh’s max_prompt_tokens');
  expect(providerName({ kind: 'openai-compatible', auth: 'none', detectedContextWindowSource: 'mlxh' })).toBe('mlxh');
});
it('adds mlxh as a preset: the gateway\'s address, no key, the first language model, and the model list after the save', async () => {
  const probe = { running: true, baseUrl: 'http://localhost/mlxh-fixture/v1', manager: true, models: [
    { id: 'klein', loaded: true, kind: 'image' as const }, { id: 'bonsai2', loaded: false }, { id: 'gemma4-e2b-it', loaded: true, kind: 'language' as const },
  ] };
  vi.mocked(api.mlxh).mockResolvedValue(probe);
  let saved = false;
  const row = { ...view.accounts[0]!, id: 'two', label: 'mlxh', kind: 'openai-compatible' as const, auth: 'none' as const, baseUrl: probe.baseUrl, defaultModel: 'gemma4-e2b-it', detectedContextWindowSource: 'mlxh' as const };
  vi.mocked(api.providerAccounts).mockImplementation(async () => ({ ...view, accounts: saved ? [...view.accounts, row] : view.accounts }));
  vi.mocked(api.saveProviderAccount).mockImplementation(async () => { saved = true; return { id: 'two' }; });
  vi.mocked(api.accountModels).mockResolvedValue({ models: [
    { id: 'gemma4-e2b-it', name: 'gemma4-e2b-it', isDefault: false }, { id: 'klein', name: 'klein', isDefault: false, image: true },
  ], truncated: false });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'mlxh' } });
  expect(screen.getByLabelText('Account name')).toHaveValue('mlxh');
  await waitFor(() => expect(screen.getByLabelText(/API base URL/)).toHaveValue(probe.baseUrl));
  expect(screen.queryByLabelText('Authentication')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.getByText(/klein: an image model; pick it in the Image plugin, not here/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith({
    label: 'mlxh', kind: 'openai-compatible', auth: 'none', baseUrl: probe.baseUrl, defaultModel: 'gemma4-e2b-it', enabled: true,
  }));
  // No test call on save: that would be a prompt, and loading a model takes a minute.
  expect(api.testProviderAccount).not.toHaveBeenCalled();
  expect(await screen.findByText(/Pick the model this account offers by default/)).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /klein — an image model; pick it in the Image plugin, not here/ })).toBeInTheDocument();
});
it('says how to start mlxh when it is not answering, and keeps Save off', async () => {
  vi.mocked(api.mlxh).mockResolvedValue({ running: false, baseUrl: 'http://127.0.0.1:1060/v1', manager: false, models: [] });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'mlxh' } });
  expect(await screen.findByText('mlxh is not answering on 127.0.0.1:1060. Start it with `mlxh serve`, or `mlxh service install` to keep it running.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
});
it('adds Gemini as a preset: Google\'s address and the name filled in, a key, the newest Pro, and the model list after the save', async () => {
  const gemini = { baseUrl: 'http://localhost/google-fixture/openai/', keyUrl: 'http://localhost/key-page' };
  let saved = false;
  const row = { ...view.accounts[0]!, id: 'two', label: 'Gemini', kind: 'openai-compatible' as const, baseUrl: 'http://localhost/google-fixture/openai', defaultModel: 'gemini-3.1-pro-preview' };
  vi.mocked(api.providerAccounts).mockImplementation(async () => ({ ...view, gemini, accounts: saved ? [...view.accounts, row] : view.accounts }));
  vi.mocked(api.saveProviderAccount).mockImplementation(async () => { saved = true; return { id: 'two' }; });
  vi.mocked(api.probeModels).mockResolvedValue({ models: ['models/gemini-2.5-pro', 'models/gemini-3.1-pro-preview', 'models/gemini-3.8-flash'].map((id) => ({ id, name: id, isDefault: false })), truncated: false });
  vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gemini' } });
  expect(screen.getByLabelText('Account name')).toHaveValue('Gemini');
  expect(screen.getByLabelText(/API base URL/)).toHaveValue(gemini.baseUrl);
  expect(screen.queryByLabelText('Authentication')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Get a key at aistudio.google.com' })).toHaveAttribute('href', gemini.keyUrl);
  expect(screen.getByRole('button', { name: 'Save account' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
    label: 'Gemini', kind: 'openai-compatible', auth: 'api-key', baseUrl: gemini.baseUrl, secret: 'AIza-fixture', defaultModel: 'gemini-3.1-pro-preview',
  })));
  // The next step is the model list, not the end.
  expect(await screen.findByText(/Pick the model this account offers by default/)).toBeInTheDocument();
});
it('starts the Gemini preset on the newest Flash when Google refuses Pro on its first test', async () => {
  const gemini = { baseUrl: 'http://localhost/google-fixture/openai/', keyUrl: 'http://localhost/key-page' };
  let saved = false;
  let model = '';
  const row = () => ({ ...view.accounts[0]!, id: 'two', label: 'Gemini', kind: 'openai-compatible' as const, baseUrl: 'http://localhost/google-fixture/openai', defaultModel: model });
  vi.mocked(api.providerAccounts).mockImplementation(async () => ({ ...view, gemini, accounts: saved ? [...view.accounts, row()] : view.accounts }));
  vi.mocked(api.saveProviderAccount).mockImplementation(async (body) => { saved = true; model = body.defaultModel; return { id: 'two' }; });
  vi.mocked(api.probeModels).mockResolvedValue({ models: ['models/gemini-3.1-pro', 'models/gemini-3.8-flash-lite', 'models/gemini-3.8-flash'].map((id) => ({ id, name: id, isDefault: false })), truncated: false });
  vi.mocked(api.testProviderAccount).mockImplementation(async () =>
    model === 'gemini-3.1-pro' ? { state: 'rate-limited', message: 'no', httpStatus: 429 } : { state: 'connected', message: 'ok' });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gemini' } });
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  expect(await screen.findByText(/free tier has no Pro allowance, so it starts on gemini-3\.8-flash/)).toBeInTheDocument();
  expect(vi.mocked(api.saveProviderAccount).mock.calls.at(-1)![0]).toMatchObject({ id: 'two', defaultModel: 'gemini-3.8-flash' });
  expect(api.testProviderAccount).toHaveBeenCalledTimes(2);
});
it('tries a pasted key before finishing, and refuses a wrong one where it was typed', async () => {
  vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'authentication-error', message: 'Anthropic did not accept this key.', httpStatus: 401 });
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [...view.accounts, { ...view.accounts[0]!, id: 'two', revision: 4 }] });
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'fixture-wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  expect(await screen.findByText(/That key was refused\. Check it and paste it again\./)).toBeInTheDocument();
  expect(api.testProviderAccount).toHaveBeenCalledWith('two');
  expect(api.removeProviderAccount).toHaveBeenCalledWith('two', 4);
  // Still on the form, key field open.
  expect(screen.getByLabelText('API key')).toBeInTheDocument();
  expect(screen.queryByText(/Saved “/)).not.toBeInTheDocument();
});
it('opens the account a link names, not the first one', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [view.accounts[0]!, { ...view.accounts[0]!, id: 'gem', label: 'Gemini' }] });
  render(<Providers account="gem" />);
  expect(await screen.findByRole('button', { name: /Gemini/, pressed: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Personal OpenAI/, pressed: false })).toBeInTheDocument();
});
it('shows the account id, small and copyable, for --account', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<Providers />);
  const id = await screen.findByText('one', { selector: 'code' });
  expect(id).toHaveClass('accounts-id-text');
  fireEvent.click(screen.getByRole('button', { name: 'Copy the id of this account' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('one'));
  expect(await screen.findByRole('button', { name: 'Copy the id of this account' })).toHaveTextContent('Copied');
});
it('says a spent daily quota on the row and the detail, with when it resets and the one fix', async () => {
  const until = new Date(Date.now() + 2 * 3600_000).toISOString();
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0]!, label: 'Gemini', kind: 'openai-compatible', assignedAgents: ['ledger'],
    rateLimit: { scope: 'day', until, limit: 20, unit: 'requests', freeTier: true, provider: 'Gemini', model: 'gemini-2.5-flash' } }] });
  render(<Providers />);
  expect(await screen.findByText('Rate-limited')).toBeInTheDocument();
  expect(screen.getByText(/· back at /)).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByText(/^Rate-limited until /)).toBeInTheDocument();
  const notice = screen.getByText("Gemini's free tier allows 20 requests a day").closest('.ui-notice');
  expect(notice).toHaveAttribute('data-tone', 'warning');
  expect(notice).toHaveTextContent(/It resets (at|tomorrow at) /);
  expect(notice).toHaveTextContent('aistudio.google.com');
  expect(screen.getByRole('link', { name: "Change ledger's account" })).toHaveAttribute('href', expect.stringContaining('ledger'));
});
it("says a ChatGPT plan's usage limit as the plan's, not a day's", async () => {
  const until = new Date(Date.now() + 2 * 3600_000).toISOString();
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [{ ...view.accounts[0]!, label: 'ChatGPT', kind: 'codex', assignedAgents: ['ledger'],
    rateLimit: { scope: 'day', until, limit: null, unit: null, freeTier: false, provider: 'ChatGPT', model: null } }] });
  render(<Providers />);
  const notice = (await screen.findByText('This ChatGPT plan has reached its usage limit')).closest('.ui-notice');
  expect(notice).toHaveTextContent(/It resets (at|tomorrow at) /);
  expect(notice).toHaveTextContent('To keep going before then, give ledger another account.');
  expect(notice).not.toHaveTextContent('a day');
});
it('says a burst limit with its window and no fix, and forgets a limit that has lapsed', async () => {
  vi.mocked(api.providerAccounts).mockResolvedValue({ ...view, accounts: [
    { ...view.accounts[0]!, rateLimit: { scope: 'burst', until: new Date(Date.now() + 60_000).toISOString(), limit: null, unit: null, freeTier: false, provider: 'OpenAI', model: null } },
    { ...view.accounts[0]!, id: 'two', label: 'Old limit', rateLimit: { scope: 'day', until: new Date(Date.now() - 60_000).toISOString(), limit: 20, unit: 'requests', freeTier: true, provider: 'Gemini', model: null } },
  ] });
  render(<Providers />);
  const notice = (await screen.findByText('OpenAI asked buddi to slow down')).closest('.ui-notice');
  expect(notice).toHaveTextContent(/It said to wait until /);
  expect(notice?.querySelector('a, button')).toBeNull();
  expect(screen.getAllByText('Rate-limited')).toHaveLength(1);
});
