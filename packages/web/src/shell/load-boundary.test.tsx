/**
 * A part of the canvas that fails to load stays that part's problem: the
 * editor's chunk rejecting leaves the dashboard, and the owner's unsaved text,
 * where they were; an update reloads through `confirmUpdate`, anything else
 * offers Retry.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type FileContent } from '../api';
import { getDraft, resetDrafts } from '../canvas/file-drafts';
import type { CodeEditorProps } from '../canvas/views/CodeEditor';
import { editorDeps, TextFileView } from '../canvas/views/TextFileView';
import { updateDeps } from './freshness';
import { LoadBoundary } from './LoadBoundary';

const FILE = 'f0000000-0000-4000-8000-000000000000';
const ARTIFACT = '00000001-0000-4000-8000-000000000000';
const content: FileContent = {
  fileId: FILE, version: 1, artifactId: ARTIFACT, sha256: '1'.repeat(64), createdBy: 'scout', conversationId: null,
  text: 'print(1)\n', sizeBytes: 9, editable: true, truncated: false,
};
const attachment = { type: 'attachment' as const, artifactId: ARTIFACT, fileId: FILE, filename: 'calc.py', mime: 'text/x-python', kind: 'document', sizeBytes: null };

const Editor = (props: CodeEditorProps): JSX.Element => (
  <textarea aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
);
const realLoad = editorDeps.load;
const realUpdateDeps = { ...updateDeps };

beforeEach(() => {
  resetDrafts();
  window.sessionStorage.clear();
  vi.spyOn(api, 'fileContent').mockResolvedValue(content);
  vi.spyOn(api, 'file').mockRejectedValue(new Error('no such file'));
  // React reports every error a boundary catches; the test reads the page instead.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  editorDeps.load = realLoad;
  Object.assign(updateDeps, realUpdateDeps);
  vi.restoreAllMocks();
});

/** The view inside a stand-in for the dashboard's shell. */
const mount = (): void => {
  render(<div><nav>The shell</nav><TextFileView attachment={attachment} tabId="tab-1" /></div>);
};

describe('the editor’s chunk failing to load', () => {
  // One test: the module's first lazy editor keeps its rejection, as React's lazy does.
  it('keeps the shell, asks whether an update is why, and offers Retry when none is', async () => {
    const reload = vi.fn();
    Object.assign(updateDeps, { served: async () => 'same', own: () => 'same', reload });
    editorDeps.load = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    mount();

    expect(await screen.findByText(/Could not load the editor/)).toBeInTheDocument();
    expect(screen.getByText('The shell')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    // Retry imports again: this time it loads.
    editorDeps.load = async () => ({ default: Editor });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const box = await screen.findByLabelText('Edit calc.py');
    expect(box).toHaveValue('print(1)\n');
    fireEvent.change(box, { target: { value: 'print(2)\n' } });
    expect(getDraft('tab-1')?.text).toBe('print(2)\n');
  });

  it('reloads when a new build is served and nothing is in progress', async () => {
    const reload = vi.fn();
    Object.assign(updateDeps, { served: async () => 'new', own: () => 'old', reload });
    // The module's first lazy editor still holds its rejection from the test above, or rejects now.
    editorDeps.load = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    mount();
    expect(await screen.findByText(/buddi was updated/)).toBeInTheDocument();
    expect(screen.getByText('The shell')).toBeInTheDocument();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('a part that throws while it draws', () => {
  it('stays inside its boundary, and Retry draws it again', async () => {
    Object.assign(updateDeps, { served: async () => 'same', own: () => 'same', reload: vi.fn() });
    let broken = true;
    const Viewer = (): JSX.Element => { if (broken) throw new Error('bad workbook'); return <p>The sheet</p>; };
    render(<div><nav>The shell</nav><LoadBoundary what="the preview"><Viewer /></LoadBoundary></div>);
    expect(screen.getByText(/Could not load the preview/)).toBeInTheDocument();
    expect(screen.getByText('The shell')).toBeInTheDocument();
    broken = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByText('The sheet')).toBeInTheDocument();
  });
});
