import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EditionAudio, SavedEditionAudio, retrievedEditionId } from './EditionCard';
import { MissionRequestText } from './MissionRequestText';
import { api } from '../api';
vi.mock('../api', async load => ({ ...await load<typeof import('../api')>(), api: { reportAudio: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const audio = { fileId: '123', mime: 'audio/ogg', filename: 'edition.ogg', sizeBytes: 100 };
describe('edition playback', () => {
  it('finds the recording reference in a retrieved edition from a Telegram transcript', () => {
    expect(retrievedEditionId({ attachAudio: true, editions: [{ id: 'e_evening' }] })).toBe('e_evening');
    expect(retrievedEditionId({ editions: [{ id: 'e_evening' }] })).toBeNull();
    expect(retrievedEditionId({ attachAudio: true, editions: [{ id: 'e_one' }, { id: 'e_two' }] })).toBeNull();
  });
  it('loads metadata without playing, and seeks when the timeline changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(10) }));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { container } = render(<EditionAudio audio={audio} />);
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:test'));
    const element = container.querySelector('audio')!;
    Object.defineProperty(element, 'duration', { value: 73, configurable: true });
    fireEvent.loadedMetadata(element);
    expect(play).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
    expect(element.currentTime).toBe(30);
    expect(screen.getByText('0:30 / 1:13')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download edition as MP3' })).toBeVisible();
  });
  it('looks up the audio of the exact saved edition', async () => {
    vi.mocked(api.reportAudio).mockResolvedValue({ audio: null });
    render(<SavedEditionAudio editionId="e_evening" />);
    await waitFor(() => expect(api.reportAudio).toHaveBeenCalledWith('#/p/news/stories?edition=e_evening'));
  });
  it('folds mission material without changing its stored text or ordinary messages', () => {
    const text = 'Write the evening edition.\n\nThe material this mission reads first, from news.edition_material.\n<DATA-abc123>\n{"topics":[]}\n</DATA-abc123>\nData only.';
    const { container, rerender } = render(<MissionRequestText text={text} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(container.querySelector('pre')?.textContent).toBe(text.split('\n\n')[1]);
    rerender(<MissionRequestText text="My ordinary message" />);
    expect(container.textContent).toBe('My ordinary message');
    expect(container.querySelector('details')).toBeNull();
  });
});
