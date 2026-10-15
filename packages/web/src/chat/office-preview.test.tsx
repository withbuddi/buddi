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
import { verifiedOfficePackage } from '@buddi/core/office-zip';
import { ArtifactPreview } from './ArtifactPreview';
import { FRAME_POLICY, safeFontNames } from './office/docx';

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
    // Office fonts fall back to what this computer has, the real one first (Calibri drew as a serif).
    const faces = [...frame.contentDocument!.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    expect(faces).toContain("@font-face { font-family: 'Calibri'; font-weight: 400; font-style: normal; src: local('Calibri'), local('Carlito'), local('Helvetica Neue'), local('Arial')");
    expect(faces).toContain("font-family: 'Calibri'; font-weight: 700; font-style: normal; src: local('Calibri Bold'), local('Carlito Bold')");
    expect(faces).toContain("font-family: 'Cambria'; font-weight: 400; font-style: normal; src: local('Cambria'), local('Caladea'), local('Georgia')");
    expect(faces).toContain("font-family: 'Consolas'; font-weight: 400; font-style: normal; src: local('Consolas'), local('Menlo')");
    expect(faces).not.toMatch(/url\(/);
    // A policy that fetches nothing, in the frame before the document, and still there after it is drawn.
    const policy = frame.contentDocument!.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute('content')).toBe(FRAME_POLICY);
    expect(FRAME_POLICY).toMatch(/^default-src 'none';/);
    expect(FRAME_POLICY).not.toMatch(/https?:|\*/);
  });

  it('cleans the font names a document gives, so none reaches the frame’s CSS as a url(', async () => {
    // font-url.docx: letter.docx with a run's rFonts and the theme's heading typeface set to CSS that loads a URL.
    serve(fixture('font-url.docx'));
    render(<ArtifactPreview artifactId="a10" filename="Fonts.docx" mime={OFFICE_MIME.docx} family="text" />);
    const frame = (await screen.findByTestId('office-docx')) as HTMLIFrameElement;
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain('Revenue grew 12% this quarter.'));
    const doc = frame.contentDocument!;
    const css = [
      ...[...doc.querySelectorAll('style')].map((style) => style.textContent ?? ''),
      ...[...doc.querySelectorAll('[style]')].map((el) => el.getAttribute('style') ?? ''),
    ].join('\n');
    expect(css).toContain('Evilbackground-imageurlhttpsevil.examplea.png');
    expect(css).not.toMatch(/url\(/i);
    expect(css).not.toContain('evil.example/');
  });

  it('keeps a font name to letters, digits, spaces and . _ -, entities and quotes included', () => {
    expect(safeFontNames(`<w:rFonts w:ascii="A;b:url(https://x)" w:hAnsi='C&#40;d' w:asciiTheme="minorHAnsi);x"/>`))
      .toBe(`<w:rFonts w:ascii="Aburlhttpsx" w:hAnsi="C40d" w:asciiTheme="minorHAnsix"/>`);
    expect(safeFontNames(`<a:latin typeface="Calibri Light" panose="020F0302020204030204"/><w:font w:name="x'y(z)"><w:sym w:font="Wingdings" w:char="F0FC"/>`))
      .toBe(`<a:latin typeface="Calibri Light" panose="020F0302020204030204"/><w:font w:name="xyz"><w:sym w:font="Wingdings" w:char="F0FC"/>`);
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

  it('says plainly that a workbook written with prefixed SpreadsheetML (x:) can’t be previewed, instead of showing it empty', async () => {
    serve(fixture('budget-prefixed.xlsx'));
    render(<ArtifactPreview artifactId="a14" filename="Budget.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    expect(await screen.findByText('This workbook can’t be previewed here. Download it or open it in your app.', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText(/The workbook is empty/)).not.toBeInTheDocument();
  });

  it('draws a workbook’s look: fills, bold, borders, number formats, widths, merges, the frozen header and conditional colour', async () => {
    serve(fixture('trip.xlsx'));
    render(<ArtifactPreview artifactId="a6" filename="Trip.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    await screen.findByTestId('office-xlsx', {}, { timeout: 10_000 });
    // Summary: a header in the theme's accent, bold white, frozen; a width of 24 characters; a merge.
    const item = await screen.findByRole('cell', { name: 'Item' });
    expect(item).toHaveStyle({ backgroundColor: '#4F81BD', color: '#FFFFFF', fontWeight: 'var(--weight-bold)', textAlign: 'center' });
    expect(item.closest('tr')).toHaveAttribute('data-frozen', 'row');
    const cols = screen.getByTestId('office-xlsx').querySelectorAll('col');
    expect(cols[1]).toHaveStyle({ width: '168px' });
    expect(screen.getByRole('cell', { name: 'Yellow cells are inputs' })).toHaveAttribute('colspan', '2');
    // Costs!B7 through Summary!B2, in euros, bold with a rule above and a double one below.
    const total = await screen.findByRole('cell', { name: '€950.50' }, { timeout: 10_000 });
    expect(total).toHaveStyle({ fontWeight: 'var(--weight-bold)' });
    expect(total.style.borderTop).toMatch(/0\.5px solid/);
    expect(total.style.borderBottom).toMatch(/2px solid/);
    fireEvent.click(screen.getByRole('tab', { name: 'Costs' }));
    // Number formats: euros, a date, a percent's error; a conditional fill on the amount over 400, bold on the food row.
    const flights = await screen.findByRole('cell', { name: '€420.50' });
    expect(flights).toHaveStyle({ backgroundColor: '#FFC7CE', color: '#9C0006' });
    expect(screen.getByRole('cell', { name: '€380.00' }).style.backgroundColor).toBe('');
    const [food, foodSubtotal] = screen.getAllByRole('cell', { name: '€150.00' });
    expect(food).toHaveStyle({ fontWeight: 'var(--weight-bold)' });
    expect(foodSubtotal!.style.fontWeight).toBe('');
    expect(screen.getAllByRole('cell', { name: '13 Oct 2026' })).toHaveLength(2);
  });

  it('computes the values of a sheet openpyxl wrote without them, says so in the footer, and shows what it could not compute as its error', async () => {
    serve(fixture('trip.xlsx'));
    render(<ArtifactPreview artifactId="a7" filename="Trip.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    await screen.findByTestId('office-xlsx', {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('tab', { name: 'Costs' }));
    expect(await screen.findByRole('cell', { name: '€800.50' }, { timeout: 10_000 })).toHaveClass('num');
    expect(screen.getByRole('cell', { name: '€950.50' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'over' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '316.83' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '#NAME?' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '#DIV/0!' })).toBeInTheDocument();
    expect(screen.getByText(/Totals calculated by buddi/)).toBeInTheDocument();
  });

  it('adds no footer note to a workbook whose values are all in the file', async () => {
    serve(fixture('budget.xlsx'));
    render(<ArtifactPreview artifactId="a8" filename="Budget.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    await screen.findByRole('cell', { name: '95.5' }, { timeout: 10_000 });
    expect(screen.queryByText(/Totals calculated by buddi/)).not.toBeInTheDocument();
  });

  it('adds no footer note when a formula’s saved value is an empty text', async () => {
    serve(fixture('cached-text.xlsx'));
    render(<ArtifactPreview artifactId="a9" filename="Budget.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    expect(await screen.findAllByRole('cell', { name: '€95.50' }, { timeout: 10_000 })).toHaveLength(2);
    expect(screen.queryByText(/Totals calculated by buddi/)).not.toBeInTheDocument();
  });

  it('shows a deck slide by slide, with no fonts fetched', async () => {
    const deck = fixture('deck.pptx');
    serve(deck);
    render(<ArtifactPreview artifactId="a3" filename="Deck.pptx" mime="application/octet-stream" family="file" />);
    expect(await screen.findByText('Slide 1 of 2')).toBeInTheDocument();
    // The viewer is handed the verified copy, never the bytes as sent.
    const verified = verifiedOfficePackage(new Uint8Array(deck), 'pptx');
    expect(typeof verified === 'string' ? verified : loaded.bytes).toBe(typeof verified === 'string' ? '' : verified.length);
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
    expect(await screen.findByText(/can’t be previewed: it is not a zip package/)).toBeInTheDocument();
  });

  it('refuses a zip bomb from its directory before any parser sees it', async () => {
    serve(fixture('bomb.docx'));
    render(<ArtifactPreview artifactId="a7" filename="Bomb.docx" mime={OFFICE_MIME.docx} family="text" />);
    expect(await screen.findByText(/can’t be previewed: word\/document\.xml unpacks to more than 50 MB/)).toBeInTheDocument();
    expect(screen.queryByTestId('office-docx')).not.toBeInTheDocument();
  });

  it('refuses a package that understates its parts’ sizes while it inflates, before any parser sees it', async () => {
    serve(fixture('lying.docx'));
    render(<ArtifactPreview artifactId="a11" filename="Lying.docx" mime={OFFICE_MIME.docx} family="text" />);
    expect(await screen.findByText(/can’t be previewed: word\/document\.xml unpacks to more than its zip directory says/)).toBeInTheDocument();
    expect(screen.queryByTestId('office-docx')).not.toBeInTheDocument();
    cleanup();
    serve(fixture('lying.xlsx'));
    render(<ArtifactPreview artifactId="a12" filename="Lying.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    expect(await screen.findByText(/can’t be previewed: xl\/worksheets\/sheet1\.xml unpacks to more than its zip directory says/)).toBeInTheDocument();
  });

  it('reads a workbook with one cell in its far corner sparsely: the shown part only, at once', async () => {
    // far-corner.xlsx: "Near" in A1 and 42 in XFD1048576. Read as rectangular rows, that is 17 billion cells.
    serve(fixture('far-corner.xlsx'));
    render(<ArtifactPreview artifactId="a13" filename="Far.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    // jsdom drawing the 1,000 × 50 shown cells is the slow part; the read itself is one cell.
    expect(await screen.findByRole('cell', { name: 'Near' }, { timeout: 30_000 })).toBeInTheDocument();
    expect(screen.getByTestId('office-xlsx').querySelectorAll('tbody tr')).toHaveLength(1_000);
    expect(screen.getByText(/Showing the first 1,000 rows and 50 columns of this sheet/)).toBeInTheDocument();
  }, 60_000);

  it('leaves a legacy or Apple file to Download', () => {
    render(<ArtifactPreview artifactId="a6" filename="Old.doc" mime="application/msword" family="text" />);
    expect(screen.queryByTestId('office-docx')).not.toBeInTheDocument();
  });
});

describe('a Word document an agent wrote, on the Canvas', () => {
  it('opens in the Word preview, with Open in app and Download beside it', async () => {
    const { api } = await import('../api');
    const { ArtifactView } = await import('../canvas/views/ArtifactView');
    const FILE = '11111111-1111-4111-8111-111111111111';
    const V1 = '22222222-2222-4222-8222-222222222222';
    vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC', platform: 'darwin', signedInThrough: 'local' } as never);
    vi.spyOn(api, 'openInAppState').mockResolvedValue({ open: false });
    vi.spyOn(api, 'file').mockResolvedValue({
      file: { id: FILE, name: 'Congratulation Letter.docx', mime: OFFICE_MIME.docx, conversationId: null, origin: 'document', createdBy: 'writer' },
      current: { fileId: FILE, version: 1, artifactId: V1, sha256: 'x', createdBy: 'writer', createdByName: 'Writer' },
      versions: [], entry: null, contexts: [], contextsTotal: 0, contextsOffset: 0, available: true,
    } as never);
    serve(fixture('letter.docx'));
    render(<ArtifactView attachment={{ type: 'attachment', artifactId: V1, fileId: FILE, filename: 'Congratulation Letter.docx', mime: OFFICE_MIME.docx, kind: 'document', sizeBytes: 9_539 }} />);
    const frame = (await screen.findByTestId('office-docx')) as HTMLIFrameElement;
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain('Quarterly letter'));
    expect(screen.queryByTestId('text-file')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in app' })).toBeInTheDocument();
    expect(screen.getByText('v1, by Writer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download/ })).toBeInTheDocument();
  });

  it('opens a format-docx write as the file’s own tab, labelled a Document, not the tool’s result card', async () => {
    // Owner's test on b9a8fe77: the tab read "Artifacts · Write" with the key-value result.
    const { api } = await import('../api');
    const { renderablesFrom } = await import('../canvas/renderables');
    const { fileTabId } = await import('../canvas/file-tabs');
    const { ArtifactView } = await import('../canvas/views/ArtifactView');
    const FILE = 'df3f04e4-0000-4000-8000-000000000000';
    const V1 = '33333333-3333-4333-8333-333333333333';
    const name = 'Congratulations Dr. Rachid AYOUBA.docx';
    const at = new Date().toISOString();
    const items = renderablesFrom({ descriptors: [], messages: [
      { id: 'u', role: 'assistant', at, blocks: [{ type: 'tool_use', id: 'w1', name: 'artifacts.write', input: { title: 'Congratulations Dr. Rachid AYOUBA', format: 'docx', content: '# Hi' } }] },
      { id: 'r', role: 'user', at, blocks: [{ type: 'tool_result', toolUseId: 'w1', name: 'artifacts.write', ok: true,
        output: { title: name, artifactId: V1, fileId: FILE, version: 1, mime: OFFICE_MIME.docx, sizeBytes: 10_331 },
        files: [{ artifactId: V1, fileId: FILE, version: 1, filename: name, mime: OFFICE_MIME.docx, deleted: false, fileDeleted: false }], fileResult: true }] },
    ] });
    expect(items.map((item) => [item.id, item.renderer, item.tool, item.title])).toEqual([[fileTabId(FILE), 'artifact', 'Document', name]]);

    vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC', platform: 'darwin', signedInThrough: 'local' } as never);
    vi.spyOn(api, 'openInAppState').mockResolvedValue({ open: false });
    vi.spyOn(api, 'file').mockResolvedValue({
      file: { id: FILE, name, mime: OFFICE_MIME.docx, conversationId: null, origin: 'document', createdBy: 'writer' },
      current: { fileId: FILE, version: 1, artifactId: V1, sha256: 'x', createdBy: 'writer', createdByName: 'Writer' },
      versions: [], entry: null, contexts: [], contextsTotal: 0, contextsOffset: 0, available: true,
    } as never);
    serve(fixture('letter.docx'));
    render(<ArtifactView {...(items[0]!.props as Parameters<typeof ArtifactView>[0])} />);
    expect(await screen.findByTestId('office-docx')).toBeInTheDocument();
    expect(screen.getByText('Document')).toBeInTheDocument();
  });

  it('opens a composed .docx as its file’s tab, one tab across the versions compose writes', async () => {
    const { renderablesFrom } = await import('../canvas/renderables');
    const { fileTabId } = await import('../canvas/file-tabs');
    const FILE = 'c0c0c0c0-0000-4000-8000-000000000000';
    const V1 = '44444444-4444-4444-8444-444444444444';
    const V2 = '55555555-5555-4555-8555-555555555555';
    const name = 'Offer for the kitchen.docx';
    const at = new Date().toISOString();
    const composed = (id: string, artifactId: string, version: number) => [
      { id: `u${id}`, role: 'assistant' as const, at, blocks: [{ type: 'tool_use' as const, id, name: 'artifacts.compose', input: { kind: 'docx', program: 'export default async () => …', ...(version > 1 ? { fileId: FILE } : { title: 'Offer for the kitchen' }) } }] },
      { id: `r${id}`, role: 'user' as const, at, blocks: [{ type: 'tool_result' as const, toolUseId: id, name: 'artifacts.compose', ok: true,
        output: { artifactId, fileId: FILE, version, filename: name, mime: OFFICE_MIME.docx, sizeBytes: 9_000, render: { kind: 'docx' }, note: 'Saved' },
        files: [{ artifactId, fileId: FILE, version, filename: name, mime: OFFICE_MIME.docx, deleted: false, fileDeleted: false }], fileResult: true as const }] },
    ];
    const items = renderablesFrom({ descriptors: [], messages: [...composed('c1', V1, 1), ...composed('c2', V2, 2)] });
    expect(items.map((item) => [item.id, item.renderer, item.tool, item.title])).toEqual([[fileTabId(FILE), 'artifact', 'Document', name]]);
  });

  it('opens no tab for a compose call that is the agent checking its work: a dry run, a guide, a program read back', async () => {
    const { renderablesFrom } = await import('../canvas/renderables');
    const { fileTabId } = await import('../canvas/file-tabs');
    const FILE = 'c1c1c1c1-0000-4000-8000-000000000000';
    const V1 = '66666666-6666-4666-8666-666666666666';
    const at = new Date().toISOString();
    type File = { artifactId: string; fileId: string; version: number; filename: string; mime: string; deleted: boolean; fileDeleted: boolean };
    // As the gateway marks them: a save is its file (`fileResult`), anything else of a document tool's is `rowOnly`.
    const call = (id: string, input: Record<string, unknown>, output: Record<string, unknown>, files: File[] = []) => [
      { id: `u${id}`, role: 'assistant' as const, at, blocks: [{ type: 'tool_use' as const, id, name: 'artifacts.compose', input }] },
      { id: `r${id}`, role: 'user' as const, at, blocks: [{ type: 'tool_result' as const, toolUseId: id, name: 'artifacts.compose', ok: true, output, files, ...(files.length ? { fileResult: true as const } : { rowOnly: true as const }) }] },
    ];
    const checking = [
      ...call('g', { guide: 'docx' }, { guide: 'docx', text: '# Composing a Word document\n\nYou write one ES module.' }),
      ...call('d', { kind: 'docx', program: 'x', title: 'Letter', dryRun: true }, { dryRun: true, kind: 'docx', sizeBytes: 9000, render: { kind: 'docx', page: { width: '8.27 in', height: '11.69 in' }, fonts: ['Georgia'], outline: [{ level: 1, text: 'Offer' }] }, note: 'Nothing was saved' }),
      ...call('s', { fileId: FILE, source: true }, { fileId: FILE, version: 1, artifactId: V1, kind: 'docx', library: 'docx', libraryVersion: '9.8.1', program: 'export default async () => …', note: 'The program of v1.' }),
    ];
    expect(renderablesFrom({ descriptors: [], messages: checking })).toEqual([]);
    // The save that follows opens the file's tab, and only that.
    const saved = call('w', { kind: 'docx', program: 'x', title: 'Letter' }, { artifactId: V1, fileId: FILE, version: 1, filename: 'Letter.docx', mime: OFFICE_MIME.docx, sizeBytes: 9000, render: { kind: 'docx' }, note: 'Saved' },
      [{ artifactId: V1, fileId: FILE, version: 1, filename: 'Letter.docx', mime: OFFICE_MIME.docx, deleted: false, fileDeleted: false }]);
    expect(renderablesFrom({ descriptors: [], messages: [...checking, ...saved] }).map((item) => item.id)).toEqual([fileTabId(FILE)]);
  });

  it('opens no tab for a failed compose run, which the agent fixes; another tool’s failure keeps its tab', async () => {
    const { renderablesFrom } = await import('../canvas/renderables');
    const at = new Date().toISOString();
    const failed = (id: string, name: string, rowOnly: boolean) => [
      { id: `u${id}`, role: 'assistant' as const, at, blocks: [{ type: 'tool_use' as const, id, name, input: {} }] },
      { id: `r${id}`, role: 'user' as const, at, blocks: [{ type: 'tool_result' as const, toolUseId: id, name, ok: false, output: null, error: 'program_error: SyntaxError: Illegal return statement', files: [], ...(rowOnly ? { rowOnly: true as const } : {}) }] },
    ];
    expect(renderablesFrom({ descriptors: [], messages: failed('f', 'artifacts.compose', true) })).toEqual([]);
    expect(renderablesFrom({ descriptors: [], messages: failed('o', 'artifacts.text', false) }).map((item) => [item.id, item.tone])).toEqual([['o', 'critical']]);
  });
});
