/**
 * The composer, and the three states an attachment can honestly be in.
 *
 * The one that matters is the middle one: while a file is still uploading the
 * message cannot be sent, because a message that refers to an artifact the
 * server does not have yet is a message the agent will answer wrongly.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dropFile(file: File): void {
  const zone = screen.getByTestId('composer');
  // jsdom has no DataTransfer worth the name; the shape the handler reads is
  // all that is needed, and all that is asserted.
  fireEvent.drop(zone, { dataTransfer: { files: [file] } });
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
    render(<Composer disabled={false} running={false} onSend={onSend} onStop={() => {}} agentName="Ada" />);

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
      screen.getByText('Send').click();
    });
    expect(onSend).toHaveBeenCalledWith('What is this?', ['art-7']);
  });

  it('will not send while a file is still uploading', async () => {
    let release: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => {
        release = resolve;
      })),
    );

    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    fireEvent.change(screen.getByLabelText(/Message Ada/), { target: { value: 'here' } });
    await act(async () => {
      dropFile(new File(['x'], 'slow.csv', { type: 'text/csv' }));
    });

    expect(screen.getByText('Send').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/uploading/)).toBeDefined();

    await act(async () => {
      release?.(
        new Response(
          JSON.stringify({ artifactId: 'a1', filename: 'slow.csv', mime: 'text/csv', kind: 'table', sizeBytes: 1 }),
          { status: 200 },
        ),
      );
    });
    await waitFor(() => expect(screen.getByText('Send').hasAttribute('disabled')).toBe(false));
  });

  it('says a failed upload failed, instead of sending without it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'that file is too large' }), { status: 413 })),
    );
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    await act(async () => {
      dropFile(new File(['x'], 'huge.bin', { type: 'application/octet-stream' }));
    });
    await waitFor(() => expect(screen.getByText(/failed/)).toBeDefined());
  });

  it('offers a stop button while a run is in flight, and no send', () => {
    const onStop = vi.fn();
    render(<Composer disabled={false} running onSend={() => {}} onStop={onStop} agentName="Ada" />);
    expect(screen.queryByText('Send')).toBeNull();
    screen.getByText('Stop').click();
    expect(onStop).toHaveBeenCalled();
  });
});
