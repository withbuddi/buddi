/**
 * What a colleague made belongs to the turn that asked for it.
 *
 * The owner asked @buddi for a picture; @art drew it. The picture is drawn
 * under @buddi's message, like a file it handed over, and on the delegation
 * card with the same thumbnail and a download link.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatApi } from '../api';
import { MessageList } from './MessageList';
import { delegatedFiles } from './attachments';
import { DelegateView } from '../canvas/views/DelegateView';
import { renderablesFrom, type DelegatePanelProps } from '../canvas/renderables';
import type { ChatConversation, ChatMessage } from './types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ART = 'ed8b3763-8859-42dc-b0ef-2dbf9b1952f5';

const answer = {
  agent: 'illustrator', handle: 'art', name: 'Illustrator', conversationId: 'conv-art', runId: 'run-art',
  text: 'Generated a clockwork butterfly.', status: 'answered',
  artifacts: [{ id: ART, filename: 'clockwork-butterfly.png', mime: 'image/png', kind: 'image' }],
};

const thread: ChatMessage[] = [
  { id: 'm1', role: 'assistant', at: '', blocks: [
    { type: 'text', text: 'Asking @art.' },
    { type: 'tool_use', id: 'u1', name: 'agent.delegate', input: { agent: 'illustrator', task: 'a butterfly', conversationId: 'conv-art', agentId: 'illustrator' } },
  ] },
  { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'u1', name: 'agent.delegate', ok: true, output: answer }] },
  { id: 'm3', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Here it is.' }] },
];

describe("a delegation's files", () => {
  it("are drawn under the asking agent's message, with the image as its own thumbnail", () => {
    render(
      <Tooltip.Provider>
        <MessageList messages={thread} live={[]} now={0} onOpen={() => {}} emptyHint="" agentName="Buddi" />
      </Tooltip.Provider>,
    );
    const list = screen.getByRole('list', { name: 'Files sent with this message' });
    expect(list).toHaveTextContent('clockwork-butterfly.png');
    expect(list.querySelector('img')).toHaveAttribute('src', `/api/artifacts/${ART}/preview`);
  });

  it('are listed on the delegation card, linked to the file', async () => {
    const [card] = renderablesFrom({ messages: thread, descriptors: [] }).filter((item) => item.source === 'delegate');
    const props = card!.props as DelegatePanelProps;
    expect(props.result?.files?.map((f) => f.artifactId)).toEqual([ART]);

    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'conv-art', agentId: 'illustrator', messages: [], runs: [] } as unknown as ChatConversation);
    render(<DelegateView conversationId="conv-art" agentId="illustrator" result={props.result ?? null} />);
    const files = await screen.findByTestId('delegate-files');
    expect(files).toHaveTextContent('clockwork-butterfly.png');
    expect(files.querySelector('a')).toHaveAttribute('href', `/api/artifacts/${ART}/download`);
    expect(files.querySelector('img')).toHaveAttribute('src', `/api/artifacts/${ART}/preview`);
  });

  it('take only library ids, never a link a result wrote', () => {
    expect(delegatedFiles({ artifacts: [{ id: 'https://evil.example/x.png', filename: 'x.png' }, { id: ART, filename: 'b.png', mime: 'image/png', kind: 'image' }] }))
      .toEqual([{ type: 'attachment', artifactId: ART, filename: 'b.png', mime: 'image/png', kind: 'image', sizeBytes: null }]);
    expect(delegatedFiles('not a result')).toEqual([]);
  });
});
