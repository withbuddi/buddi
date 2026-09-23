import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type AgentsView } from '../../api';
import { AgentSetup } from './AgentSetup';
vi.mock('../../api', () => ({ api: { agents: vi.fn(), accountModels: vi.fn().mockResolvedValue({ models: [], truncated: false }), assignProviderAccount: vi.fn(), setAgentEngine: vi.fn(), agentTools: vi.fn(), updateAgentFile: vi.fn() } }));
const accounts = ['Personal', 'Work'].map((label, i) => ({ id: `account-${i}`, label, kind: 'anthropic' as const, auth: 'api-key' as const,
  baseUrl: '', defaultModel: 'claude-sonnet-5', enabled: true, revision: 1, configured: true, refreshable: false,
  tokenExpiresAt: null, subscriptionRenewsAt: null, assignedAgents: [], test: null }));
const view = { agents: [{ id: 'demo', handle: 'demo', name: 'Demo', description: 'Fixture', isDefault: true, tools: [], skills: [], delegates: [], isExample: false,
  model: 'claude-haiku-4-5', maxTurns: 12, language: 'en', provider: { kind: 'anthropic', credentialKind: 'api-key', credentialEnv: 'fixture' } }],
  engines: [{ id: 'demo', provider: 'anthropic', model: 'claude-haiku-4-5', maxTurns: 12, language: 'en', available: true }], providers: [],
  providerAccounts: { vault: { kind: 'memory', locked: false, advice: '' }, accounts,
    bindings: [{ agentId: 'demo', accountId: 'account-0', model: 'claude-haiku-4-5' }] },
} as unknown as AgentsView;
const tools = {
  id: 'demo',
  granted: ['orchard.rows'],
  groups: [
    { plugin: 'orchard', glob: 'orchard.*', tools: [
      { name: 'orchard.rows', description: 'List the rows.', tier: 'auto', gated: false, grantable: true, core: false },
      { name: 'orchard.forecast', description: 'Project the harvest.', tier: 'auto', gated: false, grantable: true, core: false },
    ] },
  ],
};
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.agents).mockResolvedValue(view); vi.mocked(api.agentTools).mockResolvedValue(tools); vi.mocked(api.assignProviderAccount).mockResolvedValue({ changed: ['account'], note: 'Saved' }); });
it('lets the owner explicitly select a second account from the same provider', async () => {
  render(<AgentSetup agentId="demo" />);
  const select = await screen.findByLabelText('Account');
  expect(select).toHaveValue('account-0');
  fireEvent.change(select, { target: { value: 'account-1' } });
  expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-5');
  expect(api.assignProviderAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save account selection' }));
  await waitFor(() => expect(api.assignProviderAccount).toHaveBeenCalledWith('demo', 'account-1', 'claude-sonnet-5'));
  expect(api.setAgentEngine).not.toHaveBeenCalled();
});

it('saves a whole plugin as its glob, and shows a refused save beside the button', async () => {
  vi.mocked(api.updateAgentFile).mockRejectedValue(new Error('I cannot grant that.'));
  render(<AgentSetup agentId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'All orchard tools' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save who it is' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalledWith('demo', expect.objectContaining({ tools: ['orchard.*'] })));
  const error = await screen.findByRole('alert');
  expect(error).toHaveTextContent('I cannot grant that.');
  // Beside the button, in the same toolbar, not in a banner at the top.
  expect(error.parentElement).toContainElement(screen.getByRole('button', { name: 'Save who it is' }));
});

it('sends no tools when only the name changed', async () => {
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: ['name'], personaChanged: false, live: true, message: 'ok' });
  render(<AgentSetup agentId="demo" />);
  await screen.findByRole('button', { name: 'All orchard tools' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Demo Two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save who it is' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalled());
  expect(vi.mocked(api.updateAgentFile).mock.calls[0]![1]).not.toHaveProperty('tools');
});
