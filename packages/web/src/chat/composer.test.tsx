/**
 * The composer, and the three states an attachment can honestly be in.
 *
 * The one that matters is the middle one: while a file is still uploading the
 * message cannot be sent, because a message that refers to an artifact the
 * server does not have yet is a message the agent will answer wrongly.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerHandle } from './Composer';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The page owns the drop target and hands files in through the composer's
 * handle; here that handle is driven directly. jsdom has no DataTransfer
 * worth the name anyway.
 */
let handle: ComposerHandle | null = null;
function dropFile(file: File): void {
  handle?.addFiles([file]);
}

describe('the composer', () => {
  it('marks itself busy while it holds text, so the page is not reloaded under it', () => {
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    const root = screen.getByTestId('composer');
    expect(root.getAttribute('data-busy')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half a thought' } });
    expect(root.getAttribute('data-busy')).toBe('true');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
    expect(root.getAttribute('data-busy')).toBeNull();
  });

  it('uploads a dropped file and sends the message with its artifact id', async () => {
    const uploads: FormData[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        uploads.push(init?.body as FormData);
        return new Response(
          JSON.stringify({
            artifactId: 'art-7',
            filename: 'statement.pdf',
            mime: 'application/pdf',
            kind: 'document',
            sizeBytes: 1024,
          }),
          { status: 200 },
        );
      }),
    );

    const onSend = vi.fn();
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={onSend} onStop={() => {}} agentName="Ada" />);

    const file = new File(['%PDF-1.4'], 'statement.pdf', { type: 'application/pdf' });
    await act(async () => {
      dropFile(file);
    });

    // The chip appears with the file's own name…
    await waitFor(() => expect(screen.getByText(/statement\.pdf/)).toBeDefined());
    expect(uploads).toHaveLength(1);
    expect((uploads[0] as FormData).get('file')).toBeTruthy();

    // …and the message carries the id the upload returned.
    fireEvent.change(screen.getByLabelText(/Message Ada/), { target: { value: 'What is this?' } });
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
    });
    expect(onSend).toHaveBeenCalledWith('What is this?', [
      { artifactId: 'art-7', filename: 'statement.pdf', mime: 'application/pdf', kind: 'document', sizeBytes: 1024 },
    ]);
  });

  it('takes a pasted file the same way, and leaves pasted text to the field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ artifactId: 'art-9', filename: 'image.png', mime: 'image/png', kind: 'image', sizeBytes: 12 }),
        { status: 200 },
      )),
    );
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    const field = screen.getByLabelText(/Message Ada/);

    // Text alone: nothing is uploaded.
    fireEvent.paste(field, { clipboardData: { files: [] } });
    expect(fetch).not.toHaveBeenCalled();

    // A file on the clipboard — a screenshot — becomes a tile.
    await act(async () => {
      fireEvent.paste(field, { clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })] } });
    });
    await waitFor(() => expect(screen.getByText('image.png')).toBeDefined());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('draws an image as its own thumbnail, and a document as a mark with its size', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    // jsdom has no object URLs; the composer only needs the two functions.
    (URL as unknown as { createObjectURL: (file: File) => string }).createObjectURL = (file) => `blob:${file.name}`;
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    await act(async () => {
      dropFile(new File(['png'], 'photo.png', { type: 'image/png' }));
      dropFile(new File(['x'.repeat(2048)], 'rows.csv', { type: 'text/csv' }));
    });
    const img = document.querySelector('.wb-file[data-thumb="true"] img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('blob:photo.png');
    expect(screen.getByText('rows.csv')).toBeDefined();
    // The document tile has no picture, only the family mark.
    expect(document.querySelectorAll('.wb-file img')).toHaveLength(1);
  });

  it('removes a file from the tray, tells the store, and never sends it', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({ artifactId: 'art-1', filename: 'a.pdf', mime: 'application/pdf', kind: 'document', sizeBytes: 1 }),
          { status: 200 },
        );
      }),
    );
    const onSend = vi.fn();
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={onSend} onStop={() => {}} agentName="Ada" />);
    await act(async () => { dropFile(new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })); });
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeDefined());
    await act(async () => { screen.getByRole('button', { name: 'Remove a.pdf' }).click(); });
    expect(screen.queryByText('a.pdf')).toBeNull();
    // The upload was eager, so the removal reaches the store too.
    expect(calls.at(-1)).toEqual({ url: '/api/artifacts/art-1', method: 'DELETE' });
    fireEvent.change(screen.getByLabelText(/Message Ada/), { target: { value: 'hi' } });
    await act(async () => { screen.getByRole('button', { name: 'Send' }).click(); });
    expect(onSend).toHaveBeenCalledWith('hi', []);
  });

  it('sends files alone, with no words, by the button and by Enter; nothing at all stays unsendable', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return new Response(
          JSON.stringify({ artifactId: `art-${n}`, filename: `statement-${n}.csv`, mime: 'text/csv', kind: 'table', sizeBytes: 10 }),
          { status: 200 },
        );
      }),
    );
    const onSend = vi.fn();
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={onSend} onStop={() => {}} agentName="Ada" />);

    // An empty box with nothing in the tray has nothing to send.
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);

    await act(async () => {
      dropFile(new File(['a,b'], 'statement-1.csv', { type: 'text/csv' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false));
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
    });
    expect(onSend).toHaveBeenLastCalledWith('', [
      { artifactId: 'art-1', filename: 'statement-1.csv', mime: 'text/csv', kind: 'table', sizeBytes: 10 },
    ]);
    // The tray is empty again, so the button is too.
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);

    await act(async () => {
      dropFile(new File(['c,d'], 'statement-2.csv', { type: 'text/csv' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false));
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(/Message Ada/), { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('', [
      { artifactId: 'art-2', filename: 'statement-2.csv', mime: 'text/csv', kind: 'table', sizeBytes: 10 },
    ]);

    // Enter on an empty box with an empty tray sends nothing.
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(/Message Ada/), { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('will not send while a file is still uploading', async () => {
    let release: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => {
        release = resolve;
      })),
    );

    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    fireEvent.change(screen.getByLabelText(/Message Ada/), { target: { value: 'here' } });
    await act(async () => {
      dropFile(new File(['x'], 'slow.csv', { type: 'text/csv' }));
    });

    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Uploading/)).toBeDefined();

    await act(async () => {
      release?.(
        new Response(
          JSON.stringify({ artifactId: 'a1', filename: 'slow.csv', mime: 'text/csv', kind: 'table', sizeBytes: 1 }),
          { status: 200 },
        ),
      );
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false));
  });

  it('says a failed upload failed, instead of sending without it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'that file is too large' }), { status: 413 })),
    );
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    await act(async () => {
      dropFile(new File(['x'], 'huge.bin', { type: 'application/octet-stream' }));
    });
    // The tile says it failed; the line under the box says why.
    await waitFor(() => expect(screen.getByText('Upload failed')).toBeDefined());
    expect(screen.getByText('that file is too large')).toBeDefined();
  });

  it('opens a stored file from the tray, and not one still uploading', async () => {
    let release: ((value: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const onOpenFile = vi.fn();
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" onOpenFile={onOpenFile} />);
    await act(async () => { dropFile(new File(['x'], 'deck.pdf', { type: 'application/pdf' })); });
    expect(screen.queryByRole('button', { name: 'Open deck.pdf' })).toBeNull();
    await act(async () => {
      release?.(new Response(JSON.stringify({ artifactId: 'art-5', filename: 'deck.pdf', mime: 'application/pdf', kind: 'document', sizeBytes: 9 }), { status: 200 }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open deck.pdf' })).toBeDefined());
    screen.getByRole('button', { name: 'Open deck.pdf' }).click();
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'art-5', filename: 'deck.pdf' }));
  });

  it('offers a stop button while a run is in flight, and no send', () => {
    const onStop = vi.fn();
    render(<Composer ref={(h) => { handle = h; }} disabled={false} running onSend={() => {}} onStop={onStop} agentName="Ada" />);
    expect(screen.queryByText('Send')).toBeNull();
    screen.getByText('Stop').click();
    expect(onStop).toHaveBeenCalled();
  });
});

/**
 * Thinking, switched where the owner talks.
 *
 * The same setting the Agents page writes, through the same endpoint — so the
 * two surfaces cannot disagree — shown beside the model name because that is
 * the other half of "what this agent is about to do".
 */
describe('the thinking switch', () => {
  const draw = (props: Partial<{ thinking: 'on' | 'off' | null; running: boolean; onThinking: (next: 'on' | 'off') => void }>) =>
    render(
      <Composer
        disabled={false}
        running={props.running ?? false}
        onSend={() => {}}
        onStop={() => {}}
        agentName="Ada"
        model="a-model"
        thinking={props.thinking ?? null}
        onThinking={props.onThinking ?? (() => {})}
      />,
    );

  it('shows what the agent file says, and treats no answer as on', () => {
    draw({ thinking: 'off' });
    expect(screen.getByRole('button', { name: 'Thinking' }).getAttribute('aria-pressed')).toBe('false');
    cleanup();

    draw({ thinking: 'on' });
    expect(screen.getByRole('button', { name: 'Thinking' }).getAttribute('aria-pressed')).toBe('true');
    cleanup();

    // Absent in the file is the model's own default, and that is on. The
    // control says what will happen, not what the file happens to hold.
    draw({ thinking: null });
    expect(screen.getByRole('button', { name: 'Thinking' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('asks for the other state when clicked', () => {
    const onThinking = vi.fn();
    draw({ thinking: 'on', onThinking });
    screen.getByRole('button', { name: 'Thinking' }).click();
    expect(onThinking).toHaveBeenCalledWith('off');
    cleanup();

    onThinking.mockClear();
    draw({ thinking: 'off', onThinking });
    screen.getByRole('button', { name: 'Thinking' }).click();
    expect(onThinking).toHaveBeenCalledWith('on');
  });

  it('is disabled while the run is in flight, and says why', () => {
    const onThinking = vi.fn();
    draw({ thinking: 'on', running: true, onThinking });
    const toggle = screen.getByRole('button', { name: 'Thinking' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute('title')).toContain('wait for Ada to finish');
    toggle.click();
    expect(onThinking).not.toHaveBeenCalled();
  });

  it('is absent when there is nobody to switch it for — a room has several', () => {
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Money" model={null} />);
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull();
  });
});


/**
 * Up recalls what the owner already said, the way a shell does.
 *
 * The arrows belong to the caret first: a recall only happens from the first
 * line and only while the box holds nothing of the owner's own, so a long
 * message being edited never jumps out from under them.
 */
describe('the composer history', () => {
  const said = ['the newest thing', 'the one before'];
  const draw = (history?: string[]) =>
    render(
      <Composer
        disabled={false}
        running={false}
        onSend={() => {}}
        onStop={() => {}}
        agentName="Ada"
        {...(history ? { history } : {})}
      />,
    );

  const field = (): HTMLTextAreaElement => screen.getByLabelText(/Message Ada/) as HTMLTextAreaElement;

  it('walks back through the owner\'s messages and forward again to the draft', () => {
    draw(said);
    const box = field();

    // The draft the owner was in the middle of… except there isn't one yet.
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('the newest thing');
    // The caret waits at the end, where the next keystroke belongs.
    expect(box.selectionStart).toBe('the newest thing'.length);

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('the one before');

    // Nothing older than the oldest.
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('the one before');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.value).toBe('the newest thing');

    // Past the newest is the empty box the walk started from.
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.value).toBe('');
  });

  it('keeps the owner\'s own half-typed line — Up is a caret key then', () => {
    draw(said);
    const box = field();
    fireEvent.change(box, { target: { value: 'half a thought' } });

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    // A box with the owner's own words in it keeps them: Up is a caret key.
    expect(box.value).toBe('half a thought');
  });

  it('restores the draft on Escape', () => {
    draw(said);
    const box = field();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('the newest thing');

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
  });

  it('leaves the arrows alone when the caret is on a second line', () => {
    draw(said);
    const box = field();
    fireEvent.change(box, { target: { value: 'first\nsecond' } });
    box.setSelectionRange('first\nsecond'.length, 'first\nsecond'.length);

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('first\nsecond');
  });

  it('does nothing at all when nothing has been said yet', () => {
    draw([]);
    const box = field();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.value).toBe('');
  });
});

/**
 * The draft stays with its thread.
 *
 * A half-typed message is the owner's, and going to look something up in
 * another conversation must not cost it. It is kept per thread in this
 * browser, dropped the moment it is sent, and never followed by an
 * attachment — an upload already exists somewhere, and re-offering it later
 * would be offering a file the page no longer holds.
 */
describe('the composer draft', () => {
  const draw = (threadKey: string, onSend: (text: string) => void = () => {}) =>
    render(
      <Composer
        disabled={false}
        running={false}
        onSend={onSend}
        onStop={() => {}}
        agentName="Ada"
        threadKey={threadKey}
      />,
    );

  const field = (): HTMLTextAreaElement => screen.getByLabelText(/Message Ada/) as HTMLTextAreaElement;

  afterEach(() => {
    window.localStorage.clear();
  });

  it('survives leaving the thread and coming back, and the other thread is empty', () => {
    const first = draw('conversation-1');
    fireEvent.change(field(), { target: { value: 'half a question about the' } });
    first.unmount();

    // Another thread: its own draft, which is nothing.
    const second = draw('conversation-2');
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: 'something else entirely' } });
    second.unmount();

    draw('conversation-1');
    expect(field().value).toBe('half a question about the');
  });

  it('keeps nothing once the message is sent', () => {
    const sent: string[] = [];
    const view = draw('conversation-1', (text) => sent.push(text));
    fireEvent.change(field(), { target: { value: 'ship it' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sent).toEqual(['ship it']);
    expect(field().value).toBe('');
    view.unmount();

    draw('conversation-1');
    expect(field().value).toBe('');
  });

  /*
   * A new chat is a different thread, so it opens empty — and the draft the
   * owner left in the old one is still there when they go back to it.
   */
  it('starts a new chat empty and leaves the old draft where it was typed', () => {
    const before = draw('ada');
    fireEvent.change(field(), { target: { value: 'not finished yet' } });
    before.unmount();

    const fresh = draw('conversation-new');
    expect(field().value).toBe('');
    fresh.unmount();

    draw('ada');
    expect(field().value).toBe('not finished yet');
  });

  it('is the same value the arrow-key walk stashes, so Escape hands it back', () => {
    render(
      <Composer
        disabled={false}
        running={false}
        onSend={() => {}}
        onStop={() => {}}
        agentName="Ada"
        threadKey="conversation-1"
        history={['what I said before']}
      />,
    );
    const box = field();
    fireEvent.change(box, { target: { value: 'my own half line' } });
    // The walk needs an empty-of-its-own box, so clear it, walk, and come back.
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('what I said before');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    // What is on disk is the stash, never the recalled line.
    expect(window.localStorage.getItem('buddi.draft.conversation-1')).toBeNull();
  });

  it('still types when the browser refuses to remember anything', () => {
    const refuse = (): never => {
      throw new Error('storage is not available in this context');
    };
    const store = window.localStorage;
    const spies = (['getItem', 'setItem', 'removeItem'] as const).map((name) =>
      vi.spyOn(store, name).mockImplementation(refuse),
    );
    try {
      draw('conversation-1');
      const box = field();
      fireEvent.change(box, { target: { value: 'typed anyway' } });
      expect(box.value).toBe('typed anyway');
    } finally {
      // Only these three: another suite's mocks are not this test's to undo.
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('the tab snap', () => {
  it('attaches the frame the browser gave, like a dropped image', async () => {
    const snap = await import('./snap');
    vi.spyOn(snap, 'snapTab').mockResolvedValue(new File(['png'], 'Tab 2026-09-25 19.00.00.png', { type: 'image/png' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ artifactId: 'art-11', filename: 'Tab 2026-09-25 19.00.00.png', mime: 'image/png', kind: 'image', sizeBytes: 3 }),
        { status: 200 },
      )),
    );
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    await act(async () => { screen.getByRole('button', { name: 'Snap a tab' }).click(); });
    await waitFor(() => expect(screen.getByText(/Tab 2026-09-25/)).toBeDefined());
  });

  it('says so when the browser cannot capture', async () => {
    const snap = await import('./snap');
    vi.spyOn(snap, 'snapTab').mockRejectedValue(new Error(snap.SNAP_UNSUPPORTED));
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    await act(async () => { screen.getByRole('button', { name: 'Snap a tab' }).click(); });
    await waitFor(() => expect(screen.getByText(snap.SNAP_UNSUPPORTED)).toBeDefined());
  });
});

/**
 * Send at the end of a full row. Once "Use my Chrome" joined the model and
 * Thinking chips, the row outgrew a normal chat column and the box (overflow
 * hidden) clipped the round Send button off its right edge. jsdom cannot
 * measure, so the test carries the real stylesheet and checks what it can:
 * Send is there and shown, and the rules that keep it there hold.
 */
const styles = readFileSync(join(__dirname, '../styles.css'), 'utf8');

describe('the send button beside every chip', () => {
  it('stays in the row, shown, with the model, Thinking and Use my Chrome all present', () => {
    const style = document.createElement('style');
    style.textContent = styles;
    document.head.appendChild(style);
    try {
      render(
        <Composer
          disabled={false}
          running
          onSend={() => {}}
          onStop={() => {}}
          agentName="Ada"
          model="claude-sonnet-5-with-a-long-name"
          thinking="on"
          onThinking={() => {}}
          chrome={{ on: false, onChange: () => {} }}
          onReadAloud={() => {}}
        />,
      );
      expect(screen.getByRole('button', { name: 'Use my Chrome' })).toBeInTheDocument();
      const send = screen.getByRole('button', { name: 'Send' });
      expect(send).toBeVisible();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
      // Send is the row's last control.
      const row = send.parentElement as HTMLElement;
      expect(row.lastElementChild).toBe(send);
      expect(getComputedStyle(send).flexShrink).toBe('0');
    } finally {
      style.remove();
    }
  });

  it('keeps the shrink-first rules in the stylesheet', () => {
    const rule = (selector: string): string => {
      const at = styles.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return styles.slice(at, styles.indexOf('}', at));
    };
    expect(rule('.wb-composer-model, .wb-composer-think')).toMatch(/flex: 0 1 auto; min-width: 0; overflow: hidden/);
    expect(rule('.wb-composer-chip-label')).toMatch(/text-overflow: ellipsis/);
    expect(rule(".wb-composer-row > .wb-send, .wb-composer-row > .ui-btn[data-variant='stop']")).toMatch(/flex: 0 0 auto/);
    expect(styles).toMatch(/\.wb-composer-box \{ container-type: inline-size; \}/);
    expect(styles).toMatch(/@container \(max-width: \d+px\) \{\s*\.wb-composer-chip-lead \{ display: none; \}/);
    expect(styles).not.toMatch(/\.cv \.wb-composer-model \{[^}]*flex: 0 0 auto/);
    // The model gives way first and stops at 72px; nothing in the sheet hides it.
    expect(rule('.wb-composer-row > .wb-composer-model')).toMatch(/flex-shrink: 4; min-width: calc\(var\(--space-12\) \+ var\(--space-6\)\)/);
    expect(styles).not.toMatch(/\.cv \.wb-composer-model \{[^}]*min-width: 0/);
  });
});

/**
 * The row at three composer widths. jsdom has no container queries, so the
 * test does what the browser would: it takes the `@container (max-width: N)`
 * blocks that apply at a width, lays them over the base sheet, and asks
 * what is shown. 520: everything says its whole name. 420: "Use my Chrome"
 * says "Chrome", the model still says its whole name (cut short by the box
 * if it must). 360: the model says its short name. At every width the model
 * is there, Thinking is an icon, and Send is the last thing, never shrunk.
 */
function containerBlocks(sheet: string): Array<{ max: number; body: string; whole: string }> {
  const blocks: Array<{ max: number; body: string; whole: string }> = [];
  const head = /@container \(max-width: (\d+)px\) \{/g;
  let match: RegExpExecArray | null;
  while ((match = head.exec(sheet)) !== null) {
    let depth = 1;
    let at = head.lastIndex;
    while (depth > 0 && at < sheet.length) {
      if (sheet[at] === '{') depth += 1;
      if (sheet[at] === '}') depth -= 1;
      at += 1;
    }
    blocks.push({ max: Number(match[1]), body: sheet.slice(head.lastIndex, at - 1), whole: sheet.slice(match.index, at) });
  }
  return blocks;
}

describe('the composer row at 520, 420 and 360 px', () => {
  const blocks = containerBlocks(styles);
  const base = blocks.reduce((sheet, block) => sheet.replace(block.whole, ''), styles);

  const drawAt = (width: number): (() => void) => {
    const style = document.createElement('style');
    style.textContent = `${base}\n${blocks.filter((block) => width <= block.max).map((block) => block.body).join('\n')}`;
    document.head.appendChild(style);
    render(
      <div style={{ width }}>
        <Composer
          disabled={false}
          running={false}
          onSend={() => {}}
          onStop={() => {}}
          agentName="Ada"
          model="claude-sonnet-5"
          setupHref="/agents/ada/setup"
          thinking="off"
          onThinking={() => {}}
          chrome={{ on: false, onChange: () => {} }}
        />
      </div>,
    );
    return () => style.remove();
  };

  const common = (): void => {
    const model = screen.getByRole('link', { name: /claude-sonnet-5/ });
    expect(model).toBeVisible();
    const thinking = screen.getByRole('button', { name: 'Thinking' });
    expect(thinking).toHaveClass('ui-icon-btn');
    expect(thinking.title).toBe('Thinking: off');
    expect(thinking.getAttribute('aria-pressed')).toBe('false');
    expect(thinking.textContent).toBe('');
    expect(screen.getByRole('button', { name: /Chrome/ })).toBeVisible();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeVisible();
    expect((send.parentElement as HTMLElement).lastElementChild).toBe(send);
    expect(getComputedStyle(send).flexShrink).toBe('0');
    // No width hides the model.
    for (const block of blocks) expect(block.body).not.toMatch(/\.wb-composer-model(?![-\w])[^{]*\{[^}]*display: none/);
  };

  it('520: the whole model name and "Use my Chrome"', () => {
    const done = drawAt(520);
    try {
      common();
      expect(screen.getByText('claude-sonnet-5')).toBeVisible();
      expect(screen.getByText('sonnet-5')).not.toBeVisible();
      expect(screen.getByText('Use my')).toBeVisible();
    } finally { done(); }
  });

  it('420: "Chrome" alone; the model keeps its whole name', () => {
    const done = drawAt(420);
    try {
      common();
      expect(screen.getByText('claude-sonnet-5')).toBeVisible();
      expect(screen.getByText('sonnet-5')).not.toBeVisible();
      expect(screen.getByText('Use my')).not.toBeVisible();
    } finally { done(); }
  });

  it('360: the model says its short name', () => {
    const done = drawAt(360);
    try {
      common();
      expect(screen.getByText('claude-sonnet-5')).not.toBeVisible();
      expect(screen.getByText('sonnet-5')).toBeVisible();
      expect(screen.getByText('Use my')).not.toBeVisible();
    } finally { done(); }
  });

  it('shortens model names the way the chip needs', async () => {
    const { shortModelName } = await import('./Composer');
    expect(shortModelName('claude-sonnet-5')).toBe('sonnet-5');
    expect(shortModelName('anthropic/claude-opus-5-5-20260901')).toBe('opus-5-5');
    expect(shortModelName('gpt-5.1-codex')).toBe('gpt-5.1-codex');
    expect(shortModelName('ollama/llama3:8b')).toBe('llama3');
  });
});
