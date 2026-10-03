/**
 * A document's Download menu: what each kind offers, in what order, and that
 * a choice downloads from the export route under the right name. Anything
 * that is not a document keeps its one Download link.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadMenu, exportFilename, exportOptions } from './DownloadMenu';
import { ArtifactView } from '../canvas/views/ArtifactView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the Download menu', { timeout: 180_000 }, () => {
  it('offers PDF and Word for Markdown, Excel for a table, and the file as written last', () => {
    expect(exportOptions('text/markdown', 'a.md').map((o) => o.format)).toEqual(['pdf', 'docx', 'md']);
    expect(exportOptions('text/plain', 'notes.md').map((o) => o.format)).toEqual(['pdf', 'docx', 'md']);
    expect(exportOptions('text/csv', 'b.csv').map((o) => o.format)).toEqual(['xlsx', 'csv']);
    expect(exportOptions('application/pdf', 'c.pdf')).toEqual([]);
    expect(exportFilename('Heat pumps (v2).md', 'docx')).toBe('Heat pumps (v2).docx');
  });

  it('keeps one Download link for a file buddi does not convert', () => {
    render(<DownloadMenu artifactId="a-pdf" filename="statement.pdf" mime="application/pdf" />);
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('href')).toBe('/api/artifacts/a-pdf/download');
    expect(link.getAttribute('data-variant')).toBe('accent');
  });

  it('downloads the chosen format from the export route, under the stored name', async () => {
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href')!, download: this.download });
    });
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DownloadMenu artifactId="d0c" filename="Heat pumps (v2).md" mime="text/markdown" />);
    await user.click(screen.getByRole('button', { name: 'Download Heat pumps (v2).md' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['PDF.pdf', 'Word.docx', 'Markdown.md, as written']);
    await user.click(within(menu).getByRole('menuitem', { name: /Word/ }));
    expect(clicked).toEqual([{ href: '/api/artifacts/d0c/export/docx', download: 'Heat pumps (v2).docx' }]);
    // The file as written is the plain download, which has no conversion limit.
    await user.click(screen.getByRole('button', { name: 'Download Heat pumps (v2).md' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Markdown/ }));
    expect(clicked.at(-1)).toEqual({ href: '/api/artifacts/d0c/download', download: 'Heat pumps (v2).md' });
  });

  it('sits on the canvas card of a table, with Excel first', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a,b\n1,2', { status: 200, headers: { 'X-Preview-Truncated': '0' } })));
    render(<ArtifactView attachment={{ type: 'attachment', artifactId: 'b-csv', filename: 'Budget.csv', mime: 'text/csv', kind: 'document', sizeBytes: 20 } as never} />);
    await user.click(screen.getByRole('button', { name: 'Download Budget.csv' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Excel.xlsx', 'CSV.csv, as written']);
    vi.unstubAllGlobals();
  });
});
