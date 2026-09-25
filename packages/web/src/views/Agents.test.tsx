/**
 * The team grid: a card opens its agent on Conversations, and Talk goes
 * straight to a chat without opening the sheet on the way.
 */
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, chatApi } from '../api';
import type { ChatAgent } from '../chat/types';
import { Agents } from './Agents';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: { ...real.api, agents: vi.fn(), offers: vi.fn(), agentOffers: vi.fn(), dismissAgentOffer: vi.fn(), acceptPluginAgent: vi.fn(), approvals: vi.fn() },
    chatApi: { ...real.chatApi, conversations: vi.fn() },
  };
});

const dev: ChatAgent = {
  id: 'developer', handle: 'dev', name: 'Developer', description: 'Writes code.',
  available: true, roles: [], provider: 'anthropic', model: 'claude-test',
} as ChatAgent;

let visited: string[] = [];

const father: ChatAgent = {
  id: 'agent-father', handle: 'father', name: 'Agent Father', description: 'Makes agents.',
  available: true, roles: ['maker'], provider: 'anthropic', model: 'claude-test',
} as ChatAgent;

function Harness({ start, agents = [dev] }: { start: string; agents?: ChatAgent[] }): JSX.Element {
  const [hash, setHash] = useState(start);
  const navigate = (next: string): void => { visited.push(next); setHash(next); };
  return <Agents hash={hash} timezone="UTC" navigate={navigate} agents={agents} attention={new Map()} />;
}

beforeEach(() => {
  visited = [];
  vi.clearAllMocks();
  vi.mocked(api.agents).mockResolvedValue({ agents: [], default: { defaultAgentId: null, choices: [], problem: null } } as never);
  vi.mocked(chatApi.conversations).mockResolvedValue({ conversations: [] } as never);
  vi.mocked(api.offers).mockResolvedValue({ offers: [], closed: [] } as never);
  vi.mocked(api.agentOffers).mockResolvedValue({ offers: [] });
  vi.mocked(api.approvals).mockResolvedValue({ pending: [], recent: [] } as never);
});

/*
 * The agent a plugin offers is where an owner looks for offers: above the
 * agents' own, with both answers, and the no is the one Home hears.
 */
it('lists what the plugins offer under Offers, with Create and Not now', async () => {
  vi.mocked(api.agentOffers).mockResolvedValue({ offers: [{ plugin: 'email', agent: 'mail-triage', handle: 'mail', name: 'Mail', description: 'Triages mail.', text: 'Background triage needs a mail agent.' }] });
  vi.mocked(api.dismissAgentOffer).mockResolvedValue({ dismissed: true });
  render(<Harness start="#/agents?tab=offers" />);
  expect(await screen.findByText('From your plugins')).toBeInTheDocument();
  expect(screen.getByText('Background triage needs a mail agent.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create @mail' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(api.dismissAgentOffer).toHaveBeenCalledWith('email', 'mail-triage'));
});

it('opens the agent sheet on Conversations when the card is clicked', async () => {
  render(<Harness start="#/agents" />);
  fireEvent.click(screen.getByRole('link', { name: 'Developer' }));
  expect(visited).toEqual(['#/agents/developer/conversations']);
  expect(await screen.findByRole('link', { name: 'Conversations', current: 'page' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Setup' })).toHaveAttribute('href', '#/agents/developer/setup');
});

it('goes to the chat from Talk without opening the sheet', () => {
  render(<Harness start="#/agents" />);
  const talk = screen.getByRole('link', { name: 'Talk to Developer' });
  expect(talk).toHaveAttribute('href', '#/chat/developer');
  fireEvent.click(talk);
  expect(visited).toEqual(['#/chat/developer']);
  expect(screen.queryByRole('link', { name: 'Conversations' })).not.toBeInTheDocument();
});

it('still resolves a deep link to Setup', () => {
  render(<Harness start="#/agents/developer/setup" />);
  expect(screen.getByRole('link', { name: 'Setup', current: 'page' })).toBeInTheDocument();
  expect(within(document.body).getAllByRole('link', { name: 'Talk to Developer' }).length).toBeGreaterThan(0);
});

it('resolves a deep link to a part of Setup, and keeps Setup the current tab', () => {
  render(<Harness start="#/agents/developer/setup/brain" />);
  expect(screen.getByRole('link', { name: 'Setup', current: 'page' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Brain', current: 'page' })).toHaveAttribute('href', '#/agents/developer/setup/brain');
});

it('adds an agent by opening a chat with the maker, found by its role', () => {
  render(<Harness start="#/agents" agents={[dev, father]} />);
  const add = screen.getByRole('link', { name: 'Add an agent' });
  expect(add).toHaveAttribute('href', '#/chat/agent-father');
  fireEvent.click(add);
  expect(visited).toEqual(['#/chat/agent-father']);
});

it('has no Add an agent without a maker in the team', () => {
  render(<Harness start="#/agents" />);
  expect(screen.queryByRole('link', { name: 'Add an agent' })).not.toBeInTheDocument();
});

it('counts the open offers on the Offers tab and tags the default agent', async () => {
  vi.mocked(api.offers).mockResolvedValue({ offers: [{ id: 'o1' }, { id: 'o2' }], closed: [] } as never);
  vi.mocked(api.agents).mockResolvedValue({ agents: [], default: { defaultAgentId: 'developer', choices: [], problem: null } } as never);
  render(<Harness start="#/agents" />);
  expect(await screen.findByText('front desk')).toBeInTheDocument();
  expect(within(screen.getByRole('link', { name: /Offers/ })).getByText('2')).toBeInTheDocument();
});
