/**
 * Four refusals are one piece of news.
 *
 * A model that has guessed a colleague's id guesses several in the same turn,
 * and the thread filled with identical red rows saying the same sentence. They
 * collapse into one line that names who was asked and what it was allowed to
 * ask — expandable, because the individual calls are still the record.
 *
 * Only delegations. Every other tool draws exactly as it did.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage } from './types';

afterEach(cleanup);

const allowed = '(allowed: bookkeeper, postman)';

function refusal(index: number, target: string): ChatMessage['blocks'][number] {
  return { type: 'tool_use', id: `u${index}`, name: 'agent.delegate', input: { agent: target, task: 'what did we spend?' } };
}

function refused(index: number, target: string): ChatMessage['blocks'][number] {
  return {
    type: 'tool_result',
    toolUseId: `u${index}`,
    name: 'agent.delegate',
    ok: false,
    output: null,
    error: `delegation refused: "ada" may not delegate to "${target}" ${allowed}`,
  };
}

function thread(targets: string[], extra: ChatMessage['blocks'] = []): ChatMessage[] {
  return [
    { id: 'm1', role: 'assistant', at: '', blocks: [...targets.map((target, i) => refusal(i, target)), ...extra] },
    { id: 'm2', role: 'user', at: '', blocks: targets.map((target, i) => refused(i, target)) },
  ];
}

function show(messages: ChatMessage[]): void {
  render(
    <Tooltip.Provider>
      <MessageList messages={messages} live={[]} now={0} onOpen={() => {}} emptyHint="" agentName="Ada" />
    </Tooltip.Provider>,
  );
}

describe('a turn that was refused four delegations', () => {
  it('draws one row naming who was asked and what was allowed', () => {
    show(thread(['ledger', 'postman', 'scout', 'credo']));
    const row = screen.getByTestId('delegation-refusals');
    expect(row).toHaveTextContent('Delegation refused 4 times: ledger, postman, scout, …');
    expect(row).toHaveTextContent('(allowed: bookkeeper, postman)');
    // One row, not four.
    expect(screen.getAllByTestId('delegation-refusals')).toHaveLength(1);
  });

  it('opens onto the individual calls, each with what it was told', () => {
    show(thread(['ledger', 'postman', 'scout', 'credo']));
    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    for (const target of ['ledger', 'postman', 'scout', 'credo']) {
      expect(screen.getByText(`Agent · Delegate · ${target}`)).toBeInTheDocument();
      expect(
        screen.getByText(`delegation refused: "ada" may not delegate to "${target}" ${allowed}`),
      ).toBeInTheDocument();
    }
  });

  /*
   * A delegation that was *allowed* and then went wrong is news about the
   * work, not about the allowlist. Three different errors folded behind
   * "delegation refused 3 times" would be a sentence that is true of none of
   * them.
   */
  it('leaves delegations that failed for any other reason as their own rows', () => {
    const failed = (index: number, error: string): ChatMessage['blocks'][number] => ({
      type: 'tool_result', toolUseId: `u${index}`, name: 'agent.delegate', ok: false, output: null, error,
    });
    show([
      { id: 'm1', role: 'assistant', at: '', blocks: [refusal(0, 'ledger'), refusal(1, 'postman'), refusal(2, 'scout')] },
      { id: 'm2', role: 'user', at: '', blocks: [
        failed(0, 'Ledger cannot run here: Provider account “Work” is disabled.'),
        failed(1, 'the nested run ran out of turns'),
        failed(2, 'Postman threw: ECONNREFUSED'),
      ] },
    ]);
    expect(screen.queryByTestId('delegation-refusals')).not.toBeInTheDocument();
    expect(screen.getAllByText('Agent · Delegate')).toHaveLength(3);
  });

  it('collapses a run of real refusals even when another failure follows it', () => {
    show([
      { id: 'm1', role: 'assistant', at: '', blocks: [refusal(0, 'ledger'), refusal(1, 'postman'), refusal(2, 'scout')] },
      { id: 'm2', role: 'user', at: '', blocks: [
        refused(0, 'ledger'),
        refused(1, 'postman'),
        { type: 'tool_result', toolUseId: 'u2', name: 'agent.delegate', ok: false, output: null, error: 'the nested run ran out of turns' },
      ] },
    ]);
    expect(screen.getByTestId('delegation-refusals')).toHaveTextContent('Delegation refused 2 times: ledger, postman');
    expect(screen.getByText('Agent · Delegate')).toBeInTheDocument();
  });

  it('leaves a single refusal as the row it always was', () => {
    show(thread(['ledger']));
    expect(screen.queryByTestId('delegation-refusals')).not.toBeInTheDocument();
    expect(screen.getByText('Agent · Delegate')).toBeInTheDocument();
  });

  it('collapses nothing but delegations, and nothing that succeeded', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', at: '', blocks: [
        { type: 'tool_use', id: 'u0', name: 'orchard.forecast', input: {} },
        { type: 'tool_use', id: 'u1', name: 'shed.inventory', input: {} },
        refusal(2, 'ledger'),
        { type: 'tool_use', id: 'u3', name: 'agent.delegate', input: { agent: 'bookkeeper' } },
      ] },
      { id: 'm2', role: 'user', at: '', blocks: [
        { type: 'tool_result', toolUseId: 'u0', name: 'orchard.forecast', ok: false, output: null, error: 'no' },
        { type: 'tool_result', toolUseId: 'u1', name: 'shed.inventory', ok: false, output: null, error: 'no' },
        refused(2, 'ledger'),
        { type: 'tool_result', toolUseId: 'u3', name: 'agent.delegate', ok: true, output: { text: 'done' } },
      ] },
    ];
    show(messages);
    expect(screen.queryByTestId('delegation-refusals')).not.toBeInTheDocument();
    expect(screen.getByText('Orchard · Forecast')).toBeInTheDocument();
    expect(screen.getByText('Shed · Inventory')).toBeInTheDocument();
    expect(screen.getAllByText('Agent · Delegate')).toHaveLength(2);
  });
});
