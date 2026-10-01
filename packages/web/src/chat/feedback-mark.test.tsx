/** A reaction the owner left on Telegram shows under the agent's message it was left on. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage } from './types';

afterEach(cleanup);

describe('the reaction mark', () => {
  it("shows the owner's Telegram reaction, and the 👎 note, on that message only", () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'How much?' }] },
      { id: 'a1', role: 'assistant', at: '', blocks: [{ type: 'text', text: '42.' }],
        feedback: { value: 'down', emoji: '👎', source: 'telegram', note: 'Wrong month.' } },
      { id: 'u2', role: 'user', at: '', blocks: [{ type: 'text', text: 'Thanks' }] },
      { id: 'a2', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Any time.' }] },
    ];
    render(<MessageList messages={messages} live={[]} now={0} onOpen={() => {}} emptyHint="" />);
    const marks = screen.getAllByTestId('message-feedback');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute('data-value')).toBe('down');
    expect(marks[0]!.textContent).toContain('👎');
    expect(marks[0]!.textContent).toContain('on Telegram');
    expect(marks[0]!.textContent).toContain('Wrong month.');
  });
});
