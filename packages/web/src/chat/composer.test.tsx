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
