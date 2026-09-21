/**
 * No brain, no composer.
 *
 * An agent whose account is missing, disabled or unconfigured is greyed
 * wherever it appears, and where its composer would be the page says what is
 * missing and links to the one place that fixes it. The server refuses the
 * same turn with the same reason (`gateway/src/web/chat.web.test.ts`); this is
 * the half the owner sees.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { api, chatApi } from '../api';
import { chatRoute, settingsRoute } from '../routes';
import { MODEL_ACCOUNTS_LABEL, PLUGINS_LABEL, cannotRunFix, cannotRunSentence } from '../shell/roster';
import type { ChatConversation } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const REASON = 'Provider account “Work API” is disabled.';
const agents = [
  { id: 'keeper', handle: 'keeper', name: 'Keeper', description: 'Keeps things', available: true, roles: [], provider: 'fixture', model: 'fixture' },
  { id: 'scout', handle: 'scout', name: 'Scout', description: 'Looks around', available: false, unavailableReason: REASON, roles: [], provider: 'fixture', model: 'fixture' },
];
const transcript = (id: string): ChatConversation => ({
  conversationId: id,
  agentId: id.split('-')[0] ?? 'keeper',
  messages: [{ id: `message-${id}`, role: 'assistant', at: '', blocks: [{ type: 'text', text: `Transcript ${id}` }] }],
});

beforeEach(() => {
  window.history.replaceState(null, '', '#/chat');
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC' } as never);
  vi.spyOn(api, 'overview').mockResolvedValue({ approvals: { pending: 0 }, jobs: { failed: 0 } } as never);
  vi.spyOn(api, 'host').mockResolvedValue({ permissions: [], runs: [] });
  vi.spyOn(api, 'browser').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(api, 'browserControl').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(chatApi, 'agents').mockResolvedValue({ agents, defaultAgentId: 'keeper' } as never);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockImplementation(async (agentId: string) => ({
    conversations: [{ id: `${agentId}-latest`, startedAt: '', lastMessageAt: '', preview: 'Latest', messageCount: 1 }],
  }) as never);
  vi.spyOn(chatApi, 'conversation').mockImplementation(async (id: string) => transcript(id));
  vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'scout-latest', runId: 'run' } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '#/');
  sessionStorage.clear();
});

describe('an agent with no brain', () => {
  it('says one sentence in the owner’s words, never a code', () => {
    expect(cannotRunSentence({ name: 'Scout', unavailableReason: REASON })).toBe(`Scout cannot run: ${REASON}`);
    // A missing reason is still a sentence, never an empty one.
    expect(cannotRunSentence({ name: 'Scout' })).toMatch(/^Scout cannot run: /);
  });

  it('is greyed in the rail, with the reason, and cannot be opened from it', async () => {
    render(<App />);
    const face = await screen.findByTestId('agent-face-scout');
    expect(face.getAttribute('data-unavailable')).toBe('true');
    expect(face.getAttribute('aria-label')).toBe('Scout — unavailable');
    expect(face).toBeDisabled();
    expect(screen.getByText(REASON)).toBeInTheDocument();
  });

  it('replaces its composer with that sentence and a link to the model accounts', async () => {
    window.history.replaceState(null, '', chatRoute('scout', 'scout-latest'));
    render(<App />);
    const blocked = await screen.findByTestId('composer-blocked');
    expect(blocked).toHaveTextContent(`Scout cannot run: ${REASON}`);
    expect(screen.getByRole('link', { name: /Model accounts/ })).toHaveAttribute('href', settingsRoute('accounts'));
    // There is nothing to type into, so nothing can be sent and lost.
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(chatApi.send).not.toHaveBeenCalled();
  });

  it('leaves the composer alone for an agent that can run', async () => {
    window.history.replaceState(null, '', chatRoute('keeper', 'keeper-latest'));
    render(<App />);
    const area = await screen.findByRole('textbox');
    expect(screen.queryByTestId('composer-blocked')).not.toBeInTheDocument();
    fireEvent.change(area, { target: { value: 'Still works' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    expect(chatApi.send).toHaveBeenCalledWith('keeper', { text: 'Still works', attachmentIds: [], conversationId: 'keeper-latest' });
  });
});

/**
 * The same greyed state, for a plugin instead of an account.
 *
 * An agent granting a whole tool family on an installation that does not have
 * the plugin providing it is held back by the server
 * (`core/src/agents/catalog.ts`): listed, toolless and unrunnable. The page treats it exactly as it treats an agent with no
 * brain — one sentence, greyed everywhere, no composer — and changes only the
 * door the link opens, because the fix is an install, not an account.
 */
describe('an agent held back for a missing plugin', () => {
  const HELD = 'Needs the finance plugin.';
  const heldBack = { reason: 'missing-plugin' as const, families: ['finance'], message: HELD };
  const withCredo = [
    agents[0]!,
    { id: 'credo', handle: 'credo', name: 'Credo', description: 'Watches the money', available: false, unavailableReason: HELD, heldBack, roles: [], provider: 'fixture', model: 'fixture' },
  ];

  beforeEach(() => {
    vi.spyOn(chatApi, 'agents').mockResolvedValue({ agents: withCredo, defaultAgentId: 'keeper' } as never);
  });

  it('says the installation is missing something, not that the agent is broken', () => {
    expect(cannotRunSentence({ name: 'Credo', unavailableReason: HELD, heldBack })).toBe(
      `Credo is held back. ${HELD}`,
    );
    expect(cannotRunFix({ heldBack })).toEqual({ section: 'plugins', label: PLUGINS_LABEL });
    // An agent with no account still goes to the accounts page.
    expect(cannotRunFix({})).toEqual({ section: 'accounts', label: MODEL_ACCOUNTS_LABEL });
  });

  it('is greyed in the roster with that sentence, and cannot be opened from it', async () => {
    render(<App />);
    const face = await screen.findByTestId('agent-face-credo');
    expect(face.getAttribute('data-unavailable')).toBe('true');
    expect(face.getAttribute('aria-label')).toBe('Credo — unavailable');
    expect(face).toBeDisabled();
    expect(screen.getByText(HELD)).toBeInTheDocument();
  });

  it('replaces its composer with that sentence and a link to the plugins page', async () => {
    window.history.replaceState(null, '', chatRoute('credo', 'credo-latest'));
    render(<App />);
    const blocked = await screen.findByTestId('composer-blocked');
    expect(blocked).toHaveTextContent(`Credo is held back. ${HELD}`);
    expect(screen.getByRole('link', { name: /Settings → Plugins/ })).toHaveAttribute(
      'href',
      settingsRoute('plugins'),
    );
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(chatApi.send).not.toHaveBeenCalled();
  });
});
