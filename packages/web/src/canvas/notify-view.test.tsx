import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { inspectToolCall, renderablesFrom } from './renderables';
import { NotifyView } from './views/NotifyView';
import { deliveredTone } from '../chat/notify';
import type { ChatMessage } from '../chat/types';

const input = { title: 'Hello from buddi', text: 'The message you asked for.', urgency: 'now', key: 'telegram-test' };

describe('owner.notify on the canvas', () => {
  it('opens no tab by itself; opened from its row, it is drawn as the message with where it went', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'n1', name: 'owner.notify', input }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'n1', name: 'owner.notify', ok: true, output: { ok: true, delivered: 'sent to Telegram' } }] },
    ];
    expect(renderablesFrom({ messages, descriptors: [] })).toEqual([]);
    const tab = inspectToolCall(messages, 'n1');
    expect(tab).toMatchObject({ source: 'notify', title: 'Message to you' });
    render(<NotifyView {...(tab!.props as { input: unknown; output: unknown; ok: boolean })} />);
    expect(screen.getByText('sent to Telegram')).toBeInTheDocument();
    expect(screen.getByText('Hello from buddi')).toBeInTheDocument();
    expect(screen.getByText(/The message you asked for\./)).toBeInTheDocument();
    // The key is a detail, folded away.
    expect(screen.getByText('telegram-test').closest('details')).not.toHaveAttribute('open');
  });

  it('colours the outcome: sent green, held or lowered amber, refused red', () => {
    expect(deliveredTone('sent to Telegram', true)).toBe('good');
    expect(deliveredTone('held until Do not disturb ends', true)).toBe('warning');
    expect(deliveredTone("in today's end-of-day message", true)).toBe('warning');
    expect(deliveredTone('refused: the owner has muted messages from @scout', true)).toBe('critical');
    expect(deliveredTone(null, false)).toBe('critical');
  });
});
