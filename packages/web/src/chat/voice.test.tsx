/**
 * Talking to buddi: the composer's microphone through its states, and the
 * speaker toggle. The microphone is a fake `getUserMedia` stream read by a
 * fake Web Audio graph; the server is a fake `fetch`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { resetVoiceNote, speakReply } from './ChatPage';
import { MIC_DENIED, READ_ALOUD_KEY, readAloudPreference, wavBlob, downsample } from './voice';

let processor: { onaudioprocess: ((event: unknown) => void) | null; connect: () => void; disconnect: () => void } | null = null;
const stopTrack = vi.fn();

class FakeAudioContext {
  sampleRate = 48_000;
  state = 'running';
  destination = {};
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
  createScriptProcessor() {
    processor = { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
    return processor;
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

function stubMicrophone(getUserMedia: () => Promise<unknown>): void {
  // jsdom has no PointerEvent: a mouse event carries the button and Shift the same way.
  if (typeof window.PointerEvent === 'undefined') vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId = 1; });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(getUserMedia) } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
}

function stubServer(text = 'what is my balance'): Array<{ url: string; body: unknown }> {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    if (url.endsWith('/api/chat/attachments')) {
      return new Response(JSON.stringify({ artifactId: 'a1b2c3d4-0000-4000-8000-000000000001', filename: 'r.wav', mime: 'audio/wav', kind: 'audio', sizeBytes: 100 }), { status: 200 });
    }
    if (url.endsWith('/api/speech/transcribe')) return new Response(JSON.stringify({ text }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
  return calls;
}

/** A quick press: a click. The panel replaces the button, so the release lands on the window. */
function click(button: HTMLElement, shiftKey = false): void {
  fireEvent.pointerDown(button, { button: 0, shiftKey });
  fireEvent.pointerUp(window, { button: 0, shiftKey });
}

async function openPanel(): Promise<HTMLElement> {
  processor = null;
  click(screen.getByRole('button', { name: 'Talk' }));
  await screen.findByText('Listening…');
  const confirm = screen.getByRole('button', { name: 'Stop and transcribe' });
  // The microphone is open once the audio graph is: from then on speak() is heard.
  await waitFor(() => expect(processor).not.toBeNull());
  return confirm;
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox') as HTMLTextAreaElement;

function speak(): void {
  act(() => processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } }));
}

beforeEach(() => {
  processor = null;
  stopTrack.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stream = { getTracks: () => [{ stop: stopTrack }] };

describe('the microphone', () => {
  it('opens the Listening panel on a click, with the waveform and ✓ focused', async () => {
    stubMicrophone(async () => stream);
    stubServer();
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    const confirm = await openPanel();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Talk' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard recording' })).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    const bars = () => [...screen.getByTestId('waveform').querySelectorAll<HTMLElement>('.wb-wave-bar')];
    expect(bars()).toHaveLength(60);
    speak();
    expect(bars().at(-1)!.style.getPropertyValue('--level')).toBe('0.600');
    expect(bars().at(0)!.style.getPropertyValue('--level')).toBe('0.000');
  });

  it('✓ uploads, transcribes and puts the words back in the box', async () => {
    stubMicrophone(async () => stream);
    const calls = stubServer();
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" conversationId="c0ffee00-0000-4000-8000-000000000001" />);
    const confirm = await openPanel();
    speak();
    fireEvent.click(confirm);
    await waitFor(() => expect(box().value).toBe('what is my balance'));
    expect(stopTrack).toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual(['/api/chat/attachments', '/api/speech/transcribe']);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ artifactId: 'a1b2c3d4-0000-4000-8000-000000000001', conversationId: 'c0ffee00-0000-4000-8000-000000000001' });
    expect(screen.queryByRole('group', { name: 'Recording' })).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('says Transcribing… until the words arrive', async () => {
    stubMicrophone(async () => stream);
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).endsWith('/api/chat/attachments')
      ? Promise.resolve(new Response(JSON.stringify({ artifactId: 'a1b2c3d4-0000-4000-8000-000000000001', filename: 'r.wav', mime: 'audio/wav', kind: 'audio', sizeBytes: 100 }), { status: 200 }))
      : new Promise<Response>((resolve) => { answer = resolve; })));
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    const confirm = await openPanel();
    speak();
    fireEvent.click(confirm);
    await screen.findByText('Transcribing…');
    await act(async () => answer(new Response(JSON.stringify({ text: 'hello' }), { status: 200 })));
    await waitFor(() => expect(box().value).toBe('hello'));
  });

  it('× discards without uploading and leaves the box as it was', async () => {
    stubMicrophone(async () => stream);
    const calls = stubServer();
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    fireEvent.change(box(), { target: { value: 'half typed' } });
    await openPanel();
    speak();
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    await waitFor(() => expect(box().value).toBe('half typed'));
    expect(stopTrack).toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(document.activeElement).toBe(box());
  });

  it('Enter is ✓ and Escape is ×', async () => {
    stubMicrophone(async () => stream);
    const calls = stubServer();
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    await openPanel();
    speak();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Recording' })).toBeNull());
    expect(calls).toEqual([]);

    await openPanel();
    speak();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(box().value).toBe('what is my balance'));
    expect(calls.map((c) => c.url)).toEqual(['/api/chat/attachments', '/api/speech/transcribe']);
  });

  it('sends at once when Shift is held at the ✓', async () => {
    stubMicrophone(async () => stream);
    stubServer('send the report');
    const onSend = vi.fn();
    render(<Composer disabled={false} running={false} onSend={onSend} onStop={() => {}} agentName="Ada" />);
    const confirm = await openPanel();
    speak();
    fireEvent.click(confirm, { shiftKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('send the report', []));
    expect(box().value).toBe('');
  });

  it('a hold stops and transcribes on release', async () => {
    stubMicrophone(async () => stream);
    const calls = stubServer();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Talk' }), { button: 0 });
      await screen.findByText('Listening…');
      await waitFor(() => expect(processor).not.toBeNull());
      speak();
      now.mockReturnValue(3_000);
      fireEvent.pointerUp(window, { button: 0 });
      await waitFor(() => expect(box().value).toBe('what is my balance'));
      expect(calls.map((c) => c.url)).toEqual(['/api/chat/attachments', '/api/speech/transcribe']);
    } finally {
      now.mockRestore();
    }
  });

  it('says in one sentence that the microphone is blocked', async () => {
    stubMicrophone(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    click(screen.getByRole('button', { name: 'Talk' }));
    await waitFor(() => expect(screen.getByText(MIC_DENIED)).toBeDefined());
    expect(screen.getByRole('button', { name: 'Talk' })).toBeDefined();
  });

  it("shows the plugin's refusal as the composer's notice", async () => {
    stubMicrophone(async () => stream);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/chat/attachments')
      ? new Response(JSON.stringify({ artifactId: 'a1b2c3d4-0000-4000-8000-000000000001', filename: 'r.wav', mime: 'audio/wav', kind: 'audio', sizeBytes: 100 }), { status: 200 })
      : new Response(JSON.stringify({ error: 'Talking to buddi needs the speech plugin, from Settings → Plugins.', reason: 'missing' }), { status: 409 })));
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    const confirm = await openPanel();
    speak();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Talking to buddi needs the speech plugin, from Settings → Plugins.')).toBeDefined());
  });
});

describe('the speaker toggle', () => {
  it('is off by default and is not drawn without a handler', () => {
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" />);
    expect(screen.queryByRole('button', { name: 'Read replies aloud' })).toBeNull();
    expect(readAloudPreference()).toBe(false);
  });

  it('switches and reports the new state', () => {
    const onReadAloud = vi.fn();
    const { rerender } = render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" readAloud={false} onReadAloud={onReadAloud} />);
    const toggle = screen.getByRole('button', { name: 'Read replies aloud' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(onReadAloud).toHaveBeenCalledWith(true);
    rerender(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Ada" readAloud onReadAloud={onReadAloud} />);
    expect(screen.getByRole('button', { name: 'Read replies aloud' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers the choice in this browser', () => {
    window.localStorage.setItem(READ_ALOUD_KEY, 'on');
    expect(readAloudPreference()).toBe(true);
  });
});

describe('speakReply', () => {
  it('says a not-english refusal once per page load', async () => {
    resetVoiceNote();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Replies are not read aloud: the voice on this computer speaks English only.', reason: 'not-english' }), { status: 409 })));
    expect(await speakReply('Bonjour.', 'c1')).toBe('Replies are not read aloud: the voice on this computer speaks English only.');
    expect(await speakReply('Bonjour.', 'c1')).toBeNull();
  });

  it('fetches the spoken file and plays it', async () => {
    resetVoiceNote();
    const play = vi.fn(async () => {});
    vi.stubGlobal('Audio', class { src = ''; play = play; pause() {} removeAttribute() {} });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/speech/say')
      ? new Response(JSON.stringify({ artifactId: 'x', audioUrl: '/api/artifacts/x/download', mime: 'audio/ogg' }), { status: 200 })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    expect(await speakReply('Hello.', 'c1')).toBeNull();
    expect(play).toHaveBeenCalled();
  });
});

describe('the WAV', () => {
  it('is 16-bit mono PCM at the rate given', async () => {
    const blob = wavBlob(downsample(new Float32Array(48_000).fill(0.5), 48_000, 16_000), 16_000);
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });
    const view = new DataView(buffer);
    expect(blob.type).toBe('audio/wav');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(16_000 * 2);
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff));
  });
});
