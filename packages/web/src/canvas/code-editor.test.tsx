/**
 * The real editor (CodeMirror) mounts, reports an edit, takes a new text from
 * outside without reporting it back, marks buddi's lines, and saves on
 * Ctrl+S.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditor from './views/CodeEditor';

afterEach(cleanup);

describe('the code editor', () => {
  it('mounts, edits, follows a new text and saves', async () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const props = { onChange, onSave, readOnly: false, language: 'markdown' as const, label: 'Edit Plan.md' };
    const { container, rerender } = render(<CodeEditor {...props} value={'# Plan\n\nOne\n'} changed={[]} />);
    const content = container.querySelector('.cm-content') as HTMLElement;
    expect(content.textContent).toContain('# Plan');
    expect(content.getAttribute('aria-label')).toBe('Edit Plan.md');

    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: 'Two\n' }, userEvent: 'input' }); });
    expect(onChange).toHaveBeenLastCalledWith('# Plan\n\nOne\nTwo\n');

    onChange.mockClear();
    rerender(<CodeEditor {...props} value={'# Plan\n\nOne\nTwo\nThree\n'} changed={[5]} />);
    expect(view.state.doc.toString()).toBe('# Plan\n\nOne\nTwo\nThree\n');
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(container.querySelectorAll('.wb-code-changed')).toHaveLength(1));

    fireEvent.keyDown(content, { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('is read-only when asked', () => {
    const { container } = render(<CodeEditor value="x" changed={[]} onChange={() => {}} onSave={() => {}} readOnly language={null} label="big.log" />);
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
  });
});
