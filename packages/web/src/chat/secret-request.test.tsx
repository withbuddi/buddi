/**
 * Secrets in the sign-in flow, in place (buddi-design `secrets-signin.html`):
 * every state of the prototype, and the one rule under all of them — what the
 * owner types goes to the secrets API and never into a chat message.
 *
 *   card · cardlocked · sheet · locked · saved · filled · row
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, chatApi, type ApprovalRow } from '../api';
import { ApprovalDock } from './ApprovalDock';
import { ChatPage, type ChatPageProps } from './ChatPage';
import { MessageList } from './MessageList';
import { SecretRequestDock } from './SecretRequest';
import type { ChatConversation, ChatEvent, ChatQuestion, SecretRequestCard } from './types';

const stream = vi.hoisted(() => ({ handlers: [] as Array<(event: ChatEvent) => void> }));
vi.mock('./stream', () => ({
  openChatStream: (options: { onEvent: (event: ChatEvent) => void }) => {
    stream.handlers.push(options.onEvent);
    return { close() {} };
  },
}));

const PASSWORD = 'correct-horse-battery';
const USERNAME = 'SamRuiz';

const card: SecretRequestCard = {
  kind: 'secret.request',
  site: 'wikipedia.org',
  origins: ['https://en.wikipedia.org', 'https://wikipedia.org', 'https://*.wikipedia.org'],
  page: { url: 'https://en.wikipedia.org/w/index.php?title=Special:UserLogin', title: 'Log in · Wikipedia' },
  fields: [{ label: 'Username', kind: 'username', ref: 'e3' }, { label: 'Password', kind: 'password', ref: 'e4' }],
  agentName: 'Scout',
};
const question: ChatQuestion = {
  id: 'q1', question: 'No saved sign-in for wikipedia.org', options: [{ id: 'option-1', label: 'Decline', hint: null, recommended: false }],
  allowOther: false, expiresAt: '2999-01-01T00:00:00Z', request: card,
};

beforeEach(() => {
  stream.handlers.length = 0;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); try { window.localStorage.clear(); } catch { /* none */ } });

function type(label: string, value: string, within_: HTMLElement = document.body): void {
  fireEvent.change(within(within_).getByLabelText(label), { target: { value } });
}

describe('1. the card', () => {
  it('draws the fields the agent saw, the site chip, and the actions with the primary on the right', () => {
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    const dock = screen.getByTestId('secret-request');
    expect(within(dock).getByText('Needs you')).toBeInTheDocument();
    expect(within(dock).getByText('No saved sign-in for wikipedia.org')).toBeInTheDocument();
    expect(within(dock).getByText(/Scout stopped at the sign-in form/)).toBeInTheDocument();
    expect(within(dock).getByLabelText('Username')).not.toHaveAttribute('type', 'password');
    expect(within(dock).getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(within(dock).getByText('wikipedia.org', { selector: '.ss-site-chip' })).toBeInTheDocument();
    expect(within(dock).getByText('only on this site · Scout never sees them')).toBeInTheDocument();
    const buttons = within(dock.querySelector('.ui-toolbar') as HTMLElement).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['I’ll sign in myself', 'More options', 'Save and fill']);
    expect(within(dock).getByText(/keeps them for next time and hands you the page/)).toBeInTheDocument();
  });

  it('Show reveals the password and Hide masks it again', () => {
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('Save and fill posts the values to the secrets API and nowhere else', async () => {
    const save = vi.spyOn(api, 'saveSecretSet').mockResolvedValue({ saved: ['Wikipedia username', 'Wikipedia password'], filled: true });
    const answer = vi.spyOn(chatApi, 'answerQuestion');
    const send = vi.spyOn(chatApi, 'send');
    const settled = vi.fn();
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={settled} />);
    type('Username', USERNAME);
    type('Password', PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Save and fill' }));
    await waitFor(() => expect(settled).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({ questionId: 'q1', then: 'fill', fields: [
      { label: 'Username', kind: 'username', value: USERNAME },
      { label: 'Password', kind: 'password', value: PASSWORD },
    ] });
    expect(answer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('Save only saves and hands the page over', async () => {
    const save = vi.spyOn(api, 'saveSecretSet').mockResolvedValue({ saved: ['Wikipedia password'], filled: false });
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    type('Password', PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Save only' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'q1', then: 'save' })));
  });

  it('"I\'ll sign in myself" declines without saving anything', async () => {
    const decline = vi.spyOn(api, 'declineSecretRequest').mockResolvedValue({ declined: 'sign-in-myself', stamp: 'x' });
    const save = vi.spyOn(api, 'saveSecretSet');
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'I’ll sign in myself' }));
    await waitFor(() => expect(decline).toHaveBeenCalledWith('q1', 'sign-in-myself'));
    expect(save).not.toHaveBeenCalled();
  });

  it('prints the warning line for a field that looks like a card number', () => {
    const warned: SecretRequestCard = { ...card, fields: [{ label: 'Card number', kind: 'other', warning: 'Scout asked for something that looks like a card number; buddi keeps it only on wikipedia.org' }], warnings: ['Scout asked for something that looks like a card number; buddi keeps it only on wikipedia.org'] };
    render(<SecretRequestDock question={{ ...question, request: warned }} card={warned} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    expect(screen.getByRole('note')).toHaveTextContent('Scout asked for something that looks like a card number; buddi keeps it only on wikipedia.org');
  });

  it('stacks on a phone', () => {
    render(<SecretRequestDock question={question} card={card} phone container={null} disabled={false} onSettled={vi.fn()} />);
    expect(screen.getByTestId('secret-request')).toHaveAttribute('data-phone', 'true');
  });
});

describe('2. the card after a locked vault', () => {
  it('says nothing was saved, inline, and keeps what was typed', async () => {
    vi.spyOn(api, 'saveSecretSet').mockRejectedValue(new ApiError(409, 'Nothing was saved: the vault is locked.', { error: 'Nothing was saved: the vault is locked.', locked: true }));
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    type('Username', USERNAME);
    fireEvent.click(screen.getByRole('button', { name: 'Save and fill' }));
    expect(await screen.findByText('Nothing was saved: the vault is locked.')).toBeInTheDocument();
    expect(screen.getByText(/Unlock this Mac, then press Save and fill again/)).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveValue(USERNAME);
  });
});

describe('3. the sheet', () => {
  it('More options carries the values over, adds a code field and another field, and posts them all', async () => {
    const save = vi.spyOn(api, 'saveSecretSet').mockResolvedValue({ saved: [], filled: true });
    const column = document.createElement('section');
    document.body.appendChild(column);
    render(<SecretRequestDock question={question} card={card} phone={false} container={column} disabled={false} onSettled={vi.fn()} />);
    type('Username', USERNAME);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const sheet = await screen.findByRole('dialog');
    expect(column.contains(sheet)).toBe(true);
    expect(sheet).toHaveAttribute('data-contained', 'true');
    expect(within(sheet).getByText('Sign-in for wikipedia.org')).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Username')).toHaveValue(USERNAME);
    expect(within(sheet).getByText('Where they go')).toBeInTheDocument();
    expect(within(sheet).getByText('Saved as Wikipedia username and Wikipedia password in Keys and secrets.')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /Add a code field/ }));
    fireEvent.change(within(sheet).getByLabelText('Authenticator (TOTP seed)'), { target: { value: 'JBSWY3DPEHPK3PXP' } });
    fireEvent.click(within(sheet).getByRole('button', { name: /Add another field/ }));
    fireEvent.change(within(sheet).getByPlaceholderText('Security answer'), { target: { value: 'Memorable word' } });
    fireEvent.change(within(sheet).getByLabelText('Value'), { target: { value: 'otter' } });
    fireEvent.change(within(sheet).getByLabelText('Password'), { target: { value: PASSWORD } });
    expect(within(sheet).getByText('Saved as Wikipedia username, Wikipedia password, Wikipedia code and Wikipedia memorable word in Keys and secrets.')).toBeInTheDocument();
    const foot = within(sheet).getAllByRole('button').filter((b) => ['Cancel', 'Save and fill'].includes(b.textContent ?? ''));
    expect(foot.map((b) => b.textContent)).toEqual(['Cancel', 'Save and fill']);
    fireEvent.click(foot[1]!);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ questionId: 'q1', then: 'fill', fields: [
      { label: 'Username', kind: 'username', value: USERNAME },
      { label: 'Password', kind: 'password', value: PASSWORD },
      { label: 'Code', kind: 'totp', value: 'JBSWY3DPEHPK3PXP' },
      { label: 'Memorable word', kind: 'other', value: 'otter' },
    ] }));
    column.remove();
  });

  it('on a phone, covers the screen and folds the page in with Show the page', async () => {
    render(<SecretRequestDock question={question} card={card} phone container={null} disabled={false} onSettled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet).not.toHaveAttribute('data-contained');
    expect(within(sheet).getByText('The page Scout has open')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show the page' }));
    expect(within(sheet).getByRole('button', { name: 'Hide the page' })).toBeInTheDocument();
  });
});

describe('4. the sheet after a locked vault', () => {
  it('says so above its actions and keeps the sheet open', async () => {
    vi.spyOn(api, 'saveSecretSet').mockRejectedValue(new ApiError(409, 'Nothing was saved: the vault is locked.', { locked: true }));
    render(<SecretRequestDock question={question} card={card} phone={false} container={null} disabled={false} onSettled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save and fill' }));
    expect(await within(sheet).findByText('Nothing was saved: the vault is locked.')).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Password')).toHaveValue(PASSWORD);
  });
});

describe('5. the saved card', () => {
  const set: ApprovalRow = {
    id: 'set1', tool: 'secrets.use_set', toolVersion: '1.0.0', agentId: 'scout', conversationId: 'c1', jobId: null,
    preview: 'browser asks to fill your saved sign-in for wikipedia.org', envelope: {},
    canonicalArgs: { site: 'wikipedia.org', plugin: 'browser', items: [
      { bindingId: 'b1', secret: 'Wikipedia username', kind: 'browser.field', field: 'Username' },
      { bindingId: 'b2', secret: 'Wikipedia password', kind: 'browser.field', field: 'Password' },
    ] },
    argsHash: 'h', policyVersion: 1, state: 'pending', decidedBy: null, decidedVia: null, decidedAt: null,
    expiresAt: '2999-01-01T00:00:00Z', createdAt: '2026-10-07T10:22:00Z', outcome: null,
  };

  it('is the fill approval for the set, in the approval card\'s shape', async () => {
    vi.spyOn(api, 'approval').mockResolvedValue(set);
    const decide = vi.spyOn(api, 'decide').mockResolvedValue({ action: { ...set, state: 'succeeded' }, execution: null } as never);
    const self = vi.fn();
    render(<ApprovalDock approvals={[{ approvalId: 'set1', toolUseId: 't1' }]} timezone="UTC" now={0} onDecided={vi.fn()} onSay={vi.fn()} onOpenFull={vi.fn()} onSignInMyself={self} />);
    const dock = await screen.findByTestId('secret-set-dock');
    expect(within(dock).getByText('Needs your OK')).toBeInTheDocument();
    expect(within(dock).getByText('Saved 2 secrets for wikipedia.org')).toBeInTheDocument();
    expect(within(dock).getByText('Wikipedia username')).toBeInTheDocument();
    expect(within(dock).getByText('into Password')).toBeInTheDocument();
    expect(within(dock).getByText(/On wikipedia.org, the page Scout has open/)).toBeInTheDocument();
    expect(within(dock).getByRole('link', { name: 'Edit in Keys and secrets' })).toHaveAttribute('href', '#/settings/secrets');
    const buttons = within(dock).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['I’ll sign in myself', 'Fill them in']);
    fireEvent.click(within(dock).getByRole('button', { name: 'Fill them in' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('set1', 'approve', undefined));
  });
});

describe('6. filled: the thread stamp', () => {
  it('is one quiet line with its time, never the words behind it', () => {
    render(
      <Tooltip.Provider>
        <MessageList
          timezone="UTC"
          now={0}
          live={[]}
          onOpen={vi.fn()}
          emptyHint=""
          messages={[
            { id: 'm1', role: 'user', at: '2026-10-07T10:20:00Z', blocks: [{ type: 'text', text: 'Add the Lyon article to my Wikipedia watchlist.' }] },
            { id: 'm2', role: 'assistant', at: '2026-10-07T10:21:00Z', blocks: [{ type: 'tool_use', id: 'req', name: 'secret.request', input: { fields: [] } }] },
            { id: 'm3', role: 'user', at: '2026-10-07T10:21:00Z', blocks: [{ type: 'tool_result', toolUseId: 'req', name: 'secret.request', ok: true, output: { pending: true } }] },
            { id: 'm4', role: 'user', at: '2026-10-07T10:23:00Z', speaker: 'stamp:Filled username and password on wikipedia.org', blocks: [{ type: 'text', text: 'Filled username and password on wikipedia.org' }] },
          ]}
        />
      </Tooltip.Provider>,
    );
    const stamp = screen.getByTestId('thread-stamp');
    expect(stamp).toHaveTextContent('Filled username and password on wikipedia.org');
    expect(stamp).toHaveTextContent('10:23');
    // The request itself is the card, then the stamp: no tool row for it.
    expect(screen.queryByText(/Secret · Request/i)).toBeNull();
    expect(document.body.textContent).not.toContain('tool result (deferred)');
  });
});

describe('the card in the chat page', () => {
  const props: ChatPageProps = {
    timezone: 'UTC', agentId: 'scout', onSelectAgent: vi.fn(), attention: new Map(),
    agentsInHeader: false, narrow: false,
    agents: { top: [], bottom: [], middle: [{ id: 'scout', handle: 'scout', name: 'Scout', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
  };
  const waiting: ChatConversation = { conversationId: 'c1', agentId: 'scout', messages: [
    { id: 'm1', role: 'user', at: '', blocks: [{ type: 'text', text: 'Add the Lyon article to my Wikipedia watchlist.' }] },
  ], question };

  beforeEach(() => {
    vi.spyOn(api, 'browser').mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
    vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'scout', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 1 }] });
  });

  it('stands in the dock with the composer still under it, and no chat message ever carries what was typed', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(waiting);
    const send = vi.spyOn(chatApi, 'send');
    const answer = vi.spyOn(chatApi, 'answerQuestion');
    const save = vi.spyOn(api, 'saveSecretSet').mockResolvedValue({ saved: ['Wikipedia username', 'Wikipedia password'], filled: true });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const dock = await screen.findByTestId('secret-request');
    expect(screen.getByTestId('composer-slot')).not.toHaveAttribute('hidden');
    type('Username', USERNAME, dock);
    type('Password', PASSWORD, dock);
    await act(async () => { fireEvent.click(within(dock).getByRole('button', { name: 'Save and fill' })); });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    for (const call of [...send.mock.calls, ...answer.mock.calls]) expect(JSON.stringify(call)).not.toContain(PASSWORD);
  });
});

describe('a login wall the browser met', () => {
  const chrome = 'Use Chrome when it’s open';
  const wall: SecretRequestCard = { ...card, site: 'wikimedia.org', choices: [chrome] };
  const wallQuestion: ChatQuestion = {
    ...question, question: 'No saved sign-in for wikimedia.org',
    options: [{ id: 'option-1', label: chrome, hint: 'I wait for Chrome', recommended: false }, { id: 'option-2', label: 'Decline', hint: null, recommended: false }],
    request: wall,
  };

  it('is the sign-in card with the browser\'s Chrome choice as a secondary action, answered as itself', () => {
    const choice = vi.fn();
    render(<SecretRequestDock question={wallQuestion} card={wall} phone={false} container={null} disabled={false} onSettled={vi.fn()} onChoice={choice} />);
    const buttons = within(screen.getByTestId('secret-request').querySelector('.ui-toolbar') as HTMLElement).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual([chrome, 'I’ll sign in myself', 'More options', 'Save and fill']);
    expect(screen.queryByText('Take over')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Save a login for next time' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: chrome }));
    expect(choice).toHaveBeenCalledWith(chrome, 'option-1');
  });

  it('a code page keeps the browser card, and "Save a login for next time" opens the sign-in card in place, never Settings', async () => {
    const { BrowserAsk, browserCardOf } = await import('./BrowserAsk');
    const codeQuestion: ChatQuestion = {
      id: 'q2', question: 'Wikimedia asks for a code\nEnter the code on the page and give it back, and I carry on.',
      options: [{ id: 'o1', label: 'Take over', hint: null, recommended: true }, { id: 'o2', label: 'Save a login for next time', hint: null, recommended: false }],
      allowOther: false, expiresAt: '2999-01-01T00:00:00Z', request: { ...card, site: 'wikimedia.org', expand: true },
    };
    const save = vi.spyOn(api, 'saveSecretSet').mockResolvedValue({ saved: ['Wikimedia password'], filled: true });
    render(<BrowserAsk card={browserCardOf(codeQuestion)!} disabled={false} onAnswer={vi.fn()} signIn={{ question: codeQuestion, card: codeQuestion.request!, phone: false, container: null, onSettled: vi.fn() }} />);
    expect(screen.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Save a login for next time' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save a login for next time' }));
    const dock = screen.getByTestId('secret-request');
    expect(within(dock).getByText('No saved sign-in for wikimedia.org')).toBeInTheDocument();
    type('Password', PASSWORD, dock);
    fireEvent.click(within(dock).getByRole('button', { name: 'Save and fill' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'q2', then: 'fill' })));
  });

  it('a call the turn never ran (it stopped on the card first) reads "not run", not failed', () => {
    render(
      <Tooltip.Provider>
        <MessageList timezone="UTC" now={0} live={[]} onOpen={vi.fn()} emptyHint="" messages={[
          { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'list', name: 'secret.list', input: {} }] },
          { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'list', name: 'secret.list', ok: false, output: null, error: 'not-executed: waiting for the owner to answer the question; finish your reply and do not call more tools' }] },
        ]} />
      </Tooltip.Provider>,
    );
    expect(screen.getByText('not run')).toBeInTheDocument();
    expect(screen.queryByText('failed')).toBeNull();
  });
});
