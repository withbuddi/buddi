/**
 * The chips a turn leaves under the thread.
 *
 * Three things the page owes the owner, and none of them were true: the chip
 * goes the moment it is clicked (it is a thing you do once, and a button still
 * sitting there invites the second click the server then refuses); it comes
 * back, with the reason in the banner, if the take failed — a chip that
 * vanished and did nothing is the other half of the same bug; and a chip whose
 * offer has expired is not drawn at all, because clicking it can only ever be
 * refused.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import { MessageList } from './MessageList';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

const later = (): string => new Date(Date.now() + 3_600_000).toISOString();
const earlier = (): string => new Date(Date.now() - 1_000).toISOString();

const conversation = (offers: { id: string; label: string; prompt: string; expiresAt: string }[]) => ({
  conversationId: 'c2',
  agentId: 'keeper',
  messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text' as const, text: "The draft is ready." }] }],
  offers,
});

beforeEach(() => {
  const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(api, 'browserControl').mockResolvedValue(idle);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c2', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('taking a chip', () => {
  it('takes it in the open conversation, and the chip goes at once', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      conversation([{ id: 'off-1', label: 'Send it', prompt: 'send the reply I drafted', expiresAt: later() }]),
    );
    // Held open, so what is asserted is the page before the server answers.
    let answer: (value: { id: string; label: string; jobId: null; conversationId: string; runId: string }) => void = () => {};
    const take = vi.spyOn(api, 'takeOffer').mockReturnValue(
      new Promise((resolve) => { answer = resolve; }) as never,
    );

    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const chip = await screen.findByRole('button', { name: 'Send it' });
    await userEvent.click(chip);

    // Gone before the answer, and the conversation it was clicked in is named,
    // which is what makes it run in the thread instead of on the queue.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send it' })).not.toBeInTheDocument());
    expect(take).toHaveBeenCalledWith('off-1', 'c2');
    answer({ id: 'off-1', label: 'Send it', jobId: null, conversationId: 'c2', runId: 'run-1' });
  });

  it('brings it back with the refusal when the take fails', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      conversation([{ id: 'off-1', label: 'Send it', prompt: 'send the reply I drafted', expiresAt: later() }]),
    );
    vi.spyOn(api, 'takeOffer').mockRejectedValue(new ApiError(409, 'This offer has expired.'));

    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Send it' }));

    // The sentence the server sent, in the banner the page already has.
    expect(await screen.findByText('This offer has expired.')).toBeInTheDocument();
    // And the chip is on the table again rather than quietly gone.
    expect(await screen.findByRole('button', { name: 'Send it' })).toBeInTheDocument();
  });

  it('never draws a chip whose offer has expired', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      conversation([
        { id: 'off-1', label: 'Send it', prompt: 'send the reply I drafted', expiresAt: earlier() },
        { id: 'off-2', label: 'Edit the draft', prompt: 'change the second paragraph', expiresAt: later() },
      ]),
    );
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    expect(await screen.findByRole('button', { name: 'Edit the draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send it' })).not.toBeInTheDocument();
  });
});

describe('the turn a chip started', () => {
  it('reads as the label the owner clicked, with the sentence behind it', () => {
    render(
      <Tooltip.Provider>
        <MessageList
          messages={[
            { id: 'm1', role: 'user', at: '', speaker: 'offer:Send it', blocks: [{ type: 'text', text: 'send the reply I drafted to Dorothée' }] },
            { id: 'm2', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Sent.' }] },
          ]}
          live={[]}
          now={0}
          onOpen={() => {}}
          emptyHint=""
        />
      </Tooltip.Provider>,
    );
    const turn = screen.getByTestId('offer-turn');
    expect(turn).toHaveTextContent('Send it');
    // The raw prompt is never drawn as if they typed it — it is the title.
    expect(turn).not.toHaveTextContent('send the reply I drafted to Dorothée');
    expect(turn.querySelector('.wb-bubble-offer')).toHaveAttribute('title', 'send the reply I drafted to Dorothée');
    expect(screen.getByText('Sent.')).toBeInTheDocument();
  });
});
