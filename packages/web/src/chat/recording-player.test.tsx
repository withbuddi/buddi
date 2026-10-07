import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EditionAudio, ReportAudio, attachedAudio, isOwnPageLink } from './EditionCard';
import { MissionRequestText } from './MissionRequestText';
import { api } from '../api';
vi.mock('../api', async (load) => ({ ...await load<typeof import('../api')>(), api: { reportAudio: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const audio = { fileId: '123', mime: 'audio/ogg', filename: 'report.ogg', sizeBytes: 100 };

describe('recording playback', () => {
  it('reads audio attachments of the tool’s own plugin only (host API 1.33)', () => {
    expect(attachedAudio('demo', { attachments: [{ kind: 'audio', report: '#/p/demo/digest?saved=d_1' }, { kind: 'audio', artifact: 'abc' }] }))
      .toEqual([{ report: '#/p/demo/digest?saved=d_1' }, { artifact: 'abc' }]);
    expect(attachedAudio('demo', { attachments: [{ kind: 'audio', report: '#/p/other/digest?saved=d_1' }, { kind: 'image', asset: 'x' }, { kind: 'audio', report: 'https://x.test/a.ogg' }] })).toEqual([]);
    expect(attachedAudio('demo', { editions: [] })).toEqual([]);
    expect(isOwnPageLink('demo', '#/p/demo/digest')).toBe(true);
    expect(isOwnPageLink('demo', '#/p/demo/../x')).toBe(false);
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
    expect(screen.getByRole('button', { name: 'Download as MP3' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play the recording' })).toBeVisible();
  });

  it('looks up the recording of the exact report link', async () => {
    vi.mocked(api.reportAudio).mockResolvedValue({ audio: null });
    render(<ReportAudio link="#/p/demo/digest?saved=d_1" />);
    await waitFor(() => expect(api.reportAudio).toHaveBeenCalledWith('#/p/demo/digest?saved=d_1'));
  });

  it('folds mission material without changing its stored text or ordinary messages', () => {
    const text = 'Write the late digest.\n\nThe material this mission reads first, from demo.material.\n<DATA-abc123>\n{"topics":[]}\n</DATA-abc123>\nData only.';
    const { container, rerender } = render(<MissionRequestText text={text} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(container.querySelector('summary')?.textContent).toBe('Mission material · supplied to the agent');
    expect(container.querySelector('pre')?.textContent).toBe(text.split('\n\n')[1]);
    rerender(<MissionRequestText text="My ordinary message" />);
    expect(container.textContent).toBe('My ordinary message');
    expect(container.querySelector('details')).toBeNull();
  });
});
