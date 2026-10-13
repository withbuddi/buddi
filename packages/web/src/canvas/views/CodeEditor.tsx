/**
 * The text editor on the canvas: CodeMirror 6, in its own chunk.
 *
 * Loaded only when a text file is opened (`TextFileView` imports it lazily),
 * so the dashboard's first paint carries none of it. Colours are the page's
 * tokens: the highlighter only names classes (`tok-keyword`, …) and
 * styles.css paints them, in both themes.
 *
 * Controlled from outside: `value` is the text the page holds. A keystroke
 * reports through `onChange`; a new `value` that is not what the editor
 * already shows (buddi wrote the file again, the owner chose theirs) replaces
 * the document, and `changed` marks those lines for a moment.
 */
import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLine, type DecorationSet } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { EditorLanguage } from '../text-files';

export interface CodeEditorProps {
  value: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  language: EditorLanguage | null;
  /** Lines (1-based) buddi just changed: marked, then faded by styles.css. */
  changed: readonly number[];
  onSave: () => void;
  label: string;
}

async function languageExtension(language: EditorLanguage | null): Promise<Extension> {
  switch (language) {
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'python': return (await import('@codemirror/lang-python')).python();
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'shell': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
    default: return [];
  }
}

const markLines = StateEffect.define<readonly number[]>();
const changedMark = Decoration.line({ class: 'wb-code-changed' });
const changedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(markLines)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      for (const line of [...effect.value].sort((a, b) => a - b)) {
        if (line < 1 || line > tr.state.doc.lines) continue;
        const at = tr.state.doc.line(line).from;
        builder.add(at, at, changedMark);
      }
      next = builder.finish();
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export default function CodeEditor({ value, onChange, readOnly, language, changed, onSave, label }: CodeEditorProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  /** Set while a new `value` is written in, so it is not reported back as an edit. */
  const applying = useRef(false);
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment() });

  useEffect(() => {
    if (!host.current) return undefined;
    const { language: lang, readOnly: ro } = compartments.current;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping,
          changedField,
          lang.of([]),
          ro.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { callbacks.current.onSave(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applying.current) {
              callbacks.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // The editor is made once; every prop after that is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void languageExtension(language).then((extension) => {
      if (!cancelled) view.current?.dispatch({ effects: compartments.current.language.reconfigure(extension) });
    });
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    applying.current = true;
    try {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    } finally {
      applying.current = false;
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: markLines.of(changed) });
  }, [changed]);

  return <div className="wb-code-editor" ref={host} data-testid="code-editor" />;
}
