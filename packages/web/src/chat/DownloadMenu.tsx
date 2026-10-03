/**
 * A file's Download: a menu for a document buddi can convert, one button for
 * anything else (kit: ui_kits/dashboard/Files.jsx).
 *
 * An agent writes a report as Markdown and a table as CSV (`artifacts.write`);
 * the gateway makes the PDF, the Word file and the spreadsheet on the way out
 * (`GET /api/artifacts/:id/export/:format`). The menu lists what people send
 * first and the file as written last, which is the plain download. The same component sits in the Files
 * detail and on the file's canvas card, so the choice reads the same in both.
 */
import { ActionMenu, Icon } from '../ui';
import { downloadUrl } from './attachments';

export type ExportFormat = 'md' | 'pdf' | 'docx' | 'csv' | 'xlsx';

export interface ExportOption {
  format: ExportFormat;
  label: string;
  hint: string;
  /** The file as stored: drawn last, after a hairline. */
  asWritten?: boolean;
}

/** What the gateway offers for a file: mirrors `exportFormats` in packages/gateway/src/export. */
export function exportOptions(mime: string, filename: string | null | undefined): ExportOption[] {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  if (m === 'text/markdown' || m === 'text/x-markdown' || (m === 'text/plain' && (ext === 'md' || ext === 'markdown'))) {
    return [
      { format: 'pdf', label: 'PDF', hint: '.pdf' },
      { format: 'docx', label: 'Word', hint: '.docx' },
      { format: 'md', label: 'Markdown', hint: '.md, as written', asWritten: true },
    ];
  }
  if (m === 'text/csv' || (m === 'text/plain' && ext === 'csv')) {
    return [
      { format: 'xlsx', label: 'Excel', hint: '.xlsx' },
      { format: 'csv', label: 'CSV', hint: '.csv, as written', asWritten: true },
    ];
  }
  return [];
}

export function exportUrl(artifactId: string, format: ExportFormat): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/export/${format}`;
}

/** The name the download is saved under: the stored name, the new extension. */
export function exportFilename(filename: string | null | undefined, format: ExportFormat): string {
  const base = (filename ?? 'document').replace(/\.[a-z0-9]{1,8}$/i, '') || 'document';
  return `${base}.${format}`;
}

/** Start a download from a menu item: an item is not a link, so a link is clicked for it. */
function startDownload(href: string, name: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function DownloadMenu({
  artifactId,
  filename,
  mime,
  accent = true,
}: {
  artifactId: string;
  filename: string | null | undefined;
  mime: string;
  /** The primary action of where it sits (the Files detail, the canvas card). */
  accent?: boolean;
}): JSX.Element {
  const name = filename ?? 'download';
  const options = exportOptions(mime, filename);
  const variant = accent ? 'accent' : undefined;
  if (options.length === 0) {
    return <a className="ui-btn" data-variant={variant} href={downloadUrl(artifactId)} download={name}>Download</a>;
  }
  const converted = options.filter((o) => !o.asWritten);
  const written = options.filter((o) => o.asWritten);
  const item = (o: ExportOption) => ({
    label: o.label,
    hint: o.hint,
    // The file as written is the plain download: no conversion, so no size limit.
    onSelect: () => (o.asWritten
      ? startDownload(downloadUrl(artifactId), name)
      : startDownload(exportUrl(artifactId, o.format), exportFilename(filename, o.format))),
  });
  return (
    <ActionMenu
      label={`Download ${name}`}
      note="Download as"
      items={[...converted.map(item), 'separator', ...written.map(item)]}
      trigger={
        <button type="button" className="ui-btn" data-variant={variant} aria-label={`Download ${name}`}>
          Download <Icon name="chevron-down" />
        </button>
      }
    />
  );
}
