/**
 * Talking to buddi on the dashboard: the recording, the speaker preference
 * and the one audio element replies play through.
 *
 * **The recording is WAV, built here.** Chrome's `MediaRecorder` writes WebM
 * and Safari's writes MP4/AAC; the speech plugin's local Whisper reads
 * OGG/Opus, MP3 and WAV. So the microphone is read as samples (Web Audio),
 * mixed to mono, brought down to 16 kHz and written as 16-bit PCM WAV: the
 * same file in every browser, one every listener reads, 32 kB a second (ten
 * minutes stays under the upload limit). The same samples drive the level.
 */

export const RECORDING_RATE = 16_000;
/** The local listener refuses clips over ten minutes; the upload limit is about the same. */
export const MAX_RECORDING_MS = 10 * 60_000;

export const MIC_DENIED = 'The microphone is blocked for this page: allow it in the browser’s site settings to talk.';
export const MIC_MISSING = 'This browser cannot record here: talking needs a microphone and a secure page (https or localhost).';

export interface Recording {
  /** Stop and hand back the WAV. */
  stop(): Promise<Blob>;
  /** Stop and drop it. */
  cancel(): void;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

/** Can this page record at all? */
export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && audioContextCtor() !== undefined;
}

/** Why the microphone could not be opened, in one sentence. */
export function micErrorSentence(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return MIC_DENIED;
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found on this computer.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app.';
  return MIC_MISSING;
}

/**
 * Open the microphone and start collecting samples. `onLevel` gets 0..1 a
 * few times a second. Rejects with the browser's error when it is refused.
 */
export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  const Ctor = audioContextCtor();
  if (!navigator.mediaDevices?.getUserMedia || !Ctor) throw Object.assign(new Error(MIC_MISSING), { name: 'Unsupported' });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new Ctor();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but is in every browser without a module file.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
    // Speech sits around 0.02–0.2 RMS; stretch it so the dot visibly moves.
    onLevel(Math.min(1, Math.sqrt(sum / input.length) * 6));
  };
  source.connect(processor);
  processor.connect(context.destination);
  if (context.state === 'suspended') await context.resume().catch(() => undefined);

  const close = (): void => {
    processor.onaudioprocess = null;
    try { source.disconnect(); processor.disconnect(); } catch { /* already gone */ }
    stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
  };
  return {
    async stop() {
      const rate = context.sampleRate;
      close();
      return wavBlob(downsample(concat(chunks), rate, RECORDING_RATE), RECORDING_RATE);
    },
    cancel: close,
  };
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Averaging each output sample's span: a box low-pass and a decimation in one. Plenty for speech. */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from <= to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Mono float samples as a 16-bit PCM WAV file. */
export function wavBlob(pcm: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/* ------------------------------------------------------------------ *
 * Read replies aloud: the preference and the player
 * ------------------------------------------------------------------ */

export const READ_ALOUD_KEY = 'buddi.readAloud';

export function readAloudPreference(): boolean {
  try {
    return window.localStorage.getItem(READ_ALOUD_KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveReadAloud(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(READ_ALOUD_KEY, 'on');
    else window.localStorage.removeItem(READ_ALOUD_KEY);
  } catch {
    // A browser that will not remember: the toggle holds for this page.
  }
}

let player: HTMLAudioElement | null = null;
let playing: string | null = null;
/** Each play gets a number; a fetch that finishes after a newer one started is dropped. */
let generation = 0;

/**
 * Which message the one audio element is speaking for, if a reply's own
 * Read aloud started it: its button shows stop while this names it.
 */
let playingKey: string | null = null;
const listeners = new Set<() => void>();

function setPlayingKey(key: string | null): void {
  if (playingKey === key) return;
  playingKey = key;
  listeners.forEach((listener) => listener());
}

export function playbackKey(): string | null {
  return playingKey;
}

export function subscribePlayback(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Stop whatever is playing and claim the element for `key` while its words
 * are being made into audio. The number it returns is stale once anything
 * else starts or stops, which is how a slow `say` knows it was cancelled.
 */
export function claimPlayback(key: string | null): number {
  stopPlayback();
  setPlayingKey(key);
  return generation;
}

export function playbackCurrent(claim: number): boolean {
  return claim === generation;
}

/** Stop whatever is playing. */
export function stopPlayback(): void {
  generation++;
  if (player) {
    player.pause();
    player.removeAttribute('src');
  }
  if (playing && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(playing);
  playing = null;
  setPlayingKey(null);
}

/**
 * Play a spoken reply through the page's one audio element, interrupting any
 * other. The bytes are fetched and played from memory, so the download
 * route's headers (and Safari's range requests) do not matter.
 */
export async function playAudio(url: string, mime: string, key: string | null = null): Promise<void> {
  const mine = claimPlayback(key);
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`The spoken reply could not be fetched (${res.status}).`);
    const blob = new Blob([await res.arrayBuffer()], { type: mime });
    if (mine !== generation) return;
    if (!player) {
      player = new Audio();
      // The element outlives every reply; whichever one it finishes, the button goes back to play.
      player.addEventListener?.('ended', () => setPlayingKey(null));
    }
    playing = URL.createObjectURL(blob);
    player.src = playing;
    await player.play();
  } catch (err) {
    if (mine === generation) setPlayingKey(null);
    throw err;
  }
}
