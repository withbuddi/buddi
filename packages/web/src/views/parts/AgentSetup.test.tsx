import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type AgentsView } from '../../api';
import { AgentSetup } from './AgentSetup';
vi.mock('../../api', () => ({ api: { agents: vi.fn(), accountModels: vi.fn().mockResolvedValue({ models: [], truncated: false }), assignProviderAccount: vi.fn(), setAgentEngine: vi.fn() } }));
const accounts = ['Personal', 'Work'].map((label, i) => ({ id: `account-${i}`, label, kind: 'anthropic' as const, auth: 'api-key' as const,
  baseUrl: '', defaultModel: 'claude-sonnet-5', enabled: true, revision: 1, configured: true, refreshable: false,
  tokenExpiresAt: null, subscriptionRenewsAt: null, assignedAgents: [], test: null }));
const view = { agents: [{ id: 'demo', handle: 'demo', name: 'Demo', description: 'Fixture', isDefault: true, tools: [], skills: [], delegates: [], isExample: false,
  model: 'claude-haiku-4-5', maxTurns: 12, language: 'en', provider: { kind: 'anthropic', credentialKind: 'api-key', credentialEnv: 'fixture' } }],
  engines: [{ id: 'demo', provider: 'anthropic', model: 'claude-haiku-4-5', maxTurns: 12, language: 'en', available: true }], providers: [],
  providerAccounts: { vault: { kind: 'memory', locked: false, advice: '' }, accounts,
    bindings: [{ agentId: 'demo', accountId: 'account-0', model: 'claude-haiku-4-5' }] },
} as unknown as AgentsView;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.agents).mockResolvedValue(view); vi.mocked(api.assignProviderAccount).mockResolvedValue({ changed: ['account'], note: 'Saved' }); });
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
