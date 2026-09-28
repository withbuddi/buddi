/**
 * One layout for an agent's turn, before and after it speaks: the face and the
 * name on the first line, the content under it. While it works the face moves
 * and one muted line says so; the first words take that line's place.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList, type LiveTurnView } from './MessageList';
import type { ChatAgent, ChatMessage } from './types';

afterEach(cleanup);

const ada: ChatAgent = { id: 'ada', handle: 'ada', name: 'Ada', description: '', available: true, roles: [], provider: '', model: '' };
const asked: ChatMessage = { id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'What is on today?' }] };

function show(props: { messages: ChatMessage[]; working?: boolean; partial?: LiveTurnView | null }): ReturnType<typeof render> {
  return render(
    <Tooltip.Provider>
      <MessageList live={[]} now={0} onOpen={() => {}} agents={[ada]} agentId="ada" agentName="Ada" emptyHint="" {...props} />
    </Tooltip.Provider>,
  );
}

const partial = (text: string): LiveTurnView => ({ runId: 'r', turn: 1, text, thinking: '', thinkingStartedAt: null, textStartedAt: text ? 0 : null, settled: false });

describe('an agent turn', () => {
  it('carries the face, the name, then the content', () => {
    show({ messages: [asked, { id: 'a1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Two meetings.' }] }] });
    const turn = screen.getByText('Two meetings.').closest('.wb-msg')!;
    const head = turn.querySelector('[data-testid="turn-head"]')!;
    expect(head).toBe(turn.firstElementChild);
    expect(head.querySelector('.ui-avatar')).not.toBeNull();
    expect(head.textContent).toContain('Ada');
    expect(head.querySelector('[data-moving]')).toBeNull();
  });

  it('works inside the same turn, and the first words replace the line in place', () => {
    const view = show({ messages: [asked], working: true });
    const turn = screen.getByTestId('live-turn');
    expect(turn.querySelector('[data-testid="turn-head"]')!.textContent).toContain('Ada');
    expect(turn.querySelector('[data-moving="ring"]')).not.toBeNull();
    expect(screen.getByTestId('working').closest('[data-testid="live-turn"]')).toBe(turn);
    expect(screen.getByTestId('working').textContent).toContain('Ada is working');

    view.rerender(
      <Tooltip.Provider>
        <MessageList messages={[asked]} live={[]} now={0} onOpen={() => {}} agents={[ada]} agentId="ada" agentName="Ada" emptyHint="" working partial={partial('Two')} />
      </Tooltip.Provider>,
    );
    expect(screen.getByTestId('live-turn')).toBe(turn);
    expect(screen.queryByTestId('working')).toBeNull();
    expect(turn.textContent).toContain('Two');
    expect(turn.querySelector('[data-moving]')).toBeNull();
  });

  it('leaves the owner\'s words a bubble on the right, with no head', () => {
    show({ messages: [asked] });
    const mine = screen.getByText('What is on today?');
    expect(mine.className).toBe('wb-bubble');
    expect(mine.closest('.wb-msg')!.getAttribute('data-role')).toBe('user');
    expect(mine.closest('.wb-msg')!.querySelector('[data-testid="turn-head"]')).toBeNull();
  });
});
