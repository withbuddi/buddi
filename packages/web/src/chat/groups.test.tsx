/**
 * Groups on the page: the route, and a room's turns drawn under their speakers.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatApi } from '../api';
import { groupChatRoute, parseChatRoute, parseGroupChatRoute } from '../routes';
import { GroupSheet } from '../shell/GroupSheet';
import { MessageList } from './MessageList';
import type { ChatAgent, ChatMessage } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

/*
 * The rail stops offering a group until there is somebody to group. A link
 * does not go through the rail, so the sheet refuses for itself.
 */
describe('the group sheet with nobody to group', () => {
  const maker = { ...agent('father', 'Agent Father'), roles: ['maker'] };

  it('says what is missing in one sentence, and offers no form', () => {
    render(<GroupSheet agents={[agent('ada', 'Ada'), maker]} onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByText('A group needs two agents. Make another one with Agent Father first.')).toBeDefined();
    // Nothing to fill in wrongly: no name, no members, no create button.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create group/ })).toBeNull();
  });

  it('draws the form once two agents could be in a room', () => {
    render(<GroupSheet agents={[agent('ada', 'Ada'), agent('ledger', 'Ledger'), maker]} onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByRole('button', { name: /Create group/ })).toBeDefined();
    expect(screen.queryByText(/A group needs two agents/)).toBeNull();
    // The maker is a settings door, so it is not offered as a member either.
    expect(screen.queryByText('Agent Father')).toBeNull();
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

/*
 * A group is not fixed at creation. The same sheet changes the one you have:
 * what it sends, and what it makes you read before it archives a room.
 */
describe('the group sheet in edit mode', () => {
  const agents = [agent('concierge', 'Concierge'), agent('ledger', 'Ledger'), agent('garage', 'Garage')];
  const group = { id: 'g-1', name: 'Test room', coordinator: 'concierge', members: ['concierge', 'ledger'], contextCapChars: 40_000, createdAt: '' };

  it('opens on the group as it is, and saves the whole membership, coordinator included', async () => {
    const saved = vi.fn();
    const update = vi.spyOn(chatApi, 'updateGroup').mockResolvedValue({ ...group, members: ['concierge', 'ledger', 'garage'] });
    render(<GroupSheet agents={agents} group={group} onClose={() => {}} onSaved={saved} />);

    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Test room');
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'concierge');
    // The current state is what the boxes show: Ledger in, Garage out.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);

    await userEvent.click(boxes[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('g-1', { name: 'Test room', coordinator: 'concierge', members: ['concierge', 'ledger', 'garage'] });
    expect(saved).toHaveBeenCalled();
  });

  it('archives only after a sentence saying what that does', async () => {
    const archived = vi.fn();
    const archive = vi.spyOn(chatApi, 'archiveGroup').mockResolvedValue(null);
    render(<GroupSheet agents={agents} group={group} onClose={() => {}} onArchived={archived} />);

    await userEvent.click(screen.getByTestId('group-archive'));
    expect(screen.getByText(/Archive Test room\? It leaves the rail and takes no new requests\./)).toBeDefined();
    expect(archive).not.toHaveBeenCalled();

    // And it can be backed out of.
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByTestId('group-archive-confirm')).toBeNull();
    expect(archive).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('group-archive'));
    await userEvent.click(screen.getByTestId('group-archive-confirm'));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('g-1'));
    expect(archived).toHaveBeenCalledWith('g-1');
  });

  it('keeps a member whose account broke, rather than dropping it on the next save', () => {
    const broken = { ...agent('scout', 'Scout'), available: false };
    render(
      <GroupSheet
        agents={[...agents, broken]}
        group={{ ...group, members: ['concierge', 'scout'] }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getAllByText('Scout').length).toBeGreaterThan(0);
  });
});
