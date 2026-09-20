/**
 * Groups on the page: the route, and a room's turns drawn under their speakers.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it } from 'vitest';
import { groupChatRoute, parseChatRoute, parseGroupChatRoute } from '../routes';
import { MessageList } from './MessageList';
import type { ChatAgent, ChatMessage } from './types';

afterEach(cleanup);

const agent = (id: string, name: string): ChatAgent => ({ id, handle: id, name, description: '', available: true, roles: [], provider: 'openai', model: 'm' });
const speakers = [agent('concierge', 'Concierge'), agent('ledger', 'Ledger')];
const text = (t: string) => ({ type: 'text' as const, text: t });

describe('the group route', () => {
  it('is its own namespace, never mistaken for an agent', () => {
    expect(groupChatRoute('g-1')).toBe('#/chat/g/g-1');
    expect(parseGroupChatRoute('#/chat/g/g-1/c-2')).toEqual({ groupId: 'g-1', conversationId: 'c-2' });
    expect(parseChatRoute('#/chat/g/g-1')).toBeNull();
    expect(parseChatRoute('#/chat/ledger')).toEqual({ agentId: 'ledger' });
  });
});

describe('a room in the thread', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', at: '', speaker: 'owner', blocks: [text('Review my spending')] },
    { id: '2', role: 'assistant', at: '', speaker: 'concierge', blocks: [text('On it.')] },
    { id: '3', role: 'user', at: '', speaker: 'concierge', blocks: [text('You are a member of the group "Money". @concierge, the coordinator, asks you now:\n\nSummarise September.\n\nAnswer for the room: state what you found.')] },
    { id: '4', role: 'assistant', at: '', speaker: 'ledger', blocks: [text('You spent 1,200.')] },
    { id: '5', role: 'user', at: '', speaker: 'room', blocks: [text('Ledger has finished.')] },
  ];

  it('puts the owner on one side, every member under its own name, and the coordinator tagged', () => {
    render(<Tooltip.Provider><MessageList messages={messages} live={[]} now={0} onOpen={() => {}} speakers={speakers} coordinatorId="concierge" emptyHint="" /></Tooltip.Provider>);
    const rows = [...document.querySelectorAll('.wb-msg')];
    expect(rows[0]!.getAttribute('data-role')).toBe('user');
    expect(rows[1]!.getAttribute('data-role')).toBe('assistant');
    expect(rows[1]!.querySelector('.wb-msg-who')!.textContent).toContain('Concierge');
    expect(rows[1]!.querySelector('.wb-msg-role')!.textContent).toBe('coordinator');
    expect(screen.getByText('Ledger')).toBeDefined();
  });

  it('draws the coordinator asking a member as one line naming who answered', () => {
    render(<Tooltip.Provider><MessageList messages={messages} live={[]} now={0} onOpen={() => {}} speakers={speakers} coordinatorId="concierge" emptyHint="" /></Tooltip.Provider>);
    expect(screen.getByText('Concierge asked Ledger: Summarise September.')).toBeDefined();
    expect(screen.queryByText(/You are a member of the group/)).toBeNull();
    expect(screen.getByText('Ledger has finished.').closest('.wb-msg')!.getAttribute('data-role')).toBe('room');
  });

  it('names who is working from the run, not from the page title', () => {
    render(<Tooltip.Provider><MessageList messages={messages} live={[]} now={0} onOpen={() => {}} speakers={speakers} working workingAs="Ledger" agentName="Money" emptyHint="" /></Tooltip.Provider>);
    expect(screen.getByRole('status').textContent).toContain('Ledger is working');
  });
});
