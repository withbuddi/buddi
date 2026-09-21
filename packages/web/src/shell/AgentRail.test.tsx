/**
 * The agent rail.
 *
 * Most of what is asserted here are ways this could quietly go wrong: an order
 * that drifts, a separator with nothing on one side of it, a badge that means
 * "busy", a face that fails when clicked, and a second column squeezing a
 * phone. The exception is the one that makes the badge worth having at all —
 * that it lights up while the owner is looking at a different agent, without a
 * reload and without a poll.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, AGENT_RAIL_QUERY, NARROW_QUERY } from '../App';
import { AgentRail } from './AgentRail';
import {
  attentionMap,
  badgeOf,
  canGroup,
  groupAgents,
  groupableAgents,
  orderAgents,
  waitingText,
  type AgentAttention,
} from './roster';
import type { ChatAgent, GroupView } from '../chat/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agent = (over: Partial<ChatAgent> & { id: string; name: string }): ChatAgent => ({
  handle: over.id,
  description: '',
  available: true,
  roles: [],
  provider: 'anthropic',
  model: 'a-model',
  ...over,
});

/*
 * Three colleagues in the middle, a front desk at the head and a maker at the
 * foot. `anchor` is an end the server derived from roles — this package never
 * learns which agent is which, only which end each one is pinned to.
 */
const ROSTER: ChatAgent[] = [
  agent({ id: 'postman', name: 'Postman' }),
  agent({ id: 'ledger', name: 'Ledger' }),
  agent({ id: 'scout', name: 'Scout', available: false, unavailableReason: 'SCOUT_KEY is not set' }),
  agent({ id: 'front', name: 'Buddi', anchor: 'top' }),
  agent({ id: 'father', name: 'Agent Father', anchor: 'bottom' }),
];

function draw(
  attention: Map<string, AgentAttention>,
  onSelect: (id: string) => void = () => {},
  currentId = 'ledger',
): void {
  render(
    <Tooltip.Provider>
      <AgentRail
        agents={groupAgents(ROSTER, 'ledger')}
        currentId={currentId}
        attention={attention}
        onSelect={onSelect}
      />
    </Tooltip.Provider>,
  );
}

function railOf(agents: ChatAgent[], defaultAgentId: string | null): void {
  render(
    <Tooltip.Provider>
      <AgentRail
        agents={groupAgents(agents, defaultAgentId)}
        currentId={null}
        attention={new Map()}
        onSelect={() => {}}
      />
    </Tooltip.Provider>,
  );
}

/*
 * The handle is the other half of the name: it is the word the owner types to
 * reach this agent, so it belongs on the title line rather than replacing the
 * second line, which still says when they last spoke or why they cannot.
 */
describe('the handle', () => {
  it('draws @handle beside the name, and keeps the second line', () => {
    railOf(
      [agent({ id: 'ledger', name: 'Ledger', handle: 'books', description: 'Keeps the books.' })],
      'ledger',
    );
    const face = screen.getByTestId('agent-face-ledger');
    expect(face.textContent).toContain('Ledger');
    expect(face.textContent).toContain('@books');
    expect(face.textContent).toContain('Keeps the books.');
  });
});

/*
 * A fresh installation has one assistant and the agent that makes agents. The
 * second is a settings door, not a colleague, so there is nobody to group —
 * and offering a room that cannot be filled is worse than not offering one.
 */
describe('the groups section', () => {
  const railWith = (roster: ChatAgent[], groups: GroupView[] = []): void => {
    render(
      <Tooltip.Provider>
        <AgentRail
          agents={groupAgents(roster, roster[0]?.id ?? null)}
          currentId={null}
          attention={new Map()}
          onSelect={() => {}}
          groups={groups}
          onSelectGroup={() => {}}
          onNewGroup={() => {}}
        />
      </Tooltip.Provider>,
    );
  };
  const maker = agent({ id: 'father', name: 'Agent Father', anchor: 'bottom', roles: ['maker'] });

  it('counts who could actually be in a room, and the maker is not one', () => {
    expect(canGroup([agent({ id: 'ada', name: 'Ada' }), maker])).toBe(false);
    expect(canGroup([agent({ id: 'ada', name: 'Ada' }), agent({ id: 'ledger', name: 'Ledger' })])).toBe(true);
    // An agent with no account answers nothing, so it makes no room either.
    expect(canGroup([
      agent({ id: 'ada', name: 'Ada' }),
      agent({ id: 'scout', name: 'Scout', available: false, unavailableReason: 'no key' }),
    ])).toBe(false);
    expect(groupableAgents([agent({ id: 'ada', name: 'Ada' }), maker]).map((a) => a.id)).toEqual(['ada']);
  });

  it('is absent, + button and all, with one assistant and the maker', () => {
    railWith([agent({ id: 'ada', name: 'Ada' }), maker]);
    expect(screen.queryByTestId('group-rail')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New group' })).toBeNull();
    expect(screen.getByTestId('agent-face-ada')).toBeDefined();
  });

  it('appears once there are two agents to group', () => {
    railWith([agent({ id: 'ada', name: 'Ada' }), agent({ id: 'ledger', name: 'Ledger' }), maker]);
    expect(screen.getByTestId('group-rail')).toBeDefined();
    expect(screen.getByRole('button', { name: 'New group' })).toBeDefined();
  });
});

describe('the order', () => {
  it('pins the front desk to the head and the maker to the foot, work in between', () => {
    const groups = groupAgents(ROSTER, 'ledger');
    expect(groups.top.map((a) => a.id)).toEqual(['front']);
    expect(groups.middle.map((a) => a.id)).toEqual(['ledger', 'postman', 'scout']);
    expect(groups.bottom.map((a) => a.id)).toEqual(['father']);

    // The same answer from a differently shuffled list: the rail is not a
    // recency list, and a face does not move because an agent just spoke.
    expect(orderAgents([...ROSTER].reverse(), 'ledger')).toEqual(orderAgents(ROSTER, 'ledger'));
  });

  it('still produces a stable order when no agent is the default', () => {
    expect(groupAgents(ROSTER, null).middle.map((a) => a.id)).toEqual(['ledger', 'postman', 'scout']);
  });

  it('pins both claimants of one end rather than letting one silently win', () => {
    const tie = [
      agent({ id: 'b', name: 'Beta', anchor: 'top' }),
      agent({ id: 'a', name: 'Alpha', anchor: 'top' }),
    ];
    expect(groupAgents(tie, null).top.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('draws the line once, and only where it divides something', () => {
    draw(new Map());
    expect(screen.getAllByTestId('agent-rail-sep')).toHaveLength(1);
    cleanup();

    // Nobody claims the head: no line, and no gap where one would have been.
    railOf(ROSTER.filter((a) => a.anchor !== 'top'), 'ledger');
    expect(screen.queryByTestId('agent-rail-sep')).toBeNull();
    cleanup();

    // A fresh clone: a front desk and a maker, and nothing in between. The two
    // ends of the rail say it; a line under the only face at the top would be
    // a border rather than a grouping.
    railOf(ROSTER.filter((a) => a.anchor === 'top' || a.anchor === 'bottom'), null);
    expect(screen.queryByTestId('agent-rail-sep')).toBeNull();
    expect(screen.getByTestId('agent-face-front')).toBeDefined();
    expect(screen.getByTestId('agent-face-father')).toBeDefined();
  });

  it('leaves an end empty rather than promoting somebody into it', () => {
    const noMaker = groupAgents(ROSTER.filter((a) => a.anchor !== 'bottom'), 'ledger');
    expect(noMaker.bottom).toEqual([]);
    expect(noMaker.middle.map((a) => a.id)).toEqual(['ledger', 'postman', 'scout']);
  });

  it('pins an agent that cannot run, because the anchor is about what it is', () => {
    const out = [
      agent({ id: 'front', name: 'Buddi', anchor: 'top', available: false, unavailableReason: 'no key' }),
      ...ROSTER.filter((a) => a.id !== 'front'),
    ];
    const groups = groupAgents(out, 'ledger');
    expect(groups.top[0]?.id).toBe('front');
    expect(groups.top[0]?.available).toBe(false);
  });
});

describe('what earns a badge', () => {
  it('counts pending approvals, and says so in words', () => {
    const waiting: AgentAttention = {
      agentId: 'postman',
      approvals: 2,
      oldestApprovalAt: '2026-09-15T08:00:00Z',
      question: null,
    };
    expect(badgeOf(waiting)).toEqual({ count: 2 });
    expect(waitingText(waiting)).toBe('2 approvals are waiting for you');
  });

  it('marks a held question with a dot, because a question is not a quantity', () => {
    const holding: AgentAttention = {
      agentId: 'ledger',
      approvals: 0,
      oldestApprovalAt: null,
      question: { at: '2026-09-15T08:00:00Z', conversationId: 'c1' },
    };
    expect(badgeOf(holding)).toEqual({ count: null });
    expect(waitingText(holding)).toMatch(/holding for the answer/);
  });

  it('earns nothing from an agent the server said nothing about', () => {
    expect(badgeOf(undefined)).toBeNull();
    expect(waitingText(undefined)).toBeNull();
    // And an entry with neither claim — which the server does not send, but
    // which must not draw anything if it ever did.
    expect(
      badgeOf({ agentId: 'x', approvals: 0, oldestApprovalAt: null, question: null }),
    ).toBeNull();
  });

  it('draws the badge on that agent alone', () => {
    draw(
      attentionMap({
        at: '2026-09-15T08:00:00Z',
        agents: [{ agentId: 'postman', approvals: 1, oldestApprovalAt: null, question: null }],
      }),
    );
    expect(screen.getByTestId('agent-badge-postman').textContent).toBe('1');
    expect(screen.queryByTestId('agent-badge-ledger')).toBeNull();
    expect(screen.queryByTestId('agent-badge-front')).toBeNull();
    // And the name, the state and the reason all reach a screen reader — the
    // chip itself draws two letters, which are not a word.
    expect(screen.getByTestId('agent-face-postman').getAttribute('aria-label')).toBe(
      'Postman — one approval is waiting for you',
    );
  });
});

describe('an agent that cannot run', () => {
  it('renders as out of service, with the reason, and cannot be clicked into', () => {
    const onSelect = vi.fn();
    draw(new Map(), onSelect);

    const face = screen.getByTestId('agent-face-scout') as HTMLButtonElement;
    expect(face.disabled).toBe(true);
    expect(face.getAttribute('data-unavailable')).toBe('true');
    expect(face.getAttribute('aria-label')).toBe('Scout — unavailable');
    fireEvent.click(face);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('switches to one that can, and marks it as current', () => {
    const onSelect = vi.fn();
    draw(new Map(), onSelect);
    fireEvent.click(screen.getByTestId('agent-face-ledger'));
    expect(onSelect).toHaveBeenCalledWith('ledger');
    expect(screen.getByTestId('agent-face-ledger').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('agent-face-postman').getAttribute('aria-current')).toBeNull();
  });
});

describe('narrow widths', () => {
  it('lays the agent rail down before the canvas gives way', () => {
    // Two stated numbers, in this order: the agent rail is the first thing to
    // go, because a horizontal strip of faces costs nothing the canvas needs.
    expect(AGENT_RAIL_QUERY).toBe('(max-width: 1080px)');
    expect(NARROW_QUERY).toBe('(max-width: 900px)');
  });

  it('keeps every face reachable in the conversation header at phone width', async () => {
    stubApi();
    stubMatchMedia(true);
    await act(async () => {
      window.history.replaceState(null, '', '#/chat');
      render(<App />);
    });
    await waitFor(() => expect(screen.getByTestId('agent-rail')).toBeDefined());
    // One rail, inside the conversation header — not a second column, and not
    // a menu: every face is still one tap away and every badge still visible.
    expect(screen.getAllByTestId('agent-rail')).toHaveLength(1);
    expect(screen.getByTestId('chat-head').contains(screen.getByTestId('agent-rail'))).toBe(true);
    for (const a of ROSTER) expect(screen.getByTestId(`agent-face-${a.id}`)).toBeDefined();
  });

  it('gives the agents their own column at desktop width', async () => {
    stubApi();
    stubMatchMedia(false);
    await act(async () => {
      window.history.replaceState(null, '', '#/chat');
      render(<App />);
    });
    await waitFor(() => expect(screen.getByTestId('agent-rail')).toBeDefined());
    expect(screen.getByTestId('chat-head').contains(screen.getByTestId('agent-rail'))).toBe(false);
  });
});

describe('a badge that arrives while you are looking elsewhere', () => {
  it('lights up from the attention stream, without a reload', async () => {
    const push = stubApi();
    stubMatchMedia(false);
    await act(async () => {
      window.history.replaceState(null, '', '#/chat');
      render(<App />);
    });
    await waitFor(() => expect(screen.getByTestId('agent-face-postman')).toBeDefined());
    expect(screen.queryByTestId('agent-badge-postman')).toBeNull();

    // The server's answer changes, and the stream says so. Nothing polls.
    await act(async () => {
      push({
        at: '2026-09-15T09:00:00Z',
        agents: [{ agentId: 'postman', approvals: 1, oldestApprovalAt: null, question: null }],
      });
    });
    await waitFor(() => expect(screen.getByTestId('agent-badge-postman').textContent).toBe('1'));
  });
});

/* ------------------------------------------------------------------ */

/**
 * A server that answers the roster and holds the attention stream open. The
 * returned function changes what `/api/chat/attention` says and then pushes one
 * frame down the stream, which is exactly the sequence the real pair produces.
 */
function stubApi(): (next: { at: string; agents: AgentAttention[] }) => void {
  let snapshot: { at: string; agents: AgentAttention[] } = { at: '2026-09-15T08:00:00Z', agents: [] };
  let emit: ((chunk: string) => void) | null = null;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/chat/attention/stream')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            emit = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.includes('/chat/attention')) return json(snapshot);
      if (url.includes('/chat/agents')) return json({ agents: ROSTER, defaultAgentId: 'ledger' });
      if (url.includes('/chat/views')) return json({ views: [] });
      return json({});
    }),
  );

  return (next) => {
    snapshot = next;
    emit?.('event: attention\ndata: {"at":"2026-09-15T09:00:00Z"}\n\n');
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubMatchMedia(narrow: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}
