/**
 * Press to talk: the composer's microphone, and the Listening panel it opens.
 *
 * Two ways in, one button. Hold it (mouse or touch) and let go to stop; or
 * click it once. Either way the composer turns into a Listening panel: the
 * words "Listening…", a live waveform across the width, a round × that
 * throws the recording away and a round ✓ that stops and transcribes. Enter
 * is ✓ and Escape is ×, wherever the focus is while it listens. Holding
 * Shift at the ✓ sends the words at once; otherwise they land in the box to
 * be read and edited.
 *
 * On ✓ the WAV is uploaded as a chat attachment (the same store every file
 * goes to) and `POST /api/speech/transcribe` hears it through the speech
 * plugin, as the owner. A refusal is the composer's usual inline notice. On ×
 * nothing leaves the browser.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ApiError, chatApi } from '../api';
import { Icon } from '../ui';
import { MAX_RECORDING_MS, micErrorSentence, startRecording, type Recording } from './voice';

export type MicState = 'idle' | 'starting' | 'recording' | 'transcribing';

/** A press shorter than this is a click: it opens the panel and leaves it open. */
export const HOLD_MS = 350;

/** How many recent levels the waveform shows: about five seconds of voice. */
export const WAVE_SAMPLES = 60;

/** A stop asked for before the microphone opened, kept until it has. */
type Pending = { sendNow: boolean } | 'discard' | null;

export interface Voice {
  state: MicState;
  /** Held press on the microphone: a release after HOLD_MS is a ✓. */
  hold: () => void;
  /** A click or the keyboard: start and wait for ✓ or ×. */
  start: () => void;
  /** ✓: stop, upload, transcribe. */
  finish: (sendNow: boolean) => void;
  /** ×: stop and drop it. Nothing is uploaded. */
  discard: () => void;
  /** Where the levels go while it listens; the waveform plugs itself in. */
  levels: MutableRefObject<((level: number) => void) | null>;
}

export function useVoice({ conversationId, onText, onNotice }: {
  conversationId?: string | null;
  /** The words heard; `sendNow` when Shift was held at the ✓. */
  onText: (text: string, sendNow: boolean) => void;
  /** One sentence for the composer's notice line, or null to clear it. */
  onNotice: (note: string | null) => void;
}): Voice {
  const [state, setState] = useState<MicState>('idle');
  const current = useRef<MicState>('idle');
  const go = (next: MicState): void => { current.current = next; setState(next); };
  const recording = useRef<Recording | null>(null);
  const pending = useRef<Pending>(null);
  const limit = useRef<number | null>(null);
  const held = useRef<number | null>(null);
  const levels = useRef<((level: number) => void) | null>(null);
  // The recording outlives the render that started it: read the newest props at the stop.
  const latest = useRef({ onText, onNotice, conversationId });
  latest.current = { onText, onNotice, conversationId };

  const clearLimit = (): void => {
    if (limit.current !== null) { window.clearTimeout(limit.current); limit.current = null; }
  };

  const begin = async (): Promise<void> => {
    if (current.current !== 'idle') return;
    latest.current.onNotice(null);
    go('starting');
    pending.current = null;
    let opened: Recording;
    try {
      opened = await startRecording((level) => levels.current?.(level));
    } catch (err) {
      held.current = null;
      go('idle');
      latest.current.onNotice(micErrorSentence(err));
      return;
    }
    const asked = pending.current as Pending;
    pending.current = null;
    // Read afresh: a × may have come while the microphone was opening.
    const phase = current.current as MicState;
    if (asked === 'discard' || phase !== 'starting') { opened.cancel(); if (phase === 'starting') go('idle'); return; }
    recording.current = opened;
    go('recording');
    // Ten minutes is the listener's limit: reaching it is a ✓, not a loss.
    limit.current = window.setTimeout(() => void finish(false), MAX_RECORDING_MS);
    if (asked) void finish(asked.sendNow);
  };

  const finish = async (sendNow: boolean): Promise<void> => {
    held.current = null;
    const taken = recording.current;
    if (!taken) {
      if (current.current === 'starting') pending.current = { sendNow };
      return;
    }
    recording.current = null;
    clearLimit();
    go('transcribing');
    try {
      const wav = await taken.stop();
      if (wav.size <= 44) { latest.current.onNotice('Nothing was recorded.'); return; }
      const file = new File([wav], `recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`, { type: 'audio/wav' });
      const uploaded = await chatApi.attach(file);
      const conversation = latest.current.conversationId;
      const heard = await chatApi.transcribe({ artifactId: uploaded.artifactId, ...(conversation ? { conversationId: conversation } : {}) });
      latest.current.onText(heard.text, sendNow);
    } catch (err) {
      latest.current.onNotice(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      go('idle');
    }
  };

  const discard = (): void => {
    held.current = null;
    const taken = recording.current;
    if (!taken) {
      if (current.current === 'starting') pending.current = 'discard';
      return;
    }
    recording.current = null;
    clearLimit();
    taken.cancel();
    go('idle');
  };

  /*
   * The release of a hold. The microphone button is gone by then — the panel
   * took its place — so the release is heard on the window, wherever the
   * pointer ended up. A short press was a click: the panel stays open.
   */
  useEffect(() => {
    const onUp = (event: PointerEvent): void => {
      if (held.current === null) return;
      const since = Date.now() - held.current;
      held.current = null;
      if (since >= HOLD_MS) void finish(event.shiftKey);
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  // Enter is ✓ and Escape is ×, wherever the focus is, while it listens.
  const listening = state === 'starting' || state === 'recording';
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.repeat) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discard(); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void finish(event.shiftKey); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening]);

  useEffect(() => () => {
    recording.current?.cancel();
    clearLimit();
  }, []);

  return {
    state,
    hold: () => { held.current = Date.now(); void begin(); },
    start: () => { held.current = null; void begin(); },
    finish: (sendNow) => void finish(sendNow),
    discard,
    levels,
  };
}

/** The microphone in the composer's toolbar: it only opens the panel. */
export function MicButton({ disabled, voice }: { disabled: boolean; voice: Voice }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || event.button > 0 || voice.state !== 'idle') return;
    event.preventDefault();
    voice.hold();
  };
  /** The keyboard's click (no pointer). */
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (event.detail !== 0 || disabled || voice.state !== 'idle') return;
    voice.start();
  };
  return (
    <button
      type="button"
      className="ui-icon-btn wb-mic"
      data-size="sm"
      aria-label="Talk"
      title="Talk: click to start, or hold to speak and let go to stop"
      disabled={disabled}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Icon name="mic" />
    </button>
  );
}

/**
 * What the composer becomes while it listens: "Listening…", the waveform,
 * and × and ✓ on the right, where the send button was. After ✓ it says
 * "Transcribing…" until the words arrive.
 */
export function ListeningPanel({ voice }: { voice: Voice }) {
  const confirm = useRef<HTMLButtonElement>(null);
  const transcribing = voice.state === 'transcribing';
  useEffect(() => { confirm.current?.focus(); }, []);
  return (
    <div className="wb-listening" role="group" aria-label="Recording" data-phase={transcribing ? 'transcribing' : 'listening'}>
      <p className="wb-listening-label" aria-live="polite">
        {transcribing ? <><span className="wb-listening-spinner" aria-hidden="true" />Transcribing…</> : 'Listening…'}
      </p>
      <div className="wb-listening-row">
        <Waveform sink={voice.levels} frozen={transcribing} />
        <button
          type="button"
          className="wb-send"
          data-variant="quiet"
          aria-label="Discard recording"
          title="Discard (Escape)"
          disabled={transcribing}
          onClick={() => voice.discard()}
        >
          <Icon name="close" />
        </button>
        <button
          ref={confirm}
          type="button"
          className="wb-send"
          aria-label="Stop and transcribe"
          title="Stop and transcribe (Enter); Shift sends at once"
          disabled={transcribing}
          onClick={(event) => voice.finish(event.shiftKey)}
        >
          <Icon name="check" />
        </button>
      </div>
    </div>
  );
}

/** The last WAVE_SAMPLES levels as thin bars, newest on the right; silence is a dot. */
function Waveform({ sink, frozen }: { sink: MutableRefObject<((level: number) => void) | null>; frozen: boolean }) {
  const [levels, setLevels] = useState<number[]>(() => Array<number>(WAVE_SAMPLES).fill(0));
  useEffect(() => {
    if (frozen) return;
    sink.current = (level) => setLevels((prev) => [...prev.slice(1), level]);
    return () => { sink.current = null; };
  }, [frozen]);
  return (
    <div className="wb-wave" aria-hidden="true" data-testid="waveform">
      {levels.map((level, i) => (
        <span key={i} className="wb-wave-bar" style={{ '--level': level.toFixed(3) } as CSSProperties} />
      ))}
    </div>
  );
}
