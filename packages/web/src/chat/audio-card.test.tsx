/**
 * An audio file in a conversation is a small player: play and pause, the
 * time, its name and a download link. Other files stay tiles.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioCard, clock, isPlayableAudio } from './AudioCard';
import { ArtifactPreview } from './ArtifactPreview';
import { MessageList } from './MessageList';
import type { ChatMessage } from './types';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the audio card', () => {
  it('knows which files it plays', () => {
    for (const mime of ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg; codecs=opus']) expect(isPlayableAudio(mime)).toBe(true);
    expect(isPlayableAudio('image/png')).toBe(false);
    expect(clock(83)).toBe('1:23');
    expect(clock(null)).toBe('–:––');
  });

  it('shows the name, the time and a download link', () => {
    render(<AudioCard artifactId={ID} name="hello.ogg" mime="audio/ogg" />);
    expect(screen.getByText('hello.ogg')).toBeTruthy();
    expect(screen.getByTestId('audio-time').textContent).toBe('0:00 / –:––');
    const link = screen.getByRole('link', { name: 'Download hello.ogg' });
    expect(link.getAttribute('href')).toBe(`/api/artifacts/${ID}/download`);
    expect(link.getAttribute('download')).toBe('hello.ogg');
  });

  it('fetches the file on the first play, plays it and offers pause', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const fetched = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('play'));
    });
    render(<AudioCard artifactId={ID} name="hello.ogg" mime="audio/ogg" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play hello.ogg' }));
    await screen.findByRole('button', { name: 'Pause hello.ogg' });
    expect(fetched).toHaveBeenCalledWith(`/api/artifacts/${ID}/download`, { credentials: 'same-origin' });
    expect(play).toHaveBeenCalled();
  });

  it('stands in for the tile in a message, and in the preview', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', at: '', blocks: [
        { type: 'text', text: 'Here it is.' },
        { type: 'attachment', artifactId: ID, filename: 'hello.mp3', mime: 'audio/mpeg', kind: 'audio', sizeBytes: 2048 },
      ] },
    ];
    render(<MessageList messages={messages} live={[]} now={0} onOpen={() => {}} emptyHint="" />);
    expect(screen.getByTestId('audio-card')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open hello.mp3' })).toBeNull();
    cleanup();
    render(<ArtifactPreview artifactId={ID} filename="hello.wav" mime="audio/wav" family="audio" />);
    expect(screen.getByTestId('audio-card')).toBeTruthy();
  });
});

