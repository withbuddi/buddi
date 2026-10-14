/**
 * Text files on the canvas: a file a run stored opens in the editor — one tab
 * per file, by its id — follows buddi's next version in place, never loses an
 * unsaved edit to it, and saves a new version over the one it started from.
 *
 * The editor itself is CodeMirror in its own chunk; here it is a textarea
 * with the same props, so what is tested is the file view's behaviour.
 * `code-editor.test.tsx` mounts the real one.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type FileContent } from '../api';
import type { ChatMessage } from '../chat/types';
import { getDraft, resetDrafts, setDraft } from './file-drafts';
import { renderablesFrom } from './renderables';
import { fileTabId } from './file-tabs';
import { changedLines, isTextFile } from './text-files';
import { TextFileView } from './views/TextFileView';
import { Canvas } from './Canvas';
import type { CodeEditorProps } from './views/CodeEditor';

vi.mock('./views/CodeEditor', () => ({
  default: (props: CodeEditorProps) => (
    <textarea
      aria-label={props.label}
      value={props.value}
      readOnly={props.readOnly}
      data-changed={props.changed.join(',')}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); props.onSave(); } }}
    />
  ),
}));

const ID = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
const FILE = 'f0000000-0000-4000-8000-000000000000';
const OTHER = 'f1111111-0000-4000-8000-000000000000';
const CONVERSATION = 'c0000000-0000-4000-8000-000000000000';
const sha = (n: number): string => String(n).repeat(64).slice(0, 64);
/** Version `n` of a file, as `GET /api/files/:id/content` gives it. */
const content = (text: string, n: number, editable = true, fileId = FILE): FileContent => ({
  fileId, version: n, artifactId: ID(n), sha256: sha(n), createdBy: 'scout', conversationId: CONVERSATION,
  text, sizeBytes: text.length, editable, truncated: !editable,
});
const attachment = (n: number, filename: string, mime = 'text/markdown', fileId = FILE) => ({
  type: 'attachment' as const, artifactId: ID(n), fileId, filename, mime, kind: 'document', sizeBytes: null,
});
const saved = (n: number, fileId = FILE) => ({ fileId, version: n, artifactId: ID(n), sha256: sha(n), createdBy: 'owner', sizeBytes: 1, created: true });

/** The current version of each file, by file id. */
let files: Map<string, FileContent>;
beforeEach(() => {
  files = new Map();
  resetDrafts();
  vi.spyOn(api, 'fileContent').mockImplementation(async (id: string) => {
    const found = files.get(id);
    if (!found) throw new ApiError(404, 'this file was deleted from Files');
    return found;
  });
  vi.spyOn(api, 'file').mockRejectedValue(new ApiError(404, 'no such file'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('which results are text files', () => {
  it('classifies text by the server’s own rule', () => {
    expect(isTextFile('application/octet-stream', 'report.docx')).toBe(false);
    expect(isTextFile('text/x-python', 'calc.py')).toBe(true);
    // What the page once opened and the server refused: one rule now, core's.
    expect(isTextFile('application/yaml', 'a.yaml')).toBe(true);
    expect(isTextFile('application/octet-stream', 'tool.mjs')).toBe(true);
  });

  it('marks the lines that are new or changed', () => {
    expect(changedLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([2, 4]);
    expect(changedLines('same', 'same')).toEqual([]);
  });
});

describe('a text file a run produced, on the canvas', () => {
  const at = (s: number): string => new Date(Date.UTC(2026, 9, 13, 9, 0, s)).toISOString();
  type Told = { artifactId: string; fileId: string; version: number; filename: string; mime?: string; deleted?: boolean; fileDeleted?: boolean };
  /** A call and its result, with the files the gateway says it made or opened. */
  /** A call is the file it made when it wrote or opened one (the gateway's `fileResult`); a command only leaves files. */
  const call = (id: string, name: string, output: unknown, s: number, files?: Told[], readsFile = false): ChatMessage[] => [
    { id: `${id}-use`, role: 'assistant', at: at(s), blocks: [{ type: 'tool_use', id, name, input: {} }] },
    { id: `${id}-result`, role: 'user', at: at(s), blocks: [{
      type: 'tool_result', toolUseId: id, name, ok: true, output,
      ...(files ? { files: files.map((file) => ({ mime: 'text/markdown', deleted: false, fileDeleted: false, ...file })) } : {}),
      ...(readsFile ? { readsFile: true as const } : {}),
      ...(files?.length && name !== 'host.exec' ? { fileResult: true as const } : {}),
    }] },
  ];
  const told = (n: number, filename = 'Plan.md', fileId = FILE, extra: Partial<Told> = {}): Told[] => [{ artifactId: ID(n), fileId, version: n, filename, ...extra }];

  it('opens a written document as its file, and a second write updates the same tab', () => {
    const first = renderablesFrom({ messages: call('w1', 'artifacts.write', { artifactId: ID(1), fileId: FILE, filename: 'Plan.md', mime: 'text/markdown' }, 1, told(1)), descriptors: [] });
    expect(first.map((item) => [item.id, item.source, item.title, item.substantial])).toEqual([[fileTabId(FILE), 'artifact', 'Plan.md', true]]);
    const both = renderablesFrom({ messages: [
      ...call('w1', 'artifacts.write', { artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown' }, 1, told(1)),
      ...call('w2', 'artifacts.write', { artifactId: ID(2), filename: 'Plan.md', mime: 'text/markdown' }, 2, told(2)),
    ], descriptors: [] });
    expect(both).toHaveLength(1);
    expect(both[0]!.id).toBe(first[0]!.id);
    expect((both[0]!.props as { attachment: { artifactId: string } }).attachment.artifactId).toBe(ID(2));
    expect(both[0]!.versions?.map((version) => version.id)).toEqual(['w1', 'w2']);
  });

  it('keeps one tab per file across a command, writes, an open and reads — and two files with one name apart', () => {
    const items = renderablesFrom({ messages: [
      ...call('x1', 'host.exec', { exitCode: 0, stdout: 'ok', stderr: '', state: 'exited', artifacts: [{ id: ID(1), filename: 'packing.md', mime: 'text/markdown' }] }, 1, told(1, 'packing.md')),
      ...call('t1', 'artifacts.text', { id: ID(1), fileId: FILE, version: 1, text: '# a\nb\nc\nd\ne\nf\ng', chars: 9, truncated: false }, 2, [], true),
      ...call('w1', 'artifacts.write', { artifactId: ID(2), fileId: FILE, filename: 'packing.md', mime: 'text/markdown' }, 3, told(2, 'packing.md')),
      ...call('l1', 'artifacts.list', { artifacts: [{ id: ID(2), filename: 'packing.md', mime: 'text/markdown' }], count: 1 }, 4, []),
      ...call('o1', 'canvas.open', { opened: true, fileId: FILE, artifactId: ID(2), filename: 'packing.md', mime: 'text/markdown' }, 5, told(2, 'packing.md')),
      ...call('x2', 'host.exec', { exitCode: 0, stdout: '', stderr: '', state: 'exited', artifacts: [{ id: ID(7), filename: 'packing.md', mime: 'text/markdown' }] }, 6, told(7, 'packing.md', OTHER)),
      ...call('w2', 'artifacts.write', { artifactId: ID(3), fileId: FILE, filename: 'packing.md', mime: 'text/markdown' }, 7, told(3, 'packing.md')),
    ], descriptors: [] });
    const tabs = items.filter((item) => item.source === 'artifact');
    expect(tabs.map((tab) => tab.id)).toEqual([fileTabId(OTHER), fileTabId(FILE)]);
    expect(items.at(-1)).toBe(tabs[1]);
    expect((tabs[1]!.props as { attachment: { artifactId: string } }).attachment.artifactId).toBe(ID(3));
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.some((item) => item.tool === 'artifacts.text')).toBe(false);
  });

  it('keeps the tab’s id when a version is deleted, and keeps a deleted file’s tab while it holds an edit', () => {
    // Codex P1: deleting v1 moved the tab from file:v1 to file:v2, stranding its draft; deleting the file dropped it.
    const messages = (fileDeleted: boolean): ChatMessage[] => [
      ...call('w1', 'artifacts.write', { artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown' }, 1, told(1, 'Plan.md', FILE, { deleted: true, fileDeleted })),
      ...call('w2', 'artifacts.write', { artifactId: ID(2), filename: 'Plan.md', mime: 'text/markdown' }, 2, told(2, 'Plan.md', FILE, { deleted: fileDeleted, fileDeleted })),
    ];
    expect(renderablesFrom({ messages: messages(false), descriptors: [] }).map((item) => item.id)).toEqual([fileTabId(FILE)]);
    expect(renderablesFrom({ messages: messages(true), descriptors: [] })).toEqual([]);
    const kept = renderablesFrom({ messages: messages(true), descriptors: [], keep: (id) => id === fileTabId(FILE) });
    expect(kept.map((item) => item.id)).toEqual([fileTabId(FILE)]);
  });

  it('opens nothing from the shape of a result: only the files the gateway names', () => {
    const items = renderablesFrom({ messages: [
      ...call('w1', 'artifacts.write', { artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown' }, 1),
      ...call('o1', 'canvas.open', { opened: true, artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown' }, 2, []),
    ], descriptors: [] });
    expect(items.filter((item) => item.source === 'artifact')).toEqual([]);
  });

  it('puts a command’s generated text file after the command, so the canvas turns to it', () => {
    const items = renderablesFrom({ messages: call('x1', 'host.exec', {
      exitCode: 0, stdout: 'done', stderr: '', state: 'exited',
      artifacts: [{ id: ID(5), filename: 'summary.md', mime: 'text/markdown' }],
    }, 1, told(5, 'summary.md')), descriptors: [] });
    expect(items.map((item) => item.source)).toEqual(['fallback', 'artifact']);
    expect(items.at(-1)!.substantial).toBe(true);
  });

  it('puts a command’s generated Office file or PDF after the command too, as its file tab', () => {
    // Owner's test on b9a8fe77: python-docx under host.exec left a .docx; the canvas showed only Host·Exec tabs.
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const items = renderablesFrom({ messages: call('x1', 'host.exec', {
      exitCode: 0, stdout: 'saved', stderr: '', state: 'exited',
      artifacts: [{ id: ID(5), filename: 'Letter.docx', mime: DOCX }, { id: ID(6), filename: 'Letter.pdf', mime: 'application/pdf' }, { id: ID(7), filename: 'chart.png', mime: 'image/png' }],
    }, 1, [
      { artifactId: ID(5), fileId: FILE, version: 1, filename: 'Letter.docx', mime: DOCX },
      { artifactId: ID(6), fileId: OTHER, version: 1, filename: 'Letter.pdf', mime: 'application/pdf' },
      { artifactId: ID(7), fileId: ID(9), version: 1, filename: 'chart.png', mime: 'image/png' },
    ] as Told[]), descriptors: [] });
    expect(items.map((item) => [item.id, item.source, item.tool])).toEqual([
      [items[0]!.id, 'fallback', 'host.exec'],
      [fileTabId(FILE), 'artifact', 'Document'],
      [fileTabId(OTHER), 'artifact', 'PDF'],
    ]);
    expect(items.at(-1)!.substantial).toBe(true);
  });
});

describe('a file tab on the canvas', () => {
  it('draws one panel, the current version, with no stepper through the calls that touched it', async () => {
    files.set(FILE, content('# v3\n', 3));
    const tab = {
      id: fileTabId(FILE), tool: 'Document', title: 'Plan.md', renderer: 'artifact' as const, source: 'artifact' as const, at: null, substantial: true,
      props: { attachment: attachment(3, 'Plan.md'), tabId: fileTabId(FILE) },
      versions: [1, 2, 3].map((n) => ({ id: `w${n}`, at: null, title: 'Plan.md', renderer: 'artifact' as const, props: { attachment: attachment(n, 'Plan.md'), tabId: fileTabId(FILE) }, substantial: true })),
      focus: 'w1',
    };
    render(<Canvas renderables={[tab]} activeId={fileTabId(FILE)} onActivate={() => {}} timezone="UTC" />);
    expect(await screen.findByRole('heading', { name: 'v3' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="text-file"]')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Earlier results' })).toBeNull();
  });
});

describe('the file view', () => {
  const BAR = /This file changed since you opened it/;

  it('opens Markdown as its preview, with Edit beside it; anything else opens to edit', async () => {
    files.set(FILE, content('# Plan\n\nOne step\n', 1));
    render(<TextFileView attachment={attachment(1, 'Plan.md')} tabId="t" />);
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    expect(await screen.findByRole('textbox', { name: 'Edit Plan.md' })).toHaveValue('# Plan\n\nOne step\n');
    cleanup();
    files.set(OTHER, content('{"a":1}\n', 2, true, OTHER));
    render(<TextFileView attachment={attachment(2, 'data.json', 'application/json', OTHER)} tabId="u" />);
    expect(await screen.findByRole('textbox', { name: 'Edit data.json' })).toHaveValue('{"a":1}\n');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('follows buddi’s next version in place and marks what changed', async () => {
    files.set(FILE, content('a\nb\n', 1));
    const { rerender } = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    expect(await screen.findByRole('textbox')).toHaveValue('a\nb\n');
    files.set(FILE, content('a\nB\nc\n', 2));
    rerender(<TextFileView attachment={attachment(2, 'notes.txt', 'text/plain')} tabId="t" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('a\nB\nc\n'));
    expect(screen.getByRole('textbox')).toHaveAttribute('data-changed', '2,3');
    expect(screen.queryByText(BAR)).toBeNull();
  });

  it('never replaces an unsaved edit: the newer version waits behind Show theirs / Keep mine', async () => {
    files.set(FILE, content('a\n', 1));
    const save = vi.spyOn(api, 'saveFileVersion').mockResolvedValue(saved(3));
    const { rerender } = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    expect(getDraft('t')?.text).toBe('a\nmine\n');

    files.set(FILE, content('a\nfrom buddi\n', 2));
    rerender(<TextFileView attachment={attachment(2, 'notes.txt', 'text/plain')} tabId="t" />);
    expect(await screen.findByText(BAR)).toHaveTextContent('(v2 is newer)');
    expect(screen.getByRole('textbox')).toHaveValue('a\nmine\n');

    // Keep mine: the edit now sits on v2, and saves over it.
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.queryByText(BAR)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(FILE, { base: 2, text: 'a\nmine\n' }));
    await waitFor(() => expect(getDraft('t')).toBeNull());
  });

  it('Show theirs drops the edit for the newer version', async () => {
    files.set(FILE, content('a\n', 1));
    const { rerender } = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    files.set(FILE, content('a\nfrom buddi\n', 2));
    rerender(<TextFileView attachment={attachment(2, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show theirs' }));
    expect(screen.getByRole('textbox')).toHaveValue('a\nfrom buddi\n');
    expect(getDraft('t')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps an edit across the tab going to the back and coming forward', async () => {
    files.set(FILE, content('a\n', 1));
    const first = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nb\n' } });
    first.unmount();
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('a\nb\n'));
    expect(screen.queryByText(BAR)).toBeNull();
  });

  it('saves with Cmd/Ctrl+S; a save refused for a newer version offers the choice, and Keep mine saves over it', async () => {
    files.set(FILE, content('a\n', 1));
    const save = vi.spyOn(api, 'saveFileVersion')
      .mockImplementationOnce(async () => {
        files.set(FILE, content('a\nb\n', 2));
        throw new ApiError(409, 'This file changed since you opened it: v2 is newer.', { conflict: 'newer', current: { fileId: FILE, version: 2, artifactId: ID(2), sha256: sha(2), createdBy: 'scout' } });
      })
      .mockResolvedValueOnce(saved(3));
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'a\nmine\n' } });
    fireEvent.keyDown(box, { key: 's', metaKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledWith(FILE, { base: 1, text: 'a\nmine\n' }));
    expect(await screen.findByText(BAR)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(FILE, { base: 2, text: 'a\nmine\n' }));
    await waitFor(() => expect(getDraft('t')).toBeNull());
  });

  it('keeps what he typed while a save was out, over the version saved — mounted or not', async () => {
    files.set(FILE, content('a\n', 1));
    let finish: (value: ReturnType<typeof saved>) => void = () => {};
    vi.spyOn(api, 'saveFileVersion').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'a\nA\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(box, { target: { value: 'a\nA\nB\n' } });
    view.unmount();
    await act(async () => { finish(saved(2)); });
    expect(getDraft('t')).toEqual({ fileId: FILE, conversationId: CONVERSATION, base: 2, baseText: 'a\nA\n', text: 'a\nA\nB\n', crlf: false });
  });

  it('keeps an edit undone back to the old text while the save was out, as a change over the new version', async () => {
    // Codex P2: from A, save B, undo to A before the answer — A was lost, the editor marked clean.
    files.set(FILE, content('A\n', 1));
    let finish: (value: ReturnType<typeof saved>) => void = () => {};
    vi.spyOn(api, 'saveFileVersion').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'B\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(box, { target: { value: 'A\n' } });
    expect(getDraft('t')).toBeNull();
    await act(async () => { finish(saved(2)); });
    expect(getDraft('t')).toMatchObject({ base: 2, baseText: 'B\n', text: 'A\n' });
    expect(screen.getByRole('textbox')).toHaveValue('A\n');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('writes a CRLF file back with its line endings, and shows text that is not UTF-8 read-only', async () => {
    files.set(FILE, content('a,b\r\n1,2\r\n', 1));
    const save = vi.spyOn(api, 'saveFileVersion').mockResolvedValue(saved(2));
    render(<TextFileView attachment={attachment(1, 'data.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    expect(box).toHaveValue('a,b\n1,2\n');
    fireEvent.change(box, { target: { value: 'a,b\n1,2\n3,4\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(FILE, { base: 1, text: 'a,b\r\n1,2\r\n3,4\r\n' }));
    cleanup();
    files.set(OTHER, { ...content('caf�\n', 2, false, OTHER), truncated: false, note: 'encoding' });
    render(<TextFileView attachment={attachment(2, 'menu.txt', 'text/plain', OTHER)} tabId="u" />);
    expect(await screen.findByText(/not UTF-8 text, so it opens read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('offers buddi’s workspace copy when a command changed it, and Keep mine writes over it', async () => {
    files.set(FILE, content('a\n', 1));
    const save = vi.spyOn(api, 'saveFileVersion')
      .mockRejectedValueOnce(new ApiError(409, 'changed', { conflict: 'workspace', current: { fileId: FILE, version: 1, artifactId: ID(1), sha256: sha(1), createdBy: 'scout' }, workspaceText: 'a\nToiletries\n' }))
      .mockResolvedValueOnce(saved(2));
    render(<TextFileView attachment={attachment(1, 'list.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(BAR)).toHaveTextContent('a command changed its copy');
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(FILE, { base: 1, text: 'a\nmine\n', overwriteWorkspace: true }));
    await waitFor(() => expect(getDraft('t')).toBeNull());
  });

  it('says when a command is running, and saves nothing', async () => {
    files.set(FILE, content('a\n', 1));
    vi.spyOn(api, 'saveFileVersion').mockRejectedValueOnce(new ApiError(409, 'buddi is running a command; try again when it finishes', { error: 'buddi is running a command; try again when it finishes', conflict: 'busy' }));
    render(<TextFileView attachment={attachment(1, 'list.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/running a command/)).toBeInTheDocument();
    expect(getDraft('t')?.text).toBe('a\nmine\n');
  });

  it('says a file was deleted, and keeps an unsaved edit with Save as new file, made like any upload', async () => {
    render(<TextFileView attachment={attachment(7, 'gone.txt', 'text/plain', OTHER)} tabId="g" />);
    expect(await screen.findByText('This file was deleted from Files.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    cleanup();

    files.set(FILE, content('a\n', 1));
    const made = vi.spyOn(api, 'createFile').mockResolvedValue({ fileId: OTHER, version: 1, artifactId: ID(8), sha256: sha(8), createdBy: 'owner', filename: 'notes.txt' });
    const first = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    first.unmount();
    files.delete(FILE);
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    expect(await screen.findByText(/This file was deleted from Files\. Your changes are still here\./)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('a\nmine\n');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new file' }));
    await waitFor(() => expect(made).toHaveBeenCalledWith({ name: 'notes.txt', mime: 'text/plain', text: 'a\nmine\n', conversationId: CONVERSATION }));
    expect(await screen.findByText('Saved as a new file, notes.txt, in Files.')).toBeInTheDocument();
    expect(getDraft('t')).toBeNull();
  });

  it('Save as new file keeps what he typed while it was being made', async () => {
    // Codex P2: the success cleared the whole draft, edits typed meanwhile included.
    let finish: (value: { fileId: string; version: number; artifactId: string; sha256: string; createdBy: string; filename: string }) => void = () => {};
    vi.spyOn(api, 'createFile').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    files.set(FILE, content('a\n', 1));
    const first = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    first.unmount();
    files.delete(FILE);
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save as new file' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a\nmine\nmore\n' } });
    await act(async () => { finish({ fileId: OTHER, version: 1, artifactId: ID(8), sha256: sha(8), createdBy: 'owner', filename: 'notes.txt' }); });
    expect(getDraft('t')?.text).toBe('a\nmine\nmore\n');
    expect(screen.getByRole('textbox')).toHaveValue('a\nmine\nmore\n');
  });

  it('opens a file past 1 MB read-only, and says so', async () => {
    files.set(FILE, content('x'.repeat(100), 1, false));
    render(<TextFileView attachment={attachment(1, 'big.log', 'text/plain')} tabId="t" />);
    expect(await screen.findByText(/over 1 MB, so it opens read-only/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

// The store keeps what an editor holds even when it equals its base; only a difference is a draft.
describe('file drafts', () => {
  it('reports a draft only while it differs from its base', () => {
    setDraft('d', { fileId: FILE, base: 1, baseText: 'a', text: 'a' });
    expect(getDraft('d')).toBeNull();
    setDraft('d', { fileId: FILE, base: 1, baseText: 'a', text: 'b' });
    expect(getDraft('d')?.text).toBe('b');
  });
});
