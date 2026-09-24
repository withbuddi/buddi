/**
 * An empty thread, and the agent's own opening in it.
 *
 * What an owner meets on a fresh conversation is the agent, not the product:
 * its face, one sentence it wrote about itself, and two or three things people
 * actually ask it. The page knows no domain — every word here comes from the
 * agent file — and a starter is a *draft*: it fills the composer and stops,
 * because nothing on this page may send a message the owner did not send.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { api, chatApi } from '../api';
import { chatRoute } from '../routes';
import { resolveStarter, startersOf, introOf } from '../shell/roster';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const INTRO = 'I keep your calendar, and I say when something is beyond what I can reach.';
const agents = [
  {
    id: 'keeper', handle: 'keeper', name: 'Keeper', description: 'Keeps things, for other agents to read',
    intro: INTRO,
    starters: ['What is on today?', 'Rename {{default}} and change its face'],
    available: true, roles: [], provider: 'fixture', model: 'fixture',
  },
  {
    id: 'plain', handle: 'plain', name: 'Plain', description: 'A description and nothing else',
    available: true, roles: [], provider: 'fixture', model: 'fixture',
  },
];

beforeEach(() => {
  window.history.replaceState(null, '', chatRoute('keeper'));
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC' } as never);
  vi.spyOn(api, 'overview').mockResolvedValue({ approvals: { pending: 0 }, jobs: { failed: 0 } } as never);
  vi.spyOn(api, 'host').mockResolvedValue({ permissions: [], runs: [] });
  vi.spyOn(api, 'browser').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(api, 'browserControl').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(chatApi, 'agents').mockResolvedValue({ agents, defaultAgentId: 'keeper' } as never);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [] } as never);
  vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c-1', runId: 'run' } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '#/');
  sessionStorage.clear();
});

describe('the agent an empty thread opens on', () => {
  it('resolves {{default}} against the roster, and falls back to the description', () => {
    expect(resolveStarter('Rename {{default}}', 'Ada')).toBe('Rename Ada');
    // No default agent on this installation: still a sentence somebody types.
    expect(resolveStarter('Rename {{default}}', null)).toBe('Rename your assistant');
    expect(startersOf({ starters: ['a', 'b', 'c', 'd'] }, 'Ada')).toEqual(['a', 'b', 'c']);
    expect(introOf({ description: 'Only a description' })).toBe('Only a description');
    expect(introOf({ intro: INTRO, description: 'd' })).toBe(INTRO);
  });

  it('shows its face, its intro and its starters as chips', async () => {
    render(<App />);
    const opening = await screen.findByTestId('chat-opening');
    expect(opening).toHaveTextContent(INTRO);
    // The opening says hello in the agent's own name, over its intro.
    expect(opening).toHaveTextContent("Hi, I'm Keeper.");
    expect(opening.querySelector('.ui-avatar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'What is on today?' })).toBeInTheDocument();
    // The name comes from the roster's default agent, not from the file.
    expect(screen.getByRole('button', { name: 'Rename Keeper and change its face' })).toBeInTheDocument();
  });

  it('fills the composer from a chip and focuses it, without sending', async () => {
    render(<App />);
    const chip = await screen.findByRole('button', { name: 'What is on today?' });
    fireEvent.click(chip);
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe('What is on today?'));
    expect(area).toHaveFocus();
    expect(chatApi.send).not.toHaveBeenCalled();
  });

  it('shows the agent’s face on the empty canvas over one line in its name', async () => {
    render(<App />);
    await screen.findByTestId('chat-opening');
    const empty = document.querySelector('.wb-canvas-body-empty');
    expect(empty?.querySelector('.wb-empty-face .ui-avatar')).not.toBeNull();
    expect(empty?.textContent).toContain('What Keeper shows you lands here');
    // The intro is the opening's, said once in the thread, not again here.
    expect(empty?.textContent).not.toContain(INTRO);
    // The finance-flavoured copy is gone from both empty states.
    expect(document.body.textContent).not.toContain('a projection, a document, a decision');
  });

  it('falls back to the description for an agent whose file says nothing', async () => {
    window.history.replaceState(null, '', chatRoute('plain'));
    render(<App />);
    const opening = await screen.findByTestId('chat-opening');
    expect(opening).toHaveTextContent('A description and nothing else');
    expect(opening.querySelectorAll('.wb-starter')).toHaveLength(0);
  });
});
