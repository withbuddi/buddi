/**
 * Files in the thread: drawn as tiles, opened on the canvas.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { artifactRenderable, familyOf, formatBytes } from './attachments';
import { ArtifactView } from '../canvas/views/ArtifactView';
import type { ChatMessage } from './types';

afterEach(cleanup);

const sent: ChatMessage = {
  id: 'm1', role: 'user', at: '2026-09-19T10:00:00Z',
  blocks: [
    { type: 'text', text: "What's this" },
    { type: 'attachment', artifactId: 'a-img', filename: 'braids.png', mime: 'image/png', kind: 'image', sizeBytes: 2_836_126 },
    { type: 'attachment', artifactId: 'a-csv', filename: 'txns.csv', mime: 'text/csv', kind: 'other', sizeBytes: 900 },
  ],
};

describe('files in the thread', () => {
  it('draws an image as a picture from the preview route and a CSV as a tile with its size', () => {
    render(<Tooltip.Provider><MessageList messages={[sent]} live={[]} now={0} onOpen={() => {}} emptyHint="" /></Tooltip.Provider>);
    const img = document.querySelector('.wb-msg-files img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/artifacts/a-img/preview');
    expect(screen.getByText('txns.csv')).toBeDefined();
    expect(screen.getByText('Spreadsheet · 900 B')).toBeDefined();
    // The words are still the bubble, without a sentence about the file.
    expect(screen.getByText("What's this")).toBeDefined();
  });

  it('opens a clicked file through the page, which puts it on the canvas', () => {
    const onOpenFile = vi.fn();
    render(<Tooltip.Provider><MessageList messages={[sent]} live={[]} now={0} onOpen={() => {}} onOpenFile={onOpenFile} emptyHint="" /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open braids.png' }));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'a-img' }));
    const tab = artifactRenderable(onOpenFile.mock.calls[0]![0]);
    expect(tab).toMatchObject({ id: 'artifact:a-img', title: 'braids.png', renderer: 'artifact', source: 'artifact', substantial: false });
  });

  it('shows an image large on the canvas, and a document as a mark with a download', () => {
    const { unmount } = render(<ArtifactView attachment={sent.blocks[1] as never} />);
    expect((document.querySelector('.wb-artifact-picture img') as HTMLImageElement).getAttribute('src')).toBe('/api/artifacts/a-img/preview');
    expect((screen.getByText('Download') as HTMLAnchorElement).getAttribute('href')).toBe('/api/artifacts/a-img/download');
    unmount();
    render(<ArtifactView attachment={sent.blocks[2] as never} />);
    expect(document.querySelector('.wb-artifact-picture')).toBeNull();
    expect(screen.getByText('Spreadsheet')).toBeDefined();
  });

  it('says the agent is working where its reply will land, until something arrives', () => {
    render(<Tooltip.Provider><MessageList messages={[sent]} live={[]} now={0} onOpen={() => {}} working agentName="Playground" emptyHint="" /></Tooltip.Provider>);
    expect(screen.getByRole('status').textContent).toContain('Playground is working');
    cleanup();
    // A live tool call is a better answer to "what is it doing" than the dots.
    render(<Tooltip.Provider><MessageList messages={[sent]} live={[{ toolUseId: 't1', name: 'example.tool', startedAt: 0 }]} now={0} onOpen={() => {}} working agentName="Playground" emptyHint="" /></Tooltip.Provider>);
    expect(screen.queryByTestId('working')).toBeNull();
  });

  it('names families and sizes the way a person would', () => {
    expect(familyOf('image/png')).toBe('image');
    expect(familyOf('application/pdf')).toBe('pdf');
    expect(familyOf('text/csv')).toBe('table');
    expect(familyOf('application/octet-stream', 'notes.md')).toBe('text');
    expect(familyOf('application/octet-stream', 'main.swift')).toBe('code');
    expect(formatBytes(2_836_126)).toBe('2.7 MB');
    expect(formatBytes(900)).toBe('900 B');
  });
});
