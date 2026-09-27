/**
 * Press to talk: the composer's microphone.
 *
 * Two ways, one button. Hold it (mouse or touch) and let go to stop; or click
 * it once to start and again to stop. Holding Shift when it stops sends the
 * words at once; otherwise they land in the box to be read and edited. While
 * it listens a small red dot swells with the voice.
 *
 * On stop the WAV is uploaded as a chat attachment (the same store every file
 * goes to) and `POST /api/speech/transcribe` hears it through the speech
 * plugin, as the owner. A refusal is the composer's usual inline notice.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ApiError, chatApi } from '../api';
import { Icon } from '../ui';
import { MAX_RECORDING_MS, micErrorSentence, startRecording, type Recording } from './voice';

export type MicState = 'idle' | 'starting' | 'recording' | 'transcribing';

/** A press shorter than this is a click: it starts, and the next click stops. */
export const HOLD_MS = 350;

export function MicButton({ disabled, conversationId, onText, onNotice }: {
  disabled: boolean;
  conversationId?: string | null;
  /** The words heard; `sendNow` when Shift was held at the stop. */
  onText: (text: string, sendNow: boolean) => void;
  /** One sentence for the composer's notice line, or null to clear it. */
  onNotice: (note: string | null) => void;
}) {
  const [state, setState] = useState<MicState>('idle');
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | null>(null);
  const pressedAt = useRef(0);
  /** 'hold' until the press turns out to be a click; then 'toggle'. */
  const mode = useRef<'hold' | 'toggle'>('hold');
  const pendingStop = useRef<boolean | null>(null);
  const limit = useRef<number | null>(null);
  // The recording outlives the render that started it: read the newest props at the stop.
  const latest = useRef({ onText, onNotice, conversationId });
  latest.current = { onText, onNotice, conversationId };

  useEffect(() => () => {
    recording.current?.cancel();
    if (limit.current !== null) window.clearTimeout(limit.current);
  }, []);

  const begin = async (): Promise<void> => {
    onNotice(null);
    setState('starting');
    pendingStop.current = null;
    try {
      recording.current = await startRecording((l) => setLevel(l));
    } catch (err) {
      setState('idle');
      onNotice(micErrorSentence(err));
      return;
    }
    setState('recording');
    limit.current = window.setTimeout(() => void finish(false), MAX_RECORDING_MS);
    // Let go before the microphone opened: stop now.
    if (pendingStop.current !== null) void finish(pendingStop.current);
  };

  const finish = async (sendNow: boolean): Promise<void> => {
    const current = recording.current;
    if (!current) { pendingStop.current = sendNow; return; }
    recording.current = null;
    if (limit.current !== null) { window.clearTimeout(limit.current); limit.current = null; }
    setLevel(0);
    setState('transcribing');
    try {
      const wav = await current.stop();
      if (wav.size <= 44) { latest.current.onNotice('Nothing was recorded.'); return; }
      const file = new File([wav], `recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`, { type: 'audio/wav' });
      const uploaded = await chatApi.attach(file);
      const conversation = latest.current.conversationId;
      const heard = await chatApi.transcribe({ artifactId: uploaded.artifactId, ...(conversation ? { conversationId: conversation } : {}) });
      latest.current.onText(heard.text, sendNow);
    } catch (err) {
      latest.current.onNotice(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      setState('idle');
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || event.button > 0) return;
    event.preventDefault();
    if (state === 'recording' || state === 'starting') {
      if (mode.current === 'toggle') void finish(event.shiftKey);
      return;
    }
    if (state !== 'idle') return;
    pressedAt.current = Date.now();
    mode.current = 'hold';
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* not every browser */ }
    void begin();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (mode.current !== 'hold' || (state !== 'recording' && state !== 'starting')) return;
    if (Date.now() - pressedAt.current < HOLD_MS) { mode.current = 'toggle'; return; }
    void finish(event.shiftKey);
  };

  /** The keyboard's click (no pointer): a toggle. */
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (event.detail !== 0 || disabled) return;
    if (state === 'idle') { mode.current = 'toggle'; void begin(); }
    else if (state === 'recording') void finish(event.shiftKey);
  };

  const listening = state === 'recording' || state === 'starting';
  return (
    <button
      type="button"
      className="ui-icon-btn wb-mic"
      data-size="sm"
      data-state={state}
      aria-label={listening ? 'Stop recording' : state === 'transcribing' ? 'Transcribing' : 'Talk'}
      aria-pressed={listening}
      title={
        listening
          ? 'Listening. Let go, or click, to stop; hold Shift to send at once'
          : state === 'transcribing'
            ? 'Turning what you said into text…'
            : 'Talk: hold to speak, or click to start and again to stop. Shift at the stop sends at once'
      }
      disabled={disabled || state === 'transcribing'}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      {listening ? (
        <span className="wb-mic-level" aria-hidden="true" style={{ transform: `scale(${(0.6 + level * 0.8).toFixed(2)})` }} />
      ) : (
        <Icon name="mic" />
      )}
    </button>
  );
}
