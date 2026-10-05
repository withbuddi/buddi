/**
 * An answer the grounding guard could not get checked.
 *
 * The agent cited sources without reading anything, was asked once to verify,
 * and still read nothing. The answer is delivered, and the thread prints one
 * quiet line under it. The verdict rides on the run (`unchecked` on
 * `run.finished`), so a reloaded history draws it as the live run did.
 */
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage, ChatRun } from './types';

afterEach(() => { cleanup(); });

function run(over: Partial<ChatRun>): ChatRun {
  return {
    runId: 'r1',
    surface: 'web',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:01:00.000Z',
    turns: 2,
    stopped: 'end_turn',
    usage: { input: 0, output: 0 },
    actionId: null,
    resumed: false,
    ...over,
  };
}

const said: ChatMessage[] = [
  { id: 'm1', role: 'user', at: '2026-01-01T10:00:01.000Z', blocks: [{ type: 'text', text: 'tell me more about the ruling' }] },
  { id: 'm2', role: 'assistant', at: '2026-01-01T10:00:40.000Z', blocks: [{ type: 'text', text: 'From memory, the ruling was 6-3.' }] },
];

function show(runs: ChatRun[]): void {
  render(<MessageList messages={said} runs={runs} agentName="Concierge" onOpen={() => {}} live={[]} now={Date.now()} emptyHint="Nothing yet." working={false} />);
}

describe('the unchecked-answer line', () => {
  it('draws one quiet line under the answer of an unchecked run', () => {
    show([run({ unchecked: true })]);
    const line = screen.getByTestId('unchecked-answer');
    expect(line).toHaveTextContent('Answered from memory, not checked');
    expect(line).toHaveClass('wb-msg-unchecked');
    expect(line.closest('.wb-msg')).toHaveAttribute('data-role', 'assistant');
  });

  it('draws nothing for a checked run, or an older server that sends no verdict', () => {
    show([run({ unchecked: false }), run({ runId: 'r0', startedAt: '2026-01-01T09:00:00.000Z', finishedAt: '2026-01-01T09:01:00.000Z' })]);
    expect(screen.queryByTestId('unchecked-answer')).toBeNull();
  });
});
