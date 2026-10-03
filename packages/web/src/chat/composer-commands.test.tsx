/**
 * The composer's commands and mentions, run by the chat page: /use switches,
 * /new opens Agent Father with the words, /quiet answers in Telegram's words,
 * and `@father …` borrows the maker for one message.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import { DRAFT_KEY } from './draft';
import type { ChatAgent } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const agent = (id: string, name: string, roles: string[] = []): ChatAgent => ({ id, handle: id, name, description: '', available: true, roles, provider: 'anthropic', model: 'fixture' });
const onSelectAgent = vi.fn();
const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'postie', onSelectAgent, attention: new Map(), agentsInHeader: false, narrow: false,
  agents: { top: [], middle: [agent('postie', 'Postie'), agent('ledger', 'Ledger')], bottom: [agent('father', 'Agent Father', ['maker'])] },
};

beforeEach(() => {
  const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(api, 'browserControl').mockResolvedValue(idle);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [] });
  onSelectAgent.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.sessionStorage.clear(); window.location.hash = ''; });

async function box(): Promise<HTMLTextAreaElement> {
  render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
  return (await screen.findByLabelText(/Message Postie/)) as HTMLTextAreaElement;
}
const enter = (field: HTMLElement, value: string): void => {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
};

describe('commands in the chat', () => {
  it('/use @ledger switches to Ledger', async () => {
    const field = await box();
    enter(field, '/use @ledger');
    expect(onSelectAgent).toHaveBeenCalledWith('ledger');
  });

  it('/use with a handle nobody has says so', async () => {
    const field = await box();
    enter(field, '/use @nobody');
    expect(await screen.findByTestId('chat-notice')).toHaveTextContent('No agent called @nobody.');
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it('/new opens Agent Father with the words waiting in his box', async () => {
    const field = await box();
    enter(field, '/new a plant tracker');
    expect(onSelectAgent).toHaveBeenCalledWith('father');
    expect(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY)!)).toEqual({ agentId: 'father', text: "I'd like a teammate for this: a plant tracker" });
  });

  it('/quiet 1w asks the gateway and shows its sentence; nothing is sent', async () => {
    const quiet = vi.spyOn(api, 'quiet').mockResolvedValue({ text: 'Quiet until Sat 10 Oct, 14:00. /quiet off brings the messages back.' });
    const send = vi.spyOn(chatApi, 'send');
    const field = await box();
    enter(field, '/quiet 1w');
    expect(quiet).toHaveBeenCalledWith('1w');
    expect(await screen.findByTestId('chat-notice')).toHaveTextContent('Quiet until Sat 10 Oct');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('mentions in the chat', () => {
  it('@father … borrows Agent Father for the message and follows him to his thread', async () => {
    const send = vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'f1', runId: 'r1' } as never);
    const field = await box();
    enter(field, '@father make Postie firmer about late invoices');
    await waitFor(() => expect(send).toHaveBeenCalledWith('father', { text: 'make Postie firmer about late invoices', attachmentIds: [] }));
    await waitFor(() => expect(window.location.hash).toBe('#/chat/father/f1'));
  });

  it('@ledger … goes to Postie as written: the gateway tells Postie to ask Ledger', async () => {
    const send = vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c1', runId: 'r1' } as never);
    const field = await box();
    enter(field, 'check with @ledger before Friday');
    await waitFor(() => expect(send).toHaveBeenCalledWith('postie', expect.objectContaining({ text: 'check with @ledger before Friday' })));
  });
});
