/**
 * A cited Claude answer, stored as a run of text blocks split at each
 * citation, reads as one passage: no sentence broken across bubbles.
 */
import { cleanup, render } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList, replyText } from './MessageList';
import type { ChatMessage } from './types';

afterEach(cleanup);

const answer: ChatMessage = {
  id: 'a1', role: 'assistant', at: '2026-10-02T23:27:40Z',
  blocks: [
    { type: 'thinking', text: '' },
    { type: 'text', text: 'One version is the IT13 2025 Edition. ' },
    { type: 'text', text: 'Its title lists an Intel i9-13900HK' },
    { type: 'text', text: '. It has ' },
    { type: 'text', text: 'Intel Iris Xe graphics' },
    { type: 'text', text: '.' },
  ],
};

describe('a cited answer', () => {
  it('draws adjacent text blocks as one bubble, joined with no separator', () => {
    render(<Tooltip.Provider><MessageList messages={[answer]} live={[]} now={0} onOpen={() => {}} emptyHint="" /></Tooltip.Provider>);
    const bubbles = document.querySelectorAll('.wb-bubble[data-rich="true"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.textContent).toBe('One version is the IT13 2025 Edition. Its title lists an Intel i9-13900HK. It has Intel Iris Xe graphics.');
  });

  it('copies as one passage too', () => {
    expect(replyText(answer)).toBe('One version is the IT13 2025 Edition. Its title lists an Intel i9-13900HK. It has Intel Iris Xe graphics.');
  });

  it('leaves the owner’s own blocks apart', () => {
    const mine: ChatMessage = { id: 'u1', role: 'user', at: answer.at, blocks: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] };
    render(<Tooltip.Provider><MessageList messages={[mine]} live={[]} now={0} onOpen={() => {}} emptyHint="" /></Tooltip.Provider>);
    expect(document.querySelectorAll('.wb-bubble')).toHaveLength(2);
  });
});
