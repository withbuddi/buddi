/**
 * Word, Excel and PowerPoint previews (chat/OfficePreview): each renderer
 * mounts on a small real file (packages/core/src/__fixtures__/office), the
 * one preview switch picks it by core's rule, a file over the cap is
 * Download only, and nothing in the file runs on the page.
 *
 * jsdom has no canvas and no WebAssembly loader, so the deck's viewer is a
 * stand-in that says what it was handed; the document and the workbook are
 * drawn by their real libraries.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFICE_MIME } from '@buddi/core/office-files';
import { ArtifactPreview } from './ArtifactPreview';

const loaded = vi.hoisted(() => ({ bytes: 0, slides: 2, at: 0 }));
vi.mock('@silurus/ooxml/pptx', () => ({
  PptxViewer: class {
    slideIndex = 0;
    slideCount = loaded.slides;
    constructor(_canvas: HTMLCanvasElement, private readonly opts: { onSlideChange?: (i: number, n: number) => void; useGoogleFonts?: boolean }) {
      if (opts.useGoogleFonts !== false) throw new Error('fonts must stay off');
    }
    async load(source: ArrayBuffer): Promise<void> { loaded.bytes = source.byteLength; }
    async nextSlide(): Promise<void> { this.slideIndex += 1; this.opts.onSlideChange?.(this.slideIndex, this.slideCount); }
    async prevSlide(): Promise<void> { this.slideIndex -= 1; this.opts.onSlideChange?.(this.slideIndex, this.slideCount); }
    destroy(): void {}
  },
}));

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../core/src/__fixtures__/office');
const fixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

function serve(bytes: Buffer, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(status === 200 ? new Uint8Array(bytes) : null, { status })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Office previews', () => {
  it('draws a Word document into a frame that runs no script', async () => {
    serve(fixture('letter.docx'));
    render(<ArtifactPreview artifactId="a1" filename="Letter.docx" mime={OFFICE_MIME.docx} family="text" />);
    const frame = (await screen.findByTestId('office-docx')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain('Revenue grew 12% this quarter.'));
    expect(frame.contentDocument?.body.textContent).toContain('Quarterly letter');
    expect(frame.contentDocument?.querySelectorAll('script')).toHaveLength(0);
    // Nothing of the document is in the page itself.
    expect(document.body.textContent).not.toContain('Revenue grew');
  });

  it('draws a workbook as buddi’s table, one tab per sheet', async () => {
    serve(fixture('budget.xlsx'));
    render(<ArtifactPreview artifactId="a2" filename="Budget.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    const grid = await screen.findByTestId('office-xlsx', {}, { timeout: 10_000 });
    expect(grid).toHaveTextContent('Month');
    expect(screen.getByRole('cell', { name: '95.5' })).toHaveClass('num');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Budget', 'Notes']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tabs[1]!);
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Paid in full' })).toBeInTheDocument());
    expect(screen.queryByText('Month')).not.toBeInTheDocument();
  });

  it('shows a deck slide by slide, with no fonts fetched', async () => {
    const deck = fixture('deck.pptx');
    serve(deck);
    render(<ArtifactPreview artifactId="a3" filename="Deck.pptx" mime="application/octet-stream" family="file" />);
    expect(await screen.findByText('Slide 1 of 2')).toBeInTheDocument();
    expect(loaded.bytes).toBe(deck.length);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Slide 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('says a file over the cap is Download only, and a broken one plainly', async () => {
    serve(Buffer.alloc(0), 413);
    render(<ArtifactPreview artifactId="a4" filename="Huge.docx" mime={OFFICE_MIME.docx} family="text" />);
    expect(await screen.findByText(/over 20 MB, too large to preview/)).toBeInTheDocument();
    cleanup();
    serve(Buffer.from('not a zip'));
    render(<ArtifactPreview artifactId="a5" filename="Broken.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    expect(await screen.findByText(/spreadsheet could not be read/, {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  it('leaves a legacy or Apple file to Download', () => {
    render(<ArtifactPreview artifactId="a6" filename="Old.doc" mime="application/msword" family="text" />);
    expect(screen.queryByTestId('office-docx')).not.toBeInTheDocument();
  });
});
