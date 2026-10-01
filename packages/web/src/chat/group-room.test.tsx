/**
 * A group's room acts on the group: its ⋯ menu (Members, Rename, Clear
 * history, Delete), the Members sheet, the dialogs that ask first, and what
 * happens to the page when the open group is deleted and brought back.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { api, chatApi } from '../api';
import { chatRoute, groupChatRoute } from '../routes';
import { ClearGroupModal, DeleteGroupModal, MembersSheet, RenameGroupModal, groupProblem } from '../shell/GroupRoom';
import { ChatPage } from './ChatPage';
import type { ChatAgent, GroupView } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const agent = (id: string, name: string): ChatAgent => ({ id, handle: id, name, description: `${name} does things.`, available: true, roles: [], provider: 'fixture', model: 'fixture' });
const KEEPER = agent('keeper', 'Keeper');
const LEDGER = agent('ledger', 'Ledger');
const SCOUT = agent('scout', 'Scout');
const AGENTS = [KEEPER, LEDGER, SCOUT];
const GROUP: GroupView = { id: '11111111-2222-3333-4444-555555555555', name: 'Money week', coordinator: 'keeper', members: ['keeper', 'ledger'], contextCapChars: 40_000, createdAt: '' };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '#/'); });

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ conversations: [], views: [] }), { status: 200 })));
}

describe('the room header menu', { timeout: 180_000 }, () => {
  const room = async (group: GroupView, agents: ChatAgent[] = AGENTS): Promise<ReturnType<typeof vi.fn>> => {
    stubFetch();
    const acted = vi.fn();
    await act(async () => {
      render(
        <ChatPage
          timezone="UTC"
          agents={{ top: [], middle: agents, bottom: [] }}
          agentId={group.coordinator}
          group={group}
          onGroupAction={acted}
          onSelectAgent={() => {}}
          attention={new Map()}
          agentsInHeader={false}
          narrow={false}
        />,
      );
    });
    return acted;
  };

  it('is about the group: members, rename, clear and delete — never links to its agents', async () => {
    const acted = await room(GROUP);
    fireEvent.click(screen.getByTestId('chat-menu'));
    const menu = screen.getByRole('menu', { name: 'Money week' });
    const items = within(menu).getAllByRole('menuitem').map((item) => item.querySelector('.ui-menu-item-text')!.textContent);
    expect(items).toEqual(['Members', 'Rename…', 'Clear history…', 'Delete group…']);
    // The old menu listed each agent with "open page"; none of that is here.
    expect(within(menu).queryAllByRole('link')).toHaveLength(0);
    expect(within(menu).queryByText(/open page/i)).toBeNull();
    expect(within(menu).queryByText('Properties')).toBeNull();
    expect(within(menu).getByText('2 agents · Keeper coordinates')).toBeDefined();
    expect(within(menu).getByTestId('group-delete').getAttribute('data-tone')).toBe('critical');
    fireEvent.click(within(menu).getByTestId('group-delete'));
    expect(acted).toHaveBeenCalledWith('delete');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the agent menu an agent menu', async () => {
    stubFetch();
    await act(async () => {
      render(<ChatPage timezone="UTC" agents={{ top: [], middle: AGENTS, bottom: [] }} agentId="keeper" onSelectAgent={() => {}} attention={new Map()} agentsInHeader={false} narrow={false} />);
    });
    fireEvent.click(screen.getByTestId('chat-menu'));
    expect(within(screen.getByRole('menu')).getByText('Properties')).toBeDefined();
    expect(within(screen.getByRole('menu')).queryByText(/Delete group/)).toBeNull();
  });

  it('a room whose coordinator left buddi has no composer, and the way to fix it', async () => {
    const acted = await room({ ...GROUP, coordinator: 'advisor', members: ['advisor', 'keeper', 'ledger'] });
    const problem = screen.getByTestId('group-problem');
    expect(problem.getAttribute('data-kind')).toBe('coordinator');
    expect(problem.textContent).toContain('advisor coordinated this group and is no longer in buddi');
    expect(screen.queryByTestId('composer-slot')).toBeNull();
    fireEvent.click(within(problem).getByRole('button', { name: 'Choose a coordinator' }));
    expect(acted).toHaveBeenCalledWith('members');
  });

  it('a room with one member left says so and keeps its composer', async () => {
    await room({ ...GROUP, members: ['keeper', 'gone'] });
    expect(screen.getByTestId('group-problem').getAttribute('data-kind')).toBe('alone');
    expect(screen.getByTestId('group-problem').textContent).toContain('Only Keeper is left here: gone was removed from buddi.');
    expect(screen.getByTestId('composer-slot')).toBeDefined();
  });

  it('says nothing when nobody is missing', () => {
    expect(groupProblem(GROUP, AGENTS)).toBeNull();
  });
});

describe('the members sheet', { timeout: 180_000 }, () => {
  const user = (): ReturnType<typeof userEvent.setup> => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

  it('lists the coordinator first with its part, and adds a member in one step', async () => {
    const saved = vi.fn();
    const update = vi.spyOn(chatApi, 'updateGroup').mockResolvedValue({ ...GROUP, members: ['keeper', 'ledger', 'scout'] });
    render(<MembersSheet group={{ ...GROUP, members: ['ledger', 'keeper'] }} agents={AGENTS} onClose={() => {}} onSaved={saved} />);
    const rows = [...document.querySelectorAll('.ui-list')][0]!.querySelectorAll('.ui-list-title');
    expect([...rows].map((r) => r.textContent)).toEqual(['Keeper', 'Ledger']);
    expect(screen.getByText('Coordinator')).toBeDefined();
    await user().click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(GROUP.id, { members: ['ledger', 'keeper', 'scout'] }));
    expect(saved).toHaveBeenCalled();
  });

  it('takes a member out, and hands over the coordinator part, from the row menu', async () => {
    const three = { ...GROUP, members: ['keeper', 'ledger', 'scout'] };
    const update = vi.spyOn(chatApi, 'updateGroup').mockResolvedValue(three);
    render(<MembersSheet group={three} agents={AGENTS} onClose={() => {}} onSaved={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'More for Scout' }));
    await user().click(await screen.findByRole('menuitem', { name: /Remove from group/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(GROUP.id, { members: ['keeper', 'ledger'] }));
    await user().click(screen.getByRole('button', { name: 'More for Ledger' }));
    await user().click(await screen.findByRole('menuitem', { name: /Make coordinator/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(GROUP.id, { coordinator: 'ledger' }));
  });

  it('draws an agent buddi no longer has, and lets it be taken out when two would remain', async () => {
    const update = vi.spyOn(chatApi, 'updateGroup').mockResolvedValue(GROUP);
    render(<MembersSheet group={{ ...GROUP, members: ['keeper', 'ledger', 'gone'] }} agents={AGENTS} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText('gone')).toBeDefined();
    expect(screen.getByText('No longer in buddi')).toBeDefined();
    await user().click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(GROUP.id, { members: ['keeper', 'ledger'] }));
  });
});

describe('the dialogs that ask first', { timeout: 180_000 }, () => {
  beforeEach(() => {
    vi.spyOn(chatApi, 'group').mockResolvedValue({ ...GROUP, latestConversationId: null, openRequest: null, history: { conversations: 4, messages: 30 } });
  });

  it('renames with the name as it is, and saves the new one', async () => {
    const update = vi.spyOn(chatApi, 'updateGroup').mockResolvedValue({ ...GROUP, name: 'Money' });
    const saved = vi.fn();
    render(<RenameGroupModal group={GROUP} onClose={() => {}} onSaved={saved} />);
    const box = screen.getByRole('textbox') as HTMLInputElement;
    expect(box.value).toBe('Money week');
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Money' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(GROUP.id, { name: 'Money' }));
    expect(saved).toHaveBeenCalledWith({ ...GROUP, name: 'Money' });
  });

  it('clear names what goes and what stays, and keeps the group', async () => {
    const clear = vi.spyOn(chatApi, 'clearGroup').mockResolvedValue({ conversations: 4 });
    const deleted = vi.spyOn(chatApi, 'deleteGroup');
    const cleared = vi.fn();
    render(<ClearGroupModal group={GROUP} onClose={() => {}} onCleared={cleared} />);
    expect(await screen.findByText(/Its 4 conversations are deleted for good/)).toBeDefined();
    expect(screen.getByText(/The group, its members and what it remembers stay/)).toBeDefined();
    fireEvent.click(screen.getByTestId('group-clear-confirm'));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(GROUP.id));
    expect(cleared).toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('delete names the history and says the agents are untouched', async () => {
    const remove = vi.spyOn(chatApi, 'deleteGroup').mockResolvedValue({ undoUntil: '2026-10-01T12:01:00Z' });
    const deleted = vi.fn();
    render(<DeleteGroupModal group={GROUP} agents={AGENTS} onClose={() => {}} onDeleted={deleted} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete Money week?');
    expect(await screen.findByText(/The group goes with its 4 conversations and what it remembers\. Keeper and Ledger are not touched/)).toBeDefined();
    fireEvent.click(screen.getByTestId('group-delete-confirm'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(GROUP.id));
    expect(deleted).toHaveBeenCalledWith('2026-10-01T12:01:00Z');
  });
});

describe('deleting the open group', { timeout: 180_000 }, () => {
  beforeEach(() => {
    window.history.replaceState(null, '', chatRoute('ledger', 'new'));
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC' } as never);
    vi.spyOn(api, 'overview').mockResolvedValue({ approvals: { pending: 0 }, jobs: { failed: 0 } } as never);
    vi.spyOn(chatApi, 'agents').mockResolvedValue({ agents: AGENTS, defaultAgentId: 'keeper' });
    vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
    vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [] });
    vi.spyOn(chatApi, 'groupConversations').mockResolvedValue({ conversations: [] });
    vi.spyOn(chatApi, 'group').mockResolvedValue({ ...GROUP, latestConversationId: null, openRequest: null, history: { conversations: 2, messages: 9 } });
  });

  it('goes back to the chat the owner was in, and Undo brings the group back where it was', async () => {
    let listed: GroupView[] = [GROUP];
    vi.spyOn(chatApi, 'groups').mockImplementation(async () => ({ groups: listed }));
    vi.spyOn(chatApi, 'deleteGroup').mockImplementation(async () => { listed = []; return { undoUntil: new Date(Date.now() + 60_000).toISOString() }; });
    const restore = vi.spyOn(chatApi, 'restoreGroup').mockImplementation(async () => { listed = [GROUP]; return GROUP; });

    render(<App />);
    await screen.findByTestId('chat-head');
    // Into the room from the rail.
    fireEvent.click(await screen.findByRole('button', { name: /Money week, 2 agents/ }));
    await waitFor(() => expect(window.location.hash).toBe(groupChatRoute(GROUP.id)));
    fireEvent.click(screen.getByTestId('chat-menu'));
    fireEvent.click(screen.getByTestId('group-delete'));
    fireEvent.click(await screen.findByTestId('group-delete-confirm'));

    // Back to Ledger, where the owner was; the group off the rail at once.
    await waitFor(() => expect(window.location.hash).toBe(chatRoute('ledger', 'new')));
    expect(screen.queryByRole('button', { name: /Money week, 2 agents/ })).toBeNull();
    const toast = await screen.findByTestId('undo-toast');
    expect(toast).toHaveTextContent('Deleted Money week');

    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(GROUP.id));
    await waitFor(() => expect(window.location.hash).toBe(groupChatRoute(GROUP.id)));
    expect(await screen.findByRole('button', { name: /Money week, 2 agents/ })).toBeDefined();
  });

  it('clearing the history keeps the room open on a clean thread', async () => {
    vi.spyOn(chatApi, 'groups').mockResolvedValue({ groups: [GROUP] });
    const clear = vi.spyOn(chatApi, 'clearGroup').mockResolvedValue({ conversations: 2 });
    window.history.replaceState(null, '', groupChatRoute(GROUP.id, 'c-old'));
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c-old', agentId: 'keeper', messages: [] } as never);
    render(<App />);
    fireEvent.click(await screen.findByTestId('chat-menu'));
    fireEvent.click(screen.getByTestId('group-clear'));
    fireEvent.click(await screen.findByTestId('group-clear-confirm'));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(GROUP.id));
    await waitFor(() => expect(window.location.hash).toBe(groupChatRoute(GROUP.id)));
    expect(screen.getByTestId('chat-head')).toHaveTextContent('Money week');
  });
});
