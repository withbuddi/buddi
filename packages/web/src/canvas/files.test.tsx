/**
 * The Files tab, as a panel: a folder walked by its breadcrumb, a file shown
 * as what it is, an archive refused with its cap said out loud, and a list
 * read again when the conversation changes a file.
 *
 * The plugin and its queries are invented (`shed`, `root`, `ls`…): the panel
 * learns them from `GET /api/pages` and must never need a real one.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { ChatMessage } from '../chat/types';
import type { PluginWorkspaceFiles } from '../pages/types';
import { Canvas } from './Canvas';
import { FILES_TAB_ID, filesRenderable, workspaceChanges } from './files';
import type { Renderable } from './types';
import { FilesView, TEXT_VIEW_MAX_BYTES } from './views/FilesView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FILES: PluginWorkspaceFiles = { plugin: 'shed', workspace: 'root', list: 'ls', stat: 'info', read: 'cat', archive: 'pack' };

function result(id: string, output: unknown, ok = true): ChatMessage[] {
  return [
    { id: `${id}-a`, role: 'assistant', at: '', blocks: [{ type: 'tool_use', id, name: 'shed.thing', input: {} }] },
    { id: `${id}-b`, role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: id, name: 'shed.thing', ok, output }] },
  ];
}

const ROOT = {
  path: '',
  entries: [
    { name: 'src', path: 'src', kind: 'dir', bytes: null, mtimeMs: null },
    { name: 'index.html', path: 'index.html', kind: 'file', bytes: 15, mtimeMs: 1000 },
    { name: 'logo.png', path: 'logo.png', kind: 'file', bytes: 70, mtimeMs: 2000 },
    { name: 'doc.pdf', path: 'doc.pdf', kind: 'file', bytes: 900, mtimeMs: 3000 },
    { name: 'blob.bin', path: 'blob.bin', kind: 'file', bytes: 4, mtimeMs: 4000 },
  ],
  skipped: 1,
  truncated: false,
};
const SRC = { path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', bytes: 20, mtimeMs: 5000 }], skipped: 0, truncated: false };
const STATS: Record<string, unknown> = {
  'index.html': { path: 'index.html', name: 'index.html', bytes: 15, mtimeMs: 1000, type: 'text', mime: 'text/plain; charset=utf-8' },
  'logo.png': { path: 'logo.png', name: 'logo.png', bytes: 70, mtimeMs: 2000.4, type: 'image', mime: 'image/png' },
  'doc.pdf': { path: 'doc.pdf', name: 'doc.pdf', bytes: 900, mtimeMs: 3000, type: 'pdf', mime: 'application/pdf' },
  'blob.bin': { path: 'blob.bin', name: 'blob.bin', bytes: 4, mtimeMs: 4000, type: 'other', mime: 'application/octet-stream' },
  'big.log': { path: 'big.log', name: 'big.log', bytes: TEXT_VIEW_MAX_BYTES + 1, mtimeMs: 1, type: 'text', mime: 'text/plain; charset=utf-8' },
};

function server() {
  const query = vi.spyOn(api, 'pageQuery').mockImplementation(async (_plugin, name, params = {}) => {
    if (name === 'ls') return { data: params.path === 'src' ? SRC : ROOT } as never;
    if (name === 'info') return { data: STATS[params.path!] } as never;
    throw new Error(`unexpected ${name}`);
  });
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/pack')) {
      return new Response(JSON.stringify({ error: 'This folder is over the archive cap of 100 MB or 5,000 files. Download a smaller folder.' }), { status: 400 });
    }
    return new Response('<h1>hello</h1>\n', { status: 200 });
  }));
  return { query, fetched };
}

describe('what counts as a change to the workspace', () => {
  it('counts a result carrying a diff and a path, and nothing else', () => {
    const messages = [
      ...result('w1', { path: 'index.html', diff: '+<h1>hi</h1>' }),
      ...result('w2', { path: 'index.html', diff: '' }),
      ...result('w3', { diff: '+x' }),
      ...result('w4', { path: 'a.ts', diff: '+x' }, false),
      ...result('r1', { command: 'npm test', stdout: 'ok' }),
      ...result('w5', { path: 'src/app.ts', diff: '-a\n+b' }),
    ];
    expect(workspaceChanges(messages)).toBe(2);
  });

  it('is a pinned tab that never takes the screen by itself, and cannot be closed', () => {
    const tab = filesRenderable({ files: FILES, agentId: 'keeper', root: 'garden' }, 0);
    expect(tab).toMatchObject({ id: FILES_TAB_ID, title: 'Files', source: 'files', pinned: true, substantial: false });
    const other: Renderable = { id: 't1', tool: 'shed.thing', title: 'Rows', renderer: 'keyvalue', props: { pairs: [] }, at: null, source: 'descriptor', substantial: true };
    server();
    render(<Canvas renderables={[tab, other]} activeId="t1" onActivate={vi.fn()} timezone="UTC" onClose={vi.fn()} maxTabs={2} />);
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Rows' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Close Files tab' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Rows tab' })).toBeInTheDocument();
  });
});

describe('the Files panel', () => {
  const view = (revision = 0) => <FilesView files={FILES} agentId="keeper" root="garden" revision={revision} />;

  it('lists the root, folders first, and walks into a folder and back by the breadcrumb', async () => {
    const { query } = server();
    render(view());
    expect(await screen.findByText('src/')).toBeInTheDocument();
    expect(query).toHaveBeenCalledWith('shed', 'ls', { agent: 'keeper' });
    expect(screen.getByText(/1 entry is not shown/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('src/'));
    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(query).toHaveBeenCalledWith('shed', 'ls', { agent: 'keeper', path: 'src' });
    fireEvent.click(screen.getByRole('button', { name: 'garden' }));
    expect(await screen.findByText('index.html')).toBeInTheDocument();
  });

  it('reads the folder again when the conversation changes a file', async () => {
    const { query } = server();
    const { rerender } = render(view(0));
    await screen.findByText('src/');
    const before = query.mock.calls.filter(([, name]) => name === 'ls').length;
    rerender(view(1));
    await waitFor(() => expect(query.mock.calls.filter(([, name]) => name === 'ls').length).toBe(before + 1));
  });

  it('shows text as text, in a monospace block that wraps on request', async () => {
    const { fetched } = server();
    render(view());
    fireEvent.click(await screen.findByText('index.html'));
    const text = await screen.findByTestId('files-text');
    expect(text.textContent).toBe('<h1>hello</h1>\n');
    expect(text).not.toHaveAttribute('data-wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Wrap' }));
    expect(screen.getByTestId('files-text')).toHaveAttribute('data-wrap', 'true');
    // Versioned by size and mtime, so a rewritten file is a new URL.
    expect(fetched.at(-1)).toBe('/api/pages/shed/cat?agent=keeper&path=index.html&v=15-1000');
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/pages/shed/cat?agent=keeper&path=index.html&download=1');
  });

  it('shows an image as itself and a PDF in the browser viewer', async () => {
    server();
    render(view());
    fireEvent.click(await screen.findByText('logo.png'));
    const img = await screen.findByRole('img', { name: 'logo.png' });
    expect(img).toHaveAttribute('src', '/api/pages/shed/cat?agent=keeper&path=logo.png&v=70-2000');
    fireEvent.click(screen.getByRole('button', { name: 'garden' }));
    fireEvent.click(await screen.findByText('doc.pdf'));
    await waitFor(() => expect(document.querySelector('object[type="application/pdf"]')).not.toBeNull());
    expect(document.querySelector('object')!.getAttribute('data')).toBe('/api/pages/shed/cat?agent=keeper&path=doc.pdf&v=900-3000');
  });

  it('gives anything else its size and a download', async () => {
    server();
    render(view());
    fireEvent.click(await screen.findByText('blob.bin'));
    expect(await screen.findByText(/not shown here/)).toBeInTheDocument();
    expect(screen.getByText('4 B')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrap' })).toBeNull();
  });

  it('says the cap when a folder is too big to archive', async () => {
    server();
    render(view());
    await screen.findByText('src/');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download as archive' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('archive cap of 100 MB or 5,000 files');
  });

  it('offers nothing that writes', async () => {
    server();
    render(view());
    await screen.findByText('src/');
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Download as archive']);
  });
});
