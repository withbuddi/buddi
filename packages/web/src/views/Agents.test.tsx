/**
 * The team grid: a card opens its agent on Conversations, and Talk goes
 * straight to a chat without opening the sheet on the way.
 */
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { api, chatApi } from '../api';
import type { ChatAgent } from '../chat/types';
import { Agents } from './Agents';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: { ...real.api, agents: vi.fn() },
    chatApi: { ...real.chatApi, conversations: vi.fn() },
  };
});

const dev: ChatAgent = {
  id: 'developer', handle: 'dev', name: 'Developer', description: 'Writes code.',
  available: true, roles: [], provider: 'anthropic', model: 'claude-test',
} as ChatAgent;

let visited: string[] = [];

function Harness({ start }: { start: string }): JSX.Element {
  const [hash, setHash] = useState(start);
  const navigate = (next: string): void => { visited.push(next); setHash(next); };
  return <Agents hash={hash} timezone="UTC" navigate={navigate} agents={[dev]} attention={new Map()} />;
}

beforeEach(() => {
  visited = [];
  vi.clearAllMocks();
  vi.mocked(api.agents).mockResolvedValue({ agents: [], default: { defaultAgentId: null, choices: [], problem: null } } as never);
  vi.mocked(chatApi.conversations).mockResolvedValue({ conversations: [] } as never);
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
