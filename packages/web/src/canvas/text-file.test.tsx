/**
 * Text files on the canvas (2026-10-13): a file a run stored opens in the
 * editor, follows buddi's next write in place, never loses an unsaved edit to
 * it, and saves back with the version it started from.
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
import { getDraft, resetDrafts } from './file-drafts';
import { renderablesFrom } from './renderables';
import { changedLines, fileChainName, isTextFile, textFilesOf } from './text-files';
import { TextFileView } from './views/TextFileView';
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
const sha = (n: number): string => String(n).repeat(64).slice(0, 64);
const content = (text: string, n: number, editable = true): FileContent => ({ text, sha256: sha(n), sizeBytes: text.length, editable, truncated: !editable });
const attachment = (n: number, filename: string, mime = 'text/markdown') => ({
  type: 'attachment' as const, artifactId: ID(n), filename, mime, kind: 'document', sizeBytes: null,
});

let files: Map<string, FileContent>;
beforeEach(() => {
  files = new Map();
  resetDrafts();
  vi.spyOn(api, 'fileContent').mockImplementation(async (id: string) => {
    const found = files.get(id);
    if (!found) throw new ApiError(404, 'no such file');
    return found;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('which results are text files', () => {
  it('reads a document write and a command’s generated files by shape, text only', () => {
    expect(textFilesOf({ artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown', note: 'Saved' })).toHaveLength(1);
    expect(textFilesOf({ exitCode: 0, artifacts: [
      { id: ID(2), filename: 'out.json', mime: 'application/json' },
      { id: ID(3), filename: 'chart.png', mime: 'image/png' },
      { id: ID(4), filename: 'run.log', mime: 'application/octet-stream' },
      { id: '../../etc/passwd', filename: 'passwd', mime: 'text/plain' },
    ] }).map((file) => file.filename)).toEqual(['out.json', 'run.log']);
    expect(isTextFile('application/octet-stream', 'report.docx')).toBe(false);
    expect(isTextFile('text/x-python', 'calc.py')).toBe(true);
    expect(fileChainName('Plan (v3).md')).toBe('plan.md');
  });

  it('marks the lines that are new or changed', () => {
    expect(changedLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([2, 4]);
    expect(changedLines('same', 'same')).toEqual([]);
  });
});

describe('a text file a run produced, on the canvas', () => {
  const at = (s: number): string => new Date(Date.UTC(2026, 9, 13, 9, 0, s)).toISOString();
  const call = (id: string, name: string, output: unknown, s: number): ChatMessage[] => [
    { id: `${id}-use`, role: 'assistant', at: at(s), blocks: [{ type: 'tool_use', id, name, input: {} }] },
    { id: `${id}-result`, role: 'user', at: at(s), blocks: [{ type: 'tool_result', toolUseId: id, name, ok: true, output }] },
  ];

  it('opens a written document as its file, and a second write updates the same tab', () => {
    const first = renderablesFrom({ messages: call('w1', 'artifacts.write', { artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown', note: 'Saved' }, 1), descriptors: [] });
    expect(first.map((item) => [item.source, item.title, item.substantial])).toEqual([['artifact', 'Plan.md', true]]);
    const both = renderablesFrom({ messages: [
      ...call('w1', 'artifacts.write', { artifactId: ID(1), filename: 'Plan.md', mime: 'text/markdown' }, 1),
      ...call('w2', 'artifacts.write', { artifactId: ID(2), filename: 'Plan (v2).md', mime: 'text/markdown' }, 2),
    ], descriptors: [] });
    expect(both).toHaveLength(1);
    expect(both[0]!.id).toBe(first[0]!.id);
    expect((both[0]!.props as { attachment: { artifactId: string } }).attachment.artifactId).toBe(ID(2));
    expect(both[0]!.versions?.map((version) => version.id)).toEqual(['w1', 'w2']);
  });

  it('keeps same-named files from different tools apart', () => {
    const items = renderablesFrom({ messages: [
      ...call('w1', 'artifacts.write', { artifactId: ID(1), filename: 'notes.md', mime: 'text/markdown' }, 1),
      ...call('x1', 'host.exec', { exitCode: 0, stdout: '', stderr: '', state: 'exited', artifacts: [{ id: ID(2), filename: 'notes.md', mime: 'text/markdown' }] }, 2),
      ...call('x2', 'host.exec', { exitCode: 0, stdout: '', stderr: '', state: 'exited', artifacts: [{ id: ID(3), filename: 'notes.md', mime: 'text/plain' }] }, 3),
    ], descriptors: [] });
    expect(items.filter((item) => item.source === 'artifact')).toHaveLength(3);
  });

  it('puts a command’s generated text file after the command, so the canvas turns to it', () => {
    const items = renderablesFrom({ messages: call('x1', 'host.exec', {
      exitCode: 0, stdout: 'done', stderr: '', state: 'exited',
      artifacts: [{ id: ID(5), filename: 'summary.md', mime: 'text/markdown' }],
    }, 1), descriptors: [] });
    expect(items.map((item) => item.source)).toEqual(['fallback', 'artifact']);
    expect(items.at(-1)!.substantial).toBe(true);
  });
});

describe('the file view', () => {
  it('opens Markdown as its preview, with Edit beside it; anything else opens to edit', async () => {
    files.set(ID(1), content('# Plan\n\nOne step\n', 1));
    render(<TextFileView attachment={attachment(1, 'Plan.md')} tabId="t" />);
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    expect(await screen.findByRole('textbox', { name: 'Edit Plan.md' })).toHaveValue('# Plan\n\nOne step\n');
    cleanup();
    files.set(ID(2), content('{"a":1}\n', 2));
    render(<TextFileView attachment={attachment(2, 'data.json', 'application/json')} tabId="u" />);
    expect(await screen.findByRole('textbox', { name: 'Edit data.json' })).toHaveValue('{"a":1}\n');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('follows buddi’s next write in place and marks what changed', async () => {
    files.set(ID(1), content('a\nb\n', 1));
    files.set(ID(2), content('a\nB\nc\n', 2));
    const { rerender } = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    expect(await screen.findByRole('textbox')).toHaveValue('a\nb\n');
    rerender(<TextFileView attachment={attachment(2, 'notes (v2).txt', 'text/plain')} tabId="t" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('a\nB\nc\n'));
    expect(screen.getByRole('textbox')).toHaveAttribute('data-changed', '2,3');
    expect(screen.queryByText('buddi changed this file')).toBeNull();
  });

  it('never replaces an unsaved edit: buddi’s version waits behind Show theirs / Keep mine', async () => {
    files.set(ID(1), content('a\n', 1));
    files.set(ID(2), content('a\nfrom buddi\n', 2));
    const save = vi.spyOn(api, 'saveFileContent').mockResolvedValue({ sha256: sha(3), sizeBytes: 9 });
    const { rerender } = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    expect(getDraft('t')?.text).toBe('a\nmine\n');

    rerender(<TextFileView attachment={attachment(2, 'notes.txt', 'text/plain')} tabId="t" />);
    expect(await screen.findByText('buddi changed this file')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('a\nmine\n');

    // Keep mine: the edit now sits on buddi's version, and saves against it.
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.queryByText('buddi changed this file')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(ID(2), { text: 'a\nmine\n', base: sha(2) }));
    await waitFor(() => expect(getDraft('t')).toBeNull());
  });

  it('Show theirs drops the edit for buddi’s version', async () => {
    files.set(ID(1), content('a\n', 1));
    files.set(ID(2), content('a\nfrom buddi\n', 2));
    const { rerender } = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    rerender(<TextFileView attachment={attachment(2, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show theirs' }));
    expect(screen.getByRole('textbox')).toHaveValue('a\nfrom buddi\n');
    expect(getDraft('t')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps an edit across the tab going to the back and coming forward', async () => {
    files.set(ID(1), content('a\n', 1));
    const first = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nb\n' } });
    first.unmount();
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('a\nb\n'));
    expect(screen.queryByText('buddi changed this file')).toBeNull();
  });

  it('saves with Cmd/Ctrl+S; a save refused for another file offers the choice and waits for Save', async () => {
    files.set(ID(1), content('a\n', 1));
    files.set(ID(2), content('a\nb\n', 2));
    const save = vi.spyOn(api, 'saveFileContent')
      .mockRejectedValueOnce(new ApiError(409, 'the file changed since you opened it', { current: { artifactId: ID(2), sha256: sha(2), filename: 'notes (v2).txt' } }))
      .mockResolvedValueOnce({ sha256: sha(4), sizeBytes: 5 });
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'a\nmine\n' } });
    fireEvent.keyDown(box, { key: 's', metaKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledWith(ID(1), { text: 'a\nmine\n', base: sha(1) }));
    expect(await screen.findByText('buddi changed this file')).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await act(async () => { await Promise.resolve(); });
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(ID(2), { text: 'a\nmine\n', base: sha(2) }));
    await waitFor(() => expect(getDraft('t')).toBeNull());
  });

  it('saves again at once when Keep mine answers a refusal of the same file', async () => {
    files.set(ID(1), content('a\n', 1));
    const save = vi.spyOn(api, 'saveFileContent')
      .mockImplementationOnce(async () => { files.set(ID(1), content('a\nnew\n', 5)); throw new ApiError(409, 'changed', { current: { artifactId: ID(1), sha256: sha(5), filename: 'notes.txt' } }); })
      .mockResolvedValueOnce({ sha256: sha(6), sizeBytes: 7 });
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(ID(1), { text: 'a\nmine\n', base: sha(5) }));
  });

  it('keeps what he typed while a save was out, over the version saved — mounted or not', async () => {
    files.set(ID(1), content('a\n', 1));
    let finish: (value: { sha256: string; sizeBytes: number }) => void = () => {};
    vi.spyOn(api, 'saveFileContent').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'a\nA\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(box, { target: { value: 'a\nA\nB\n' } });
    view.unmount();
    await act(async () => { finish({ sha256: sha(7), sizeBytes: 4 }); });
    expect(getDraft('t')).toEqual({ artifactId: ID(1), base: sha(7), baseText: 'a\nA\n', text: 'a\nA\nB\n', crlf: false });
  });

  it('opens on the version he settled on when the tab comes forward again', async () => {
    files.set(ID(1), content('a\n', 1));
    files.set(ID(2), content('a\ntheirs\n', 2));
    vi.spyOn(api, 'saveFileContent').mockRejectedValueOnce(new ApiError(409, 'changed', { current: { artifactId: ID(2), sha256: sha(2), filename: 'notes (v2).txt' } }));
    const first = render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show theirs' }));
    first.unmount();
    render(<TextFileView attachment={attachment(1, 'notes.txt', 'text/plain')} tabId="t" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('a\ntheirs\n'));
    expect(screen.queryByText('buddi changed this file')).toBeNull();
  });

  it('writes a CRLF file back with its line endings, and shows text that is not UTF-8 read-only', async () => {
    files.set(ID(1), content('a,b\r\n1,2\r\n', 1));
    const save = vi.spyOn(api, 'saveFileContent').mockResolvedValue({ sha256: sha(8), sizeBytes: 15 });
    render(<TextFileView attachment={attachment(1, 'data.txt', 'text/plain')} tabId="t" />);
    const box = await screen.findByRole('textbox');
    expect(box).toHaveValue('a,b\n1,2\n');
    fireEvent.change(box, { target: { value: 'a,b\n1,2\n3,4\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(ID(1), { text: 'a,b\r\n1,2\r\n3,4\r\n', base: sha(1) }));
    cleanup();
    files.set(ID(2), { ...content('caf\ufffd\n', 2, false), truncated: false, note: 'encoding' });
    render(<TextFileView attachment={attachment(2, 'menu.txt', 'text/plain')} tabId="u" />);
    expect(await screen.findByText(/not UTF-8 text, so it opens read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('offers buddi’s workspace copy when a command changed it, and Keep mine writes over it', async () => {
    files.set(ID(1), content('a\n', 1));
    const save = vi.spyOn(api, 'saveFileContent')
      .mockRejectedValueOnce(new ApiError(409, 'changed in its workspace', { current: { artifactId: ID(1), sha256: sha(1) }, workspaceText: 'a\nToiletries\n' }))
      .mockResolvedValueOnce({ sha256: sha(9), sizeBytes: 7 });
    render(<TextFileView attachment={attachment(1, 'list.txt', 'text/plain')} tabId="t" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'a\nmine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(ID(1), { text: 'a\nmine\n', base: sha(1), overwriteWorkspace: true }));
    await waitFor(() => expect(getDraft('t')).toBeNull());
  });

  it('opens a file past 1 MB read-only, and says so', async () => {
    files.set(ID(1), content('x'.repeat(100), 1, false));
    render(<TextFileView attachment={attachment(1, 'big.log', 'text/plain')} tabId="t" />);
    expect(await screen.findByText(/over 1 MB, so it opens read-only/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
