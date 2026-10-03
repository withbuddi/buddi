/**
 * The browser's four moments and the Stop's Resume, drawn the kit's way in the
 * dock, and the Page tab and the composer chip around them in a conversation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi, type BrowserStatus } from '../api';
import { BrowserAsk, browserCardOf } from './BrowserAsk';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatQuestion } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const ask = (question: string, labels: Array<[string, boolean?]>): ChatQuestion => ({
  id: 'q1', question, allowOther: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  options: labels.map(([label, recommended], index) => ({ id: String(index), label, hint: null, recommended: recommended === true })),
});
const SIGN_IN = ask('Amazon needs your sign-in\nSign in on the page and give it back, and I carry on. Or let me use your Chrome, where you’re signed in.', [['Take over', true], ['Use my Chrome'], ['Save a login for next time']]);
const HUMAN = ask('This page asks for a human\namazon.com wants a “not a robot” check. Take over, answer it and give it back; I carry on.', [['Take over', true], ['Skip this site']]);
const LOOK = ask('I’m not sure that went through. Look?\nThe page didn’t change the way I expected after my last step.', [['Look', true], ['Carry on']]);
const BUDGET = ask('Keep going?\nThis has taken its hour or its steps. What I found so far is above; I can keep going.', [['Keep going', true], ['Stop here']]);
const PAUSED = ask('Browsing is paused since 10:12\nYou paused agents’ browsing from the Canvas, until 11:12. I need one page: amazon.com.', [['Resume', true], ['Keep paused']]);

describe('recognising the five', () => {
  it('reads each card by its labels, and nothing else', () => {
    expect(browserCardOf(SIGN_IN)).toMatchObject({ kind: 'signin', title: 'Amazon needs your sign-in', line: expect.stringContaining('Sign in on the page') });
    expect(browserCardOf(HUMAN)?.kind).toBe('human');
    expect(browserCardOf(LOOK)?.kind).toBe('look');
    expect(browserCardOf(BUDGET)?.kind).toBe('budget');
    expect(browserCardOf(PAUSED)?.kind).toBe('paused');
    expect(browserCardOf(ask('Which day suits you?', [['Monday'], ['Tuesday']]))).toBeNull();
    expect(browserCardOf({ ...LOOK, allowOther: true })).toBeNull();
    expect(browserCardOf(null)).toBeNull();
  });
  it('still reads a card from an older gateway: one line, its old labels', () => {
    const old = ask('amazon.com needs your sign-in.', [['Take over', true], ["Open Chrome and I'll use it there"]]);
    expect(browserCardOf(old)).toMatchObject({ kind: 'signin', title: 'amazon.com needs your sign-in', line: '' });
    expect(browserCardOf(ask('Browsing is stopped. Resume?', [['Resume', true], ['Leave it stopped']]))?.kind).toBe('paused');
  });
  it('puts the recommended action last, on the right, and Save a login aside as a link', () => {
    const card = browserCardOf(SIGN_IN)!;
    expect(card.actions.map((option) => option.label)).toEqual(['Use my Chrome', 'Take over']);
    expect(card.saveLogin?.label).toBe('Save a login for next time');
  });
});

describe('the card', () => {
  afterEach(cleanup);
  it('sign-in: Needs you, the title, the line, Save a login, Use my Chrome, Take over as the accent', () => {
    const onAnswer = vi.fn();
    render(<BrowserAsk card={browserCardOf(SIGN_IN)!} disabled={false} onAnswer={onAnswer} site="amazon.com" />);
    const card = screen.getByTestId('browser-ask');
    expect(card).toHaveAttribute('data-kind', 'signin');
    expect(within(card).getByText('Needs you')).toBeInTheDocument();
    expect(within(card).getByText('Amazon needs your sign-in')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Save a login for next time' })).toHaveAttribute('href', '#/settings/secrets?add=1&site=amazon.com');
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Use my Chrome', 'Take over']);
    expect(buttons[1]).toHaveAttribute('data-variant', 'accent');
    fireEvent.click(buttons[1]!);
    expect(onAnswer).toHaveBeenCalledWith('Take over', '0');
  });
  it('human: Skip this site is the quiet one', () => {
    render(<BrowserAsk card={browserCardOf(HUMAN)!} disabled={false} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Skip this site' })).toHaveAttribute('data-variant', 'ghost');
    expect(screen.getByRole('button', { name: 'Take over' })).toHaveAttribute('data-variant', 'accent');
  });
  it('look and budget: Carry on · Look, Stop here · Keep going', () => {
    const { unmount } = render(<BrowserAsk card={browserCardOf(LOOK)!} disabled={false} onAnswer={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Carry on', 'Look']);
    unmount();
    render(<BrowserAsk card={browserCardOf(BUDGET)!} disabled={false} onAnswer={() => {}} />);
    expect(screen.getByText('Keep going?')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Stop here', 'Keep going']);
  });
  it('paused: the Paused kicker, Keep paused · Resume', () => {
    render(<BrowserAsk card={browserCardOf(PAUSED)!} disabled={false} onAnswer={() => {}} />);
    const card = screen.getByTestId('browser-ask');
    expect(card).toHaveAttribute('data-kind', 'paused');
    expect(within(card).getByText('Paused')).toBeInTheDocument();
    expect(within(card).getByText('Browsing is paused since 10:12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep paused' })).toHaveAttribute('data-variant', 'ghost');
  });
  it('waits while an answer is on its way', () => {
    render(<BrowserAsk card={browserCardOf(LOOK)!} disabled onAnswer={() => {}} />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});

describe('in a conversation', () => {
  const props: ChatPageProps = {
    timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(), agentsInHeader: false, narrow: false,
    agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
  };
  const idle: BrowserStatus = { state: 'idle', enabled: true, busy: false, hasScreenshot: false };
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['picture']) })));
    vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
    vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
    vi.spyOn(api, 'browserControl').mockResolvedValue(idle);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('draws a browser card in the dock and answers it with the label', async () => {
    vi.spyOn(api, 'browser').mockResolvedValue(idle);
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [], question: LOOK } as never);
    const answer = vi.spyOn(chatApi, 'answerQuestion').mockResolvedValue({ ok: true, conversationId: 'c1', runId: 'r' } as never);
    render(<ChatPage {...props} />);
    expect(await screen.findByTestId('browser-ask')).toBeInTheDocument();
    expect(screen.queryByTestId('question-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Look' }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('q1', { answer: 'Look', optionId: '0' }));
  });

  it('while a Stop holds, the Page tab says so with Resume, with no page open', async () => {
    vi.spyOn(api, 'browser').mockResolvedValue({ ...idle, stop: { at: '2026-10-03T10:12:00Z', until: '2026-10-03T11:12:00Z' } });
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [], question: PAUSED } as never);
    render(<ChatPage {...props} />);
    expect(await screen.findByRole('tab', { name: 'Page' })).toBeInTheDocument();
    expect(await screen.findByText('Browsing is paused')).toBeInTheDocument();
    const resume = within(screen.getByTestId('browser-view')).getByRole('button', { name: 'Resume' });
    fireEvent.click(resume);
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('resume'));
  });

  it('offers “Use my Chrome” in the composer once your Chrome is allowed and paired, and pins the conversation', async () => {
    const routes = [{ kind: 'chrome' as const, allowed: true, available: true, provider: 'core', paired: true, connected: true }];
    vi.spyOn(api, 'browser').mockResolvedValue({ ...idle, routes });
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [] } as never);
    const pin = vi.spyOn(api, 'browserPin').mockResolvedValue({ ...idle, routes, pin: 'chrome' });
    render(<ChatPage {...props} />);
    const chip = await screen.findByRole('button', { name: 'Use my Chrome' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await act(async () => { fireEvent.click(chip); });
    await waitFor(() => expect(pin).toHaveBeenCalledWith('c1', 'chrome'));
  });

  it('offers no Chrome chip before your Chrome is paired', async () => {
    vi.spyOn(api, 'browser').mockResolvedValue({ ...idle, routes: [{ kind: 'chrome', allowed: true, available: false, provider: 'core', paired: false }] });
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [] } as never);
    render(<ChatPage {...props} />);
    await screen.findByTestId('composer');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('button', { name: 'Use my Chrome' })).not.toBeInTheDocument();
  });
});
