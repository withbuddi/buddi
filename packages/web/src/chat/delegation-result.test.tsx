/**
 * A delegation that came back after the owner decided: unfolded, it reads as
 * who was asked, the question, the answer, the files and how long it took —
 * not as the delegate tool's output dumped as JSON, which stays under Details.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { delegationSummary, duration } from './DelegationResult';
import { MessageList } from './MessageList';
import type { ChatMessage } from './types';

afterEach(cleanup);

const ACTION = '3f0d2f2e-1a5f-4a1e-9d3c-2b6d1f0a7c11';
const FILE = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const output = {
  agent: 'ledger', handle: 'ledger', name: 'Ledger', conversationId: 'c2', runId: 'r2',
  text: 'You spent **412 €** on food in August.', status: 'answered',
  attached: 'Ledger made august.csv.',
  artifacts: [{ id: FILE, filename: 'august.csv', mime: 'text/csv', kind: 'document' }],
};

const thread: ChatMessage[] = [
  { id: 'm1', role: 'assistant', at: '2026-09-27T10:00:00.000Z', blocks: [
    { type: 'tool_use', id: 'u1', name: 'agent.delegate', input: { agent: 'ledger', task: 'What did we spend on food in August?', conversationId: 'c2', agentId: 'ledger', runId: 'r2' } },
  ] },
  { id: 'm2', role: 'user', at: '2026-09-27T10:00:05.000Z', blocks: [
    { type: 'tool_result', toolUseId: 'u1', name: 'agent.delegate', ok: true, output: null, delegation: { state: 'waiting', approvalId: ACTION } },
  ] },
  { id: 'm3', role: 'user', at: '2026-09-27T10:03:04.000Z', speaker: 'approval:resume', blocks: [
    { type: 'approval_result', actionId: ACTION, name: 'agent.delegate', state: 'succeeded', output },
  ] },
];

describe('a delegation back from a decision', () => {
  it('unfolds into who, the question, the answer, the files and the time, with the JSON under Details', () => {
    render(
      <Tooltip.Provider>
        <MessageList messages={thread} live={[]} now={0} onOpen={() => {}} emptyHint="" />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getAllByRole('button', { expanded: false }).at(-1)!);
    const card = screen.getByTestId('delegation-result');
    expect(card).toHaveTextContent('Asked Ledger · took 3m 04s');
    expect(card).toHaveTextContent('What did we spend on food in August?');
    expect(screen.getByTestId('delegation-answer').querySelector('strong')).toHaveTextContent('412 €');
    expect(screen.getByRole('list', { name: 'Files Ledger made' })).toHaveTextContent('august.csv');
    // The object is still there, folded away.
    const raw = card.querySelector('details');
    expect(raw).not.toBeNull();
    expect(raw!.open).toBe(false);
    expect(raw!.querySelector('summary')).toHaveTextContent('Raw JSON');
    expect(raw).toHaveTextContent('"status": "answered"');
  });

  it('reads a plain string answer and a missing call without guessing', () => {
    const summary = delegationSummary('Twelve.', null, null);
    expect(summary).toEqual({ who: null, question: null, answer: 'Twelve.', files: [], durationMs: null });
    expect(delegationSummary({ handle: 'ledger', text: 'ok', durationMs: 800 }, null, null)).toMatchObject({ who: '@ledger', durationMs: 800 });
  });

  it('says a span the way a person does', () => {
    expect(duration(800)).toBe('800ms');
    expect(duration(12_000)).toBe('12s');
    expect(duration(184_000)).toBe('3m 04s');
    expect(duration(3_900_000)).toBe('1h 05m');
  });
});
