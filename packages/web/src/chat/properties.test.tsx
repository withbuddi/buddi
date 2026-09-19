/**
 * The properties panel: the three dots, the tab they open, and the one thing
 * the panel is not allowed to do.
 *
 * The fixture is an invented installation — a plugin called `orchard`, an agent
 * called The Keeper — because the page must be able to draw this for any
 * installation. Nothing here, and nothing in the component under test, knows
 * the name of a tool this repository ships.
 *
 * What is asserted, in the order it would hurt to lose:
 *
 *  - a gated tool is drawn as gated and an `auto` one is not;
 *  - an agent with nothing gated says so, rather than leaving a reader to
 *    conclude it from an absence;
 *  - a section with nothing in it is absent, heading included;
 *  - an agent that cannot run says why, where it will be read;
 *  - **it is read-only**: opening, reading and closing the panel issues no
 *    request that is not a GET;
 *  - the tab dies when the owner switches agents, because it was about the
 *    agent and not about the window;
 *  - the `@father` line walks the owner to the maker with the sentence ready.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '../api';
import type { ChatAgent } from './types';
import { ChatPage } from './ChatPage';
import { profileRenderable, profileTabId } from './properties';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const KEEPER: ChatAgent = {
  id: 'keeper',
  handle: 'keeper',
  name: 'The Keeper',
  description: 'Minds the orchard.',
  available: true,
  roles: ['overview'],
  provider: 'anthropic',
  model: 'claude-sonnet-5',
};

const FATHER: ChatAgent = {
  id: 'father',
  handle: 'father',
  name: 'Agent Father',
  description: 'Makes and changes agents.',
  available: true,
  roles: ['maker'],
  provider: 'anthropic',
  model: 'claude-opus-5',
  anchor: 'bottom',
};

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'keeper',
    handle: 'keeper',
    name: 'The Keeper',
    description: 'Minds the orchard.',
    isDefault: true,
    source: 'private',
    file: '/home/owner/buddi/private/agents/keeper/agent.md',
    available: true,
    roles: ['overview'],
    engine: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      maxTurns: 9,
      language: 'mirror',
      credentialKind: 'subscription-token',
      credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    },
    tools: [
      {
        family: 'orchard',
        gated: 1,
        tools: [
          {
            name: 'orchard.forecast',
            description: 'Project the harvest for the next eight weeks.',
            tier: 'auto',
            gated: false,
          },
          {
            name: 'orchard.dispatch',
            description: 'Send a crate to a buyer. Leaves the farm.',
            tier: 'gated',
            gated: true,
          },
        ],
      },
    ],
    toolCount: 2,
    gatedCount: 1,
    skills: [
      {
        name: 'pruning',
        description: 'How this farm prunes in February.',
        provenance: 'owner',
        scope: 'private',
        file: '/home/owner/buddi/private/agents/keeper/skills/pruning.md',
      },
    ],
    delegates: [
      {
        id: 'picker',
        handle: 'picker',
        name: 'The Picker',
        description: 'Walks the rows.',
        available: true,
      },
    ],
    changeVia: {
      agentId: 'father',
      handle: 'father',
      name: 'Agent Father',
      prompt: 'I want to change what @keeper (The Keeper) can do.',
      available: true,
    },
    note: 'This is a read-only view. Tools, skills and delegates change through the maker agent.',
    ...over,
  };
}

/** Every request the page made, so a write can be caught by its method. */
type Call = { url: string; method: string };

function stubServer(view: AgentProfile): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
      if (url.includes('/profile')) return new Response(JSON.stringify(view), { status: 200 });
      if (url.includes('/conversations')) {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url.includes('/chat/views')) {
        return new Response(JSON.stringify({ views: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  return calls;
}

async function open(
  view: AgentProfile = profile(),
  props: Partial<Parameters<typeof ChatPage>[0]> = {},
): Promise<{ calls: Call[]; selected: ReturnType<typeof vi.fn> }> {
  const calls = stubServer(view);
  const selected = vi.fn();
  await act(async () => {
    render(
      <ChatPage
        timezone="UTC"
        agents={{ top: [], middle: [KEEPER], bottom: [FATHER] }}
        agentId="keeper"
        onSelectAgent={selected}
        attention={new Map()}
        agentsInHeader={false}
        narrow={false}
        {...props}
      />,
    );
  });
  await act(async () => { fireEvent.click(screen.getByTestId('chat-menu')); });
  await act(async () => { fireEvent.click(screen.getByTestId('agent-properties')); });
  await waitFor(() => expect(screen.getByTestId('agent-profile')).toBeDefined());
  return { calls, selected };
}

describe('the properties panel', () => {
  it('opens from the three dots as a canvas tab, not a dialog', async () => {
    await open();
    // A tab in the strip, and a panel in the canvas — no dialog, no scrim.
    expect(screen.getByRole('tab', { name: /properties/i })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('canvas')).toBeDefined();
    // The panel names the agent it is about.
    expect(screen.getByText('@keeper')).toBeDefined();
  });

  it('marks a gated tool unmistakably and leaves an automatic one plain', async () => {
    await open();
    const rows = screen.getAllByTestId('agent-profile-tool');
    const gated = rows.filter((row) => row.getAttribute('data-gated') === 'true');
    expect(gated).toHaveLength(1);
    expect(gated[0]!.textContent).toContain('dispatch');
    expect(gated[0]!.textContent).toContain('Needs your approval');

    const auto = rows.filter((row) => row.getAttribute('data-gated') !== 'true');
    expect(auto).toHaveLength(1);
    expect(auto[0]!.textContent).toContain('Runs on its own');
    // The tool's own words, not the page's.
    expect(auto[0]!.textContent).toContain('Project the harvest for the next eight weeks.');

    // And the count is said out loud, above the list.
    expect(screen.getByText(/2 tools, and one of them stops and waits for you/)).toBeDefined();
  });

  it('says plainly when nothing the agent holds needs the owner', async () => {
    await open(
      profile({
        gatedCount: 0,
        toolCount: 1,
        tools: [
          {
            family: 'orchard',
            gated: 0,
            tools: [
              {
                name: 'orchard.forecast',
                description: 'Project the harvest.',
                tier: 'auto',
                gated: false,
              },
            ],
          },
        ],
      }),
    );
    expect(screen.queryByText(/Needs your approval/)).toBeNull();
    expect(screen.getByText(/every one of them running without asking you/)).toBeDefined();
  });

  it('leaves out a section with nothing in it, heading and all', async () => {
    await open(profile({ skills: [], delegates: [] }));
    expect(screen.queryByText('What it has read')).toBeNull();
    expect(screen.queryByText('Who it can hand work to')).toBeNull();
    // The sections that always have something are still there.
    expect(screen.getByText('What it can do')).toBeDefined();
    expect(screen.getByText('What it runs on')).toBeDefined();
  });

  it('draws skills and delegates when there are any', async () => {
    await open();
    expect(screen.getByText('What it has read')).toBeDefined();
    expect(screen.getByText('How this farm prunes in February.')).toBeDefined();
    expect(screen.getByText('Who it can hand work to')).toBeDefined();
    expect(screen.getByText('@picker')).toBeDefined();
  });

  it('names the credential without ever showing one', async () => {
    await open();
    expect(screen.getByText(/subscription-token from/)).toBeDefined();
    expect(screen.getByText('CLAUDE_CODE_OAUTH_TOKEN')).toBeDefined();
  });

  it('says when the agent cannot run, and why', async () => {
    await open(
      profile({ available: false, unavailableReason: 'OPENAI_API_KEY is not set on this machine.' }),
    );
    const blocked = screen.getByTestId('agent-profile-unavailable');
    expect(blocked.textContent).toContain('OPENAI_API_KEY is not set on this machine.');
  });

  it('is read-only: it issues no request that is not a read', async () => {
    const { calls } = await open();
    // Close it again — the toggle is the only other thing it can be asked to do.
    await act(async () => { fireEvent.click(screen.getByTestId('chat-menu')); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-properties')); });
    expect(screen.queryByTestId('agent-profile')).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(calls.some((call) => call.url.includes('/agents/keeper/profile'))).toBe(true);
  });

  it('sends the owner to the maker with the sentence ready, and changes nothing', async () => {
    const { calls, selected } = await open();
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-profile-change'));
    });
    expect(selected).toHaveBeenCalledWith('father');
    const box = screen.getByLabelText(/^Message /) as HTMLTextAreaElement;
    expect(box.value).toBe('I want to change what @keeper (The Keeper) can do.');
    // Offered, never sent: the owner still presses the key.
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('closes when the owner switches to another agent', async () => {
    const view = profile();
    const calls = stubServer(view);
    expect(calls).toBeDefined();
    const { rerender } = render(
      <ChatPage
        timezone="UTC"
        agents={{ top: [], middle: [KEEPER], bottom: [FATHER] }}
        agentId="keeper"
        onSelectAgent={() => {}}
        attention={new Map()}
        agentsInHeader={false}
        narrow={false}
      />,
    );
    await act(async () => { fireEvent.click(screen.getByTestId('chat-menu')); });
    await act(async () => { fireEvent.click(screen.getByTestId('agent-properties')); });
    await waitFor(() => expect(screen.getByTestId('agent-profile')).toBeDefined());

    await act(async () => {
      rerender(
        <ChatPage
          timezone="UTC"
          agents={{ top: [], middle: [KEEPER], bottom: [FATHER] }}
          agentId="father"
          onSelectAgent={() => {}}
          attention={new Map()}
          agentsInHeader={false}
          narrow={false}
        />,
      );
    });

    // A panel headed "The Keeper" beside a conversation with Agent Father would
    // be a lie the tab strip has no way to correct.
    expect(screen.queryByTestId('agent-profile')).toBeNull();
    expect(screen.queryByRole('tab', { name: /properties/i })).toBeNull();
  });
});

describe('the profile renderable', () => {
  it('takes a tab of its own and never takes the screen from a run', () => {
    const item = profileRenderable(profile());
    expect(item.id).toBe(profileTabId('keeper'));
    expect(item.source).toBe('profile');
    // Not substantial: the canvas follows the newest substantial thing, and a
    // reference panel must not stop a live run drawing its chart.
    expect(item.substantial).toBe(false);
    // And no tone, because a tone on a tab means somebody is waiting on you.
    expect(item.tone).toBeUndefined();
  });

  it('is namespaced so it can never collide with a tool-use id', () => {
    expect(profileTabId('keeper')).not.toBe('keeper');
    expect(profileTabId('keeper')).toContain('agent-properties');
  });
});
