/**
 * Saying one more thing while the agent works.
 *
 * The composer used to go quiet mid-run: Stop where Send had been, and a
 * message the owner had already typed waiting for a turn that was not theirs
 * yet. Now it always sends — the message goes into the run that is going —
 * and the thread says where it went, in three words above the bubble, until
 * the transcript carries the same turn itself.
 *
 * Files queue with the words: the run takes them at its next step, or they
 * open the next turn. The box says where they go in a full sentence under
 * itself, and the thread marks the bubble "Queued with 1 file".
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { OWNER_INTERJECTION_SPEAKER } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

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
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c2', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the composer while the agent is working', () => {
  it('still sends, and keeps Stop beside the send button', () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} running onSend={onSend} onStop={() => {}} agentName="Ada" />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Message Ada/), { target: { value: 'in euros, please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('in euros, please', []);
  });

  it('sends a file into the run and says where it goes, in full, under the box', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ artifactId: 'art-1', filename: 'receipt.png', mime: 'image/png', kind: 'image', sizeBytes: 12 }),
      { status: 200 },
    )));
    const onSend = vi.fn();
    let handle: { addFiles: (files: File[]) => void } | null = null;
    render(
      <Composer
        ref={(h) => { handle = h; }}
        disabled={false}
        running
        onSend={onSend}
        onStop={() => {}}
        agentName="Ada"
      />,
    );
    handle!.addFiles([new File(['x'], 'receipt.png', { type: 'image/png' })]);

    fireEvent.change(screen.getByLabelText(/Message Ada/), { target: { value: 'and this one' } });
    await waitFor(() => expect(screen.getByTestId('files-wait')).toHaveTextContent('Ada picks up the file between steps, or right after this answer.'));
    // Under the box, not squeezed into the hint line beside Stop.
    expect(screen.getByTestId('files-wait').closest('.wb-composer-box')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('and this one', [expect.objectContaining({ artifactId: 'art-1' })]);
    vi.unstubAllGlobals();
  });

  it('sends files alone mid-run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ artifactId: 'art-2', filename: 'scan.pdf', mime: 'application/pdf', kind: 'document', sizeBytes: 40 }),
      { status: 200 },
    )));
    const onSend = vi.fn();
    let handle: { addFiles: (files: File[]) => void } | null = null;
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running onSend={onSend} onStop={() => {}} agentName="Ada" />);
    handle!.addFiles([new File(['x'], 'scan.pdf', { type: 'application/pdf' })]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('', [expect.objectContaining({ artifactId: 'art-2' })]);
    vi.unstubAllGlobals();
  });
});

describe('a turn added while the agent was working', () => {
  it('is the owner’s bubble, with the three words that say when it went in', () => {
    render(
      <MessageList
        messages={[{
          id: 'm1', role: 'user', at: '', speaker: OWNER_INTERJECTION_SPEAKER,
          blocks: [{ type: 'text', text: 'in euros, please' }],
        }]}
        agentName="Keeper"
        onOpen={() => {}}
        live={[]}
        now={Date.now()}
        emptyHint="Nothing yet."
        working={false}
      />,
    );
    expect(screen.getByTestId('added-while-working')).toHaveTextContent('added while working');
    expect(screen.getByText('in euros, please').closest('.wb-msg')).toHaveAttribute('data-role', 'user');
  });

  it('says "Queued with 1 file" when a file rode along, words or not', () => {
    render(
      <MessageList
        messages={[{
          id: 'p1', role: 'user', at: '', speaker: OWNER_INTERJECTION_SPEAKER,
          blocks: [{ type: 'attachment', artifactId: 'art-1', filename: 'receipt.png', mime: 'image/png', kind: 'image', sizeBytes: 12 }],
        }]}
        agentName="Keeper"
        onOpen={() => {}}
        live={[]}
        now={Date.now()}
        emptyHint="Nothing yet."
        working={false}
      />,
    );
    expect(screen.getByTestId('added-while-working')).toHaveTextContent('Queued with 1 file');
    expect(screen.getByText('receipt.png').closest('.wb-msg')).toHaveAttribute('data-role', 'user');
  });

  it('shows at once when sent and is not drawn twice once the transcript has it', async () => {
    let transcript: any = {
      conversationId: 'c2', agentId: 'keeper',
      messages: [{ id: 'm1', role: 'user', at: '', blocks: [{ type: 'text', text: 'what did we spend?' }] }],
    };
    vi.spyOn(chatApi, 'conversation').mockImplementation(async () => transcript);
    const send = vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c2', runId: 'r1' } as never);

    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const area = await screen.findByPlaceholderText(/Message/i);

    // The turn that starts the run, so the page is now watching one.
    fireEvent.change(area, { target: { value: 'what did we spend?' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Stop' });

    // And now the correction, typed while it works. The server takes it into
    // the live run and says so; the page shows it landing straight away.
    send.mockImplementation(async () => {
      // The server keeps it in `core.pending_input` and the transcript read
      // joins it on at the end, under its own id.
      transcript = {
        ...transcript,
        messages: [
          ...transcript.messages,
          { id: 'p1', role: 'user', at: '', speaker: OWNER_INTERJECTION_SPEAKER, blocks: [{ type: 'text', text: 'in euros, please' }] },
        ],
      };
      return { conversationId: 'c2', runId: 'r1', queued: true, pendingId: 'p1' } as never;
    });
    fireEvent.change(area, { target: { value: 'in euros, please' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    // It is on screen straight away, marked…
    await waitFor(() => expect(screen.getAllByTestId('added-while-working').length).toBeGreaterThan(0));
    // …and once the transcript carries the same turn, the optimistic copy
    // goes: one bubble, not two.
    await waitFor(() => expect(screen.getAllByText('in euros, please')).toHaveLength(1));
    expect(screen.getAllByTestId('added-while-working')).toHaveLength(1);
  });
});

/**
 * Two things typed while the agent worked become *one* turn when nobody
 * picked them up — and neither of them equals the joined text. Matching on
 * words would leave both copies on screen beside the turn they became, which
 * is why the page lets its own copies go by identity once the server has
 * read them back.
 */
describe('two messages added while the agent was working', () => {
  it('leaves nothing behind once they are promoted into one turn', async () => {
    let transcript: any = {
      conversationId: 'c2', agentId: 'keeper',
      messages: [{ id: 'm1', role: 'user', at: '', blocks: [{ type: 'text', text: 'draft the email' }] }],
    };
    vi.spyOn(chatApi, 'conversation').mockImplementation(async () => transcript);
    const send = vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c2', runId: 'r1' } as never);

    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const area = await screen.findByPlaceholderText(/Message/i);
    fireEvent.change(area, { target: { value: 'draft the email' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Stop' });

    let queued = 0;
    send.mockImplementation(async () => {
      queued += 1;
      return { conversationId: 'c2', runId: 'r1', queued: true, pendingId: `p${queued}` } as never;
    });
    for (const text of ['wait', 'do the other one first']) {
      fireEvent.change(area, { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: /Send/ }));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(queued + 1));
    }

    // The run ended without taking them, so the server promoted both into one
    // turn whose text is neither of the two.
    transcript = {
      ...transcript,
      messages: [
        ...transcript.messages,
        { id: 'm9', role: 'user', at: '', blocks: [{ type: 'text', text: 'wait\n\ndo the other one first' }] },
      ],
    };
    fireEvent.change(area, { target: { value: 'anything else' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(screen.getByText(/do the other one first/)).toBeInTheDocument());
    // One bubble for the promoted turn, and no orphaned copies of either half.
    await waitFor(() => expect(screen.queryAllByTestId('added-while-working')).toHaveLength(0));
    expect(screen.getAllByText(/do the other one first/)).toHaveLength(1);
  });
});
