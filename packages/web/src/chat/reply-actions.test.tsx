/**
 * Under every agent reply: Copy and Read aloud. Not under the owner's words,
 * not under a turn of tool calls. Read aloud goes through the same `say`
 * route and the same audio element as the composer's toggle.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { resetVoiceNote, speakReply } from './ChatPage';
import { stopPlayback } from './voice';
import type { ChatMessage } from './types';

afterEach(() => {
  cleanup();
  stopPlayback();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const thread: ChatMessage[] = [
  { id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'What is on today?' }] },
  { id: 'a1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Two **meetings**.' }, { type: 'text', text: 'And a dentist.' }] },
  { id: 'a2', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 't1', name: 'system.time', input: {} }] },
  { id: 'u2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 't1', name: 'system.time', ok: true, output: {} }] },
];

function show(onReadAloud?: (id: string, text: string) => void): void {
  render(
    <Tooltip.Provider>
      <MessageList messages={thread} live={[]} now={0} onOpen={() => {}} emptyHint="" agentName="Ada" {...(onReadAloud ? { onReadAloud } : {})} />
    </Tooltip.Provider>,
  );
}

describe('reply actions', () => {
  it('sit under the agent reply only', () => {
    show(() => {});
    expect(screen.getAllByTestId('reply-actions')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(1);
  });

  it('copies the reply as plain text and says so for a second', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Two **meetings**.\n\nAnd a dentist.');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy(), { timeout: 2000 });
  });

  it('reads the reply aloud through the say route, and becomes stop while it speaks', async () => {
    resetVoiceNote();
    const play = vi.fn(async () => {});
    const pause = vi.fn();
    vi.stubGlobal('Audio', class { src = ''; play = play; pause = pause; removeAttribute() {} addEventListener() {} });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body });
      return String(input).endsWith('/api/speech/say')
        ? new Response(JSON.stringify({ artifactId: 'x', audioUrl: '/api/artifacts/x/download', mime: 'audio/ogg' }), { status: 200 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }));
    show((id, text) => void speakReply(text, 'c1', id));
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    const stop = await screen.findByRole('button', { name: 'Stop reading aloud' });
    await waitFor(() => expect(play).toHaveBeenCalled());
    const say = calls.find((c) => c.url.endsWith('/api/speech/say'))!;
    expect(JSON.parse(String(say.body))).toEqual({ text: 'Two **meetings**.\n\nAnd a dentist.', conversationId: 'c1' });
    act(() => { fireEvent.click(stop); });
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy();
  });

  it('says a refusal every time a reply is asked to be read', async () => {
    resetVoiceNote();
    const sentence = 'Replies are not read aloud: the voice on this computer speaks English only.';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: sentence, reason: 'not-english' }), { status: 409 })));
    expect(await speakReply('Bonjour.', 'c1', 'a1')).toBe(sentence);
    expect(await speakReply('Bonjour.', 'c1', 'a1')).toBe(sentence);
  });
});
