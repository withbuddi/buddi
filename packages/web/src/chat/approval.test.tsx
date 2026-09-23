/**
 * A decided approval, back in the thread.
 *
 * The runtime resumes a suspended run with the action's outcome as a user
 * turn — the tool_use it answers was closed before the run suspended — and for
 * a while the dashboard drew that as a tinted bubble in the owner's column:
 * "tool result (deferred) for action …: succeeded", attributed to the person
 * who had only ever clicked Approve. It is the other half of a call, so it is
 * drawn the way the call is: one row, the result one click away.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, expect, it } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage } from './types';

afterEach(cleanup);

const resumed: ChatMessage[] = [
  {
    id: '1',
    role: 'user',
    at: '',
    speaker: 'approval:resume',
    blocks: [{
      type: 'approval_result',
      actionId: '3f0d2f2e-1a5f-4a1e-9d3c-2b6d1f0a7c11',
      name: 'platform.create_agent',
      state: 'succeeded',
      output: { id: 'ledger', handle: 'ledger' },
    }],
  },
];

function draw(messages: ChatMessage[]): void {
  render(
    <Tooltip.Provider>
      <MessageList messages={messages} live={[]} now={0} onOpen={() => {}} emptyHint="" />
    </Tooltip.Provider>,
  );
}

it('is a tool row naming the action and how it went, never the owner speaking', () => {
  draw(resumed);
  const row = screen.getByTestId('approval-result');
  expect(row.getAttribute('data-role')).toBe('assistant');
  expect(screen.getByText('Platform · Create agent')).toBeDefined();
  expect(screen.getByText('succeeded')).toBeDefined();
  // None of the runtime's wording reaches the page as prose.
  expect(screen.queryByText(/tool result \(deferred\)/)).toBeNull();
  expect(row.querySelector('.wb-bubble')).toBeNull();
});

it('opens on the result the action returned', () => {
  draw(resumed);
  expect(screen.queryByText(/"handle": "ledger"/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getByText(/"handle": "ledger"/)).toBeDefined();
});

it('still counts as something to show, so the thread is not drawn as empty', () => {
  draw(resumed);
  expect(screen.getByTestId('messages').querySelector('.wb-chat-empty')).toBeNull();
});

/*
 * A call still waiting for the owner is one line in the thread — the decision
 * is in the dock, the full request on the canvas — and the same line says
 * what became of it once decided, wherever that was.
 */
function gated(state: string): ChatMessage[] {
  return [
    { id: 'u', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'gate', name: 'shed.run', input: { command: 'unzip -l site.zip' } }] },
    { id: 'r', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'gate', name: 'shed.run', ok: !['rejected', 'expired'].includes(state), output: 'awaiting owner approval', approval: { id: 'a1', state } }] },
  ];
}

it.each([
  ['pending', 'waiting'],
  ['succeeded', 'approved'],
  ['rejected', 'rejected'],
  ['expired', 'expired'],
])('draws a %s approval as one compact line that reads %s', (state, reads) => {
  draw(gated(state));
  const line = screen.getByRole('button', { name: new RegExp(`Approval · shed\\.run unzip -l site\\.zip ${reads}`) });
  expect(line.getAttribute('data-approval')).toBe('true');
  // The card is not drawn in the thread any more.
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByText(/See the full request/)).toBeNull();
});
