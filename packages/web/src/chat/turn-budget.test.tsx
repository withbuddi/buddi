/**
 * A run that ran out of budget, said out loud.
 *
 * An owner watched an agent go quiet in the middle of a browser task: the run
 * had spent its turns, the loop ended after the last tool result, and the
 * thread showed nothing at all. The agent now says so itself, in words, as its
 * last message — and under that message the thread prints the fact behind the
 * words: which budget ran out, and after how many steps.
 *
 * The verdict rides on the conversation's runs, which the transcript endpoint
 * already sends, so a reloaded history draws the marker exactly as the live
 * run did.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import { MessageList } from './MessageList';
import type { ChatMessage, ChatRun } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function run(over: Partial<ChatRun>): ChatRun {
  return {
    runId: 'r1',
    surface: 'web',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:01:00.000Z',
    turns: 40,
    stopped: 'end_turn',
    // The default fixture is a run that said so; the tests that care say
    // otherwise. A budget stop that stayed silent is its own case below.
    noticed: true,
    usage: { input: 0, output: 0 },
    actionId: null,
    resumed: false,
    ...over,
  };
}

const said: ChatMessage[] = [
  { id: 'm1', role: 'user', at: '2026-01-01T10:00:01.000Z', blocks: [{ type: 'text', text: 'book the table' }] },
  { id: 'm2', role: 'assistant', at: '2026-01-01T10:00:40.000Z', blocks: [{ type: 'text', text: 'I got as far as the date picker.' }] },
];

function show(runs: ChatRun[]): void {
  render(
    <MessageList
      messages={said}
      runs={runs}
      agentName="Keeper"
      onOpen={() => {}}
      live={[]}
      now={Date.now()}
      emptyHint="Nothing yet."
      working={false}
    />,
  );
}

describe('the turn-budget marker', () => {
  it('marks the last message of a run that spent its turns', () => {
    show([run({ stopped: 'max_turns', turns: 40 })]);
    const marker = screen.getByTestId('budget-stop');
    expect(marker).toHaveTextContent('Turn budget reached · 40 steps');
    expect(marker.closest('.wb-msg')).toHaveAttribute('data-role', 'assistant');
  });

  it('says it differently when the answer itself ran too long', () => {
    show([run({ stopped: 'max_tokens', turns: 1 })]);
    expect(screen.getByTestId('budget-stop')).toHaveTextContent('Length limit reached · answer cut off');
  });

  /*
   * A room's runs overlap: the coordinator's spans the member's. Blaming the
   * member's answer for the coordinator's budget names the wrong agent, and
   * the member's answer finished perfectly well.
   */
  it('does not hang a run’s marker on a message a nested run wrote', () => {
    render(
      <MessageList
        messages={[
          said[0]!,
          { id: 'm2', role: 'assistant', at: '2026-01-01T10:00:30.000Z', blocks: [{ type: 'text', text: 'Ledger here.' }] },
        ]}
        runs={[
          run({ runId: 'coordinator', startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:50.000Z', stopped: 'max_turns', turns: 40 }),
          run({ runId: 'member', startedAt: '2026-01-01T10:00:20.000Z', finishedAt: '2026-01-01T10:00:35.000Z', stopped: 'end_turn' }),
        ]}
        agentName="Keeper" onOpen={() => {}} live={[]} now={Date.now()} emptyHint="Nothing yet." working={false}
      />,
    );
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('ignores a finish event that has no run to belong to', () => {
    show([run({ stopped: 'max_turns', startedAt: null, turns: null })]);
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('ignores a finish event that does not say which run it is', () => {
    show([run({ stopped: 'max_turns', runId: null })]);
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  /*
   * The one that matters in a room. A member spends `MAX_MEMBER_TURNS` inside
   * a coordinator run that finishes perfectly well: the member's run row says
   * `max_turns`, and its window holds the member's own answer — but the member
   * said nothing about a budget, so there is nothing to mark.
   */
  it('says nothing about a member run that exhausted the room’s per-member cap', () => {
    render(
      <MessageList
        messages={[
          said[0]!,
          { id: 'm2', role: 'assistant', at: '2026-01-01T10:00:30.000Z', blocks: [{ type: 'text', text: 'Ledger here, as far as I got.' }] },
          { id: 'm3', role: 'assistant', at: '2026-01-01T10:00:45.000Z', blocks: [{ type: 'text', text: 'That is what the room has.' }] },
        ]}
        runs={[
          run({ runId: 'coordinator', startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:50.000Z', stopped: 'end_turn', noticed: false }),
          run({ runId: 'ledger', startedAt: '2026-01-01T10:00:20.000Z', finishedAt: '2026-01-01T10:00:35.000Z', stopped: 'max_turns', turns: 6, noticed: false }),
        ]}
        agentName="Keeper" onOpen={() => {}} live={[]} now={Date.now()} emptyHint="Nothing yet." working={false}
      />,
    );
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('says nothing when the run ran out but its sentence never landed', () => {
    show([run({ stopped: 'max_turns', noticed: false })]);
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  /*
   * A message the page made up — an optimistic send — has no timestamp, so it
   * is in no run's window. Left in, it would collect every run's marker.
   */
  it('ignores a message with no timestamp', () => {
    render(
      <MessageList
        messages={[{ id: 'm9', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Pending.' }] }]}
        runs={[run({ stopped: 'max_turns', turns: 40 })]}
        agentName="Keeper" onOpen={() => {}} live={[]} now={Date.now()} emptyHint="Nothing yet." working={false}
      />,
    );
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('says nothing about a run that simply finished', () => {
    show([run({ stopped: 'end_turn' })]);
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('says nothing about a run that is still going', () => {
    show([run({ stopped: null, finishedAt: null, turns: null })]);
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('marks nothing when the page was not given the runs', () => {
    show([]);
    expect(screen.queryByTestId('budget-stop')).toBeNull();
  });

  it('marks each run on its own last message', () => {
    render(
      <MessageList
        messages={[
          ...said,
          { id: 'm3', role: 'user', at: '2026-01-01T11:00:01.000Z', blocks: [{ type: 'text', text: 'continue' }] },
          { id: 'm4', role: 'assistant', at: '2026-01-01T11:00:40.000Z', blocks: [{ type: 'text', text: 'Stopped again.' }] },
        ]}
        runs={[
          run({ runId: 'r1', stopped: 'max_turns', turns: 40 }),
          run({
            runId: 'r2',
            startedAt: '2026-01-01T11:00:00.000Z',
            finishedAt: '2026-01-01T11:01:00.000Z',
            stopped: 'max_turns',
            turns: 12,
          }),
        ]}
        agentName="Keeper"
        onOpen={() => {}}
        live={[]}
        now={Date.now()}
        emptyHint="Nothing yet."
        working={false}
      />,
    );
    const markers = screen.getAllByTestId('budget-stop');
    expect(markers.map((el) => el.textContent)).toEqual([
      'Turn budget reached · 40 steps',
      'Turn budget reached · 12 steps',
    ]);
  });
});

/*
 * The page has to hand the runs down, or the marker exists and nobody ever
 * sees it. This is the only test that walks the wire the dashboard walks.
 */
describe('the chat page', () => {
  const props: ChatPageProps = {
    timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
    agentsInHeader: false, narrow: false,
    agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
  };

  beforeEach(() => {
    const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
    vi.spyOn(api, 'browser').mockResolvedValue(idle);
    vi.spyOn(api, 'browserControl').mockResolvedValue(idle);
    vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
    vi.spyOn(chatApi, 'conversations').mockResolvedValue({
      conversations: [{ id: 'c1', agentId: 'keeper', createdAt: '2026-01-01T10:00:00.000Z', lastMessageAt: null, opening: null, messageCount: 2 }],
    });
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({
      conversationId: 'c1',
      agentId: 'keeper',
      messages: said,
      runs: [run({ stopped: 'max_turns', turns: 40 })],
    });
  });

  it('draws the marker from the transcript it loaded', async () => {
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await waitFor(() => expect(screen.getByTestId('budget-stop')).toHaveTextContent('Turn budget reached · 40 steps'));
  });
});
