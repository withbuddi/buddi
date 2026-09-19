import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ProvidersView } from '../api';
import { Providers } from './Providers';
vi.mock('../api', () => ({ api: { providers: vi.fn(), saveCredential: vi.fn(), removeCredential: vi.fn(), configureProvider: vi.fn(), testProvider: vi.fn() } }));
const view: ProvidersView = { vault: { kind: 'file', locked: false, advice: '' }, providers: [{
  kind: 'openai', credentialKind: 'api-key', credentialEnv: 'OPENAI_API_KEY', usable: true, defaultModel: 'gpt-5', defaultFrom: 'built-in', defaultEnv: 'BUDDI_OPENAI_MODEL', prefixes: ['gpt-'], models: [{ id: 'gpt-5', note: '' }],
  activeCredential: 'OPENAI_API_KEY', credentials: [{ name: 'OPENAI_API_KEY', configured: true, source: 'vault' }], test: null,
}] };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.providers).mockResolvedValue(view); });
it('does not test or modify credentials on page load and only submits keys from a password field', async () => {
  render(<Providers />);
  const field = await screen.findByLabelText(/OPENAI_API_KEY —/);
  expect(field).toHaveAttribute('type', 'password');
  expect(field).toHaveValue(''); expect(api.testProvider).not.toHaveBeenCalled();
  expect(api.saveCredential).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: 'fixture-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save OPENAI_API_KEY' }));
  await waitFor(() => expect(api.saveCredential).toHaveBeenCalledWith('OPENAI_API_KEY', 'fixture-secret'));
  expect(field).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('fixture-secret');
});
it('requires a separate confirmation before removing a credential', async () => {
  render(<Providers />);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove OPENAI_API_KEY' }));
  expect(api.removeCredential).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await waitFor(() => expect(api.removeCredential).toHaveBeenCalledWith('OPENAI_API_KEY'));
});
it('shows locked-vault guidance without requesting a key from chat', async () => {
  vi.mocked(api.providers).mockResolvedValue({ ...view, vault: { kind: 'file', locked: true, advice: 'Run buddi init on the host.' } });
  render(<Providers />);
  expect(await screen.findByText('Run buddi init on the host.')).toBeInTheDocument();
});
