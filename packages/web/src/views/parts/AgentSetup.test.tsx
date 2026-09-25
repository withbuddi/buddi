import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type AgentsView } from '../../api';
import { AgentSetup } from './AgentSetup';
vi.mock('../../api', () => ({ AGENTS_CHANGED: 'buddi:agents-changed', api: { uploadAgentPicture: vi.fn(), removeAgentPicture: vi.fn(), agents: vi.fn(), accountModels: vi.fn().mockResolvedValue({ models: [], truncated: false }), assignProviderAccount: vi.fn(), setAgentEngine: vi.fn(), agentTools: vi.fn(), agentFile: vi.fn(), updateAgentFile: vi.fn() } }));
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
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.agentFile).mockResolvedValue({ id: 'demo', file: '/agents/demo/agent.md', frontmatter: {}, persona: 'You are Demo.\n\nKeep it short.' }); vi.mocked(api.agents).mockResolvedValue(view); vi.mocked(api.agentTools).mockResolvedValue(tools); vi.mocked(api.assignProviderAccount).mockResolvedValue({ changed: ['account'], note: 'Saved' }); });
it('lets the owner explicitly select a second account from the same provider', async () => {
  render(<AgentSetup agentId="demo" section="brain" />);
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
  render(<AgentSetup agentId="demo" section="access" />);
  fireEvent.click(await screen.findByRole('button', { name: 'All orchard tools' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save roles and tools' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalledWith('demo', expect.objectContaining({ tools: ['orchard.*'] })));
  const error = await screen.findByRole('alert');
  expect(error).toHaveTextContent('I cannot grant that.');
  // Beside the button, in the same toolbar, not in a banner at the top.
  expect(error.parentElement).toContainElement(screen.getByRole('button', { name: 'Save roles and tools' }));
});

it('sends no tools and no roles when only the name changed', async () => {
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: ['name'], personaChanged: false, live: true, message: 'ok' });
  render(<AgentSetup agentId="demo" />);
  await screen.findByRole('button', { name: 'All orchard tools', hidden: true });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Demo Two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save who it is' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalled());
  expect(vi.mocked(api.updateAgentFile).mock.calls[0]![1]).not.toHaveProperty('tools');
  expect(vi.mocked(api.updateAgentFile).mock.calls[0]![1]).not.toHaveProperty('roles');
});

it('sends no tools when only a role changed', async () => {
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: ['roles'], personaChanged: false, live: true, message: 'ok' });
  render(<AgentSetup agentId="demo" section="access" />);
  await screen.findByRole('button', { name: 'All orchard tools' });
  fireEvent.change(screen.getByLabelText('Other roles'), { target: { value: 'pickers' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save roles and tools' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalledWith('demo', { roles: ['pickers'] }));
});

it('uploads a picture beside the Face, previews it, and removes it', async () => {
  const changed = vi.fn();
  window.addEventListener('buddi:agents-changed', changed);
  const createObjectURL = vi.fn(() => 'blob:preview');
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  vi.mocked(api.uploadAgentPicture).mockResolvedValue({ picture: '/api/agents/demo/avatar?v=1', side: 512, source: 'gif', note: 'A GIF keeps its first frame only.' });
  render(<AgentSetup agentId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change face' }));
  const input = await screen.findByLabelText('Choose a picture');
  expect(screen.getByRole('button', { name: 'Save picture' })).toBeDisabled();
  const file = new File(['GIF89a'], 'me.gif', { type: 'image/gif' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(document.querySelector('img[src="blob:preview"]')).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
  await waitFor(() => expect(api.uploadAgentPicture).toHaveBeenCalledWith('demo', file));
  expect(await screen.findByText('A GIF keeps its first frame only.')).toBeInTheDocument();
  expect(changed).toHaveBeenCalled();
  window.removeEventListener('buddi:agents-changed', changed);
});

it('offers Remove only when there is a picture', async () => {
  vi.mocked(api.agents).mockResolvedValue({ ...view, agents: [{ ...view.agents[0]!, picture: '/api/agents/demo/avatar?v=2' }] } as AgentsView);
  vi.mocked(api.removeAgentPicture).mockResolvedValue(undefined);
  render(<AgentSetup agentId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change face' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove picture' }));
  await waitFor(() => expect(api.removeAgentPicture).toHaveBeenCalledWith('demo'));
});

it('shows the persona from the file, and saves an edit to it with the rest of who it is', async () => {
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: [], personaChanged: true, live: true, message: '@demo updated.' });
  render(<AgentSetup agentId="demo" />);
  const persona = await screen.findByLabelText('Persona');
  expect(persona).toHaveValue('You are Demo.\n\nKeep it short.');
  expect(screen.queryByText(/is not edited here/)).not.toBeInTheDocument();
  fireEvent.change(persona, { target: { value: 'You are Demo.\n\nKeep it shorter.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save who it is' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalledWith('demo', expect.objectContaining({ persona: 'You are Demo.\n\nKeep it shorter.' })));
});

it('sends no persona when it was not touched', async () => {
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: ['name'], personaChanged: false, live: true, message: 'ok' });
  render(<AgentSetup agentId="demo" />);
  await screen.findByLabelText('Persona');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Demo Two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save who it is' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalled());
  expect(vi.mocked(api.updateAgentFile).mock.calls[0]![1]).not.toHaveProperty('persona');
});

it('picks a face as the wizard does: a mascot is uploaded as the picture, an emoji replaces it on save', async () => {
  vi.mocked(api.agents).mockResolvedValue({ ...view, agents: [{ ...view.agents[0]!, picture: '/api/agents/demo/avatar?v=2' }] } as AgentsView);
  vi.mocked(api.uploadAgentPicture).mockResolvedValue({ picture: '/api/agents/demo/avatar?v=3', side: 512, source: 'png' });
  vi.mocked(api.removeAgentPicture).mockResolvedValue(undefined);
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: ['avatar'], personaChanged: false, live: true, message: 'ok' });
  const fetched = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }));
  vi.stubGlobal('fetch', fetched);
  render(<AgentSetup agentId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change face' }));
  // The picture it wears now is shown chosen.
  expect(await screen.findByRole('button', { name: 'The current picture' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByLabelText(/An emoji/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Buddi Blob, finance' }));
  await waitFor(() => expect(api.uploadAgentPicture).toHaveBeenCalledWith('demo', expect.objectContaining({ name: 'buddi-blob-finance.png' })));
  expect(fetched).toHaveBeenCalledWith('./mascot/finance.png');
  fireEvent.click(screen.getByRole('button', { name: '🦊' }));
  expect(screen.getByRole('button', { name: '🦊' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Save who it is' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalledWith('demo', expect.objectContaining({ avatar: '🦊' })));
  await waitFor(() => expect(api.removeAgentPicture).toHaveBeenCalledWith('demo'));
  vi.unstubAllGlobals();
});

it('opens the file chooser from a button and names the chosen file', async () => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
  render(<AgentSetup agentId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change face' }));
  const input = await screen.findByLabelText('Choose a picture');
  const click = vi.spyOn(input, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'Upload a picture' }));
  expect(click).toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [new File(['GIF89a'], 'me.gif', { type: 'image/gif' })] } });
  expect(await screen.findByText('me.gif')).toBeInTheDocument();
});

/** The fixture, with a second agent listed first that holds the front desk. */
function withRoles(demoRoles: string[]): AgentsView {
  const [demo] = view.agents;
  const concierge = { ...demo!, id: 'concierge', handle: 'concierge', name: 'Concierge', isDefault: false, roles: ['front-desk'] };
  return { ...view, agents: [concierge, { ...demo!, roles: demoRoles }] } as AgentsView;
}

it('offers the four known roles as chips, says who holds one elsewhere, and saves them first', async () => {
  vi.mocked(api.agents).mockResolvedValue(withRoles(['recap', 'orchard-lead']));
  vi.mocked(api.updateAgentFile).mockResolvedValue({ id: 'demo', handle: 'demo', file: '', tools: [], changed: ['roles'], personaChanged: false, live: true, message: 'ok' });
  render(<AgentSetup agentId="demo" section="access" />);
  const chips = await screen.findByRole('group', { name: 'Roles' });
  const chip = (label: string) => screen.getAllByRole('button').find((b) => b.querySelector('.role-chip-label')?.textContent === label)!;
  expect(chips.querySelectorAll('.role-chip')).toHaveLength(4);
  expect(chip('Front desk')).toHaveAttribute('aria-pressed', 'false');
  expect(chip('Recap')).toHaveAttribute('aria-pressed', 'true');
  expect(chip('Front desk')).toHaveTextContent('Where things go when you do not say who.');
  // Held by another agent: said so, and still allowed.
  expect(chip('Front desk')).toHaveTextContent('Held by Concierge.');
  expect(chip('Recap')).not.toHaveTextContent('Held by');
  // The others round-trip as text.
  expect(screen.getByLabelText('Other roles')).toHaveValue('orchard-lead');

  fireEvent.click(chip('Recap'));
  expect(chip('Recap')).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(chip('Maker'));
  fireEvent.click(chip('Front desk'));
  fireEvent.change(screen.getByLabelText('Other roles'), { target: { value: 'orchard-lead, pickers' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save roles and tools' }));
  await waitFor(() => expect(api.updateAgentFile).toHaveBeenCalled());
  expect(vi.mocked(api.updateAgentFile).mock.calls[0]![1]).toMatchObject({ roles: ['front-desk', 'maker', 'orchard-lead', 'pickers'] });
});

it('counts an unchanged set of roles as saved, whatever order the file lists them in', async () => {
  vi.mocked(api.agents).mockResolvedValue(withRoles(['orchard-lead', 'overview']));
  render(<AgentSetup agentId="demo" section="access" />);
  await screen.findByRole('group', { name: 'Roles' });
  expect(screen.getByRole('button', { name: 'Save roles and tools' })).toBeDisabled();
  const overview = screen.getAllByRole('button').find((b) => b.querySelector('.role-chip-label')?.textContent === 'Overview')!;
  fireEvent.click(overview);
  expect(screen.getByRole('button', { name: 'Save roles and tools' })).toBeEnabled();
  fireEvent.click(overview);
  expect(screen.getByRole('button', { name: 'Save roles and tools' })).toBeDisabled();
});

it('splits Setup into Identity, Brain and Access, and puts the choice in the address', async () => {
  const navigate = vi.fn();
  const { rerender } = render(<AgentSetup agentId="demo" navigate={navigate} />);
  const row = screen.getByRole('navigation', { name: 'Setup' });
  const links = within(row).getAllByRole('link');
  expect(links.map((l) => l.textContent)).toEqual(['Identity', 'Brain', 'Access']);
  expect(links.map((l) => l.getAttribute('href'))).toEqual(['#/agents/demo/setup/identity', '#/agents/demo/setup/brain', '#/agents/demo/setup/access']);
  expect(within(row).getByRole('link', { name: 'Identity', current: 'page' })).toBeInTheDocument();
  expect(await screen.findByRole('textbox', { name: 'Name' })).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Account' })).not.toBeInTheDocument();
  fireEvent.click(within(row).getByRole('link', { name: 'Brain' }));
  expect(navigate).toHaveBeenCalledWith('#/agents/demo/setup/brain');
  // The address is what the page reads back.
  rerender(<AgentSetup agentId="demo" section="access" navigate={navigate} />);
  expect(within(row).getByRole('link', { name: 'Access', current: 'page' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Roles' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
});

it('opens on the part the address names', async () => {
  render(<AgentSetup agentId="demo" section="brain" />);
  expect(await screen.findByRole('combobox', { name: 'Account' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Thinking' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Roles' })).not.toBeInTheDocument();
});

it('shows the face as one row, and opens the picker from Change face', async () => {
  render(<AgentSetup agentId="demo" />);
  const change = await screen.findByRole('button', { name: 'Change face' });
  expect(change).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByLabelText('Choose a picture')).not.toBeInTheDocument();
  fireEvent.click(change);
  expect(screen.getByRole('button', { name: 'Hide faces' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Choose a picture')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Buddi Blob, finance' })).toBeInTheDocument();
});

it('keeps the built-in context folded under Access, and the skills off Setup', async () => {
  vi.mocked(api.agents).mockResolvedValue({ ...view, agents: [{ ...view.agents[0]!, skills: [{ file: 'a.md', name: 'budgeting', provenance: 'owner' }] }] } as AgentsView);
  render(<AgentSetup agentId="demo" section="access" />);
  const summary = await screen.findByText('Built-in context');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(screen.queryByText(/budgeting/)).not.toBeInTheDocument();
});

it('keeps a draft that is not saved when the owner switches part and back', async () => {
  render(<AgentSetup agentId="demo" />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Demo Two' } });
  const row = screen.getByRole('navigation', { name: 'Setup' });
  fireEvent.click(within(row).getByRole('link', { name: 'Access' }));
  expect(screen.getByRole('button', { name: 'Save roles and tools' })).toBeDisabled();
  fireEvent.click(within(row).getByRole('link', { name: 'Identity' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Demo Two');
  expect(screen.getByRole('button', { name: 'Save who it is' })).toBeEnabled();
  expect(screen.getByText('Not saved yet.')).toBeVisible();
});

it('says the agent cannot run on Identity as well as on Brain', async () => {
  vi.mocked(api.agents).mockResolvedValue({ ...view, engines: [{ ...view.engines[0]!, available: false, unavailableReason: 'no credential' }] } as AgentsView);
  render(<AgentSetup agentId="demo" />);
  expect(await screen.findByText(/This agent cannot run right now\./)).toBeVisible();
  fireEvent.click(screen.getByRole('link', { name: 'See Brain.' }));
  expect(screen.getByText('This agent cannot run right now: no credential.')).toBeVisible();
});
