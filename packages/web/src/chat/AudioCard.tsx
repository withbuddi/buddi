/**
 * An audio file, as a small player: play or pause, where it is and how long
 * it runs, the file's name, and a download link.
 *
 * The bytes are fetched once, on the first play, and played from memory: the
 * download route answers no range requests, which Safari needs to stream an
 * `<audio src>`. Starting a file stops a reply being read aloud.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';
import { downloadUrl, formatBytes } from './attachments';
import { stopPlayback } from './voice';

/** The audio kinds drawn as a player; anything else stays a tile. */
export const PLAYABLE_AUDIO = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm']);

export function isPlayableAudio(mime: string): boolean {
  return PLAYABLE_AUDIO.has(mime.toLowerCase().split(';')[0]!.trim());
}

/** 83 → "1:23". Unknown → "–:––". */
export function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '–:––';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The player's state and its one action, for any face drawn over it (this
 * card, the edition card's waveform). `bind` goes on the `<audio>` element.
 */
export function useAudioPlayer(artifactId: string, mime: string) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => () => {
    audio.current?.pause();
    if (objectUrl.current && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl.current);
  }, []);

  const toggle = async (): Promise<void> => {
    const element = audio.current;
    if (!element) return;
    if (playing) {
      element.pause();
      return;
    }
    stopPlayback();
    setFailed(false);
    try {
      if (!objectUrl.current) {
        setLoading(true);
        const res = await fetch(downloadUrl(artifactId), { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        objectUrl.current = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: mime }));
        element.src = objectUrl.current;
      }
      await element.play();
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const bind = {
    ref: audio,
    preload: 'none' as const,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => { setPlaying(false); setPosition(0); },
    onTimeUpdate: (event: { currentTarget: HTMLAudioElement }) => setPosition(event.currentTarget.currentTime),
    onLoadedMetadata: (event: { currentTarget: HTMLAudioElement }) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null),
    onDurationChange: (event: { currentTarget: HTMLAudioElement }) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null),
  };
  return { playing, loading, failed, position, duration, toggle, bind };
}

export function AudioCard({
  artifactId,
  name,
  mime,
  sizeBytes,
}: {
  artifactId: string;
  name: string;
  mime: string;
  sizeBytes?: number | null;
}): JSX.Element {
  const { playing, loading, failed, position, duration, toggle, bind } = useAudioPlayer(artifactId, mime);
  const meta = failed ? 'Could not play. Download it instead.' : `${clock(position)} / ${clock(duration)}`;
  return (
    <span className="wb-audio" data-testid="audio-card" data-playing={playing ? 'true' : undefined}>
      <button
        type="button"
        className="ui-icon-btn wb-audio-play"
        data-size="sm"
        aria-label={playing ? `Pause ${name}` : `Play ${name}`}
        disabled={loading}
        onClick={() => void toggle()}
      >
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <span className="wb-file-text">
        <span className="wb-file-name" title={name}>{name}</span>
        <span className="wb-file-meta" data-testid="audio-time">
          {loading ? 'Loading…' : meta}
          {!failed && formatBytes(sizeBytes) ? ` · ${formatBytes(sizeBytes)}` : ''}
        </span>
      </span>
      <a className="ui-icon-btn wb-audio-download" data-size="sm" href={downloadUrl(artifactId)} download={name} aria-label={`Download ${name}`} title="Download">
        <Icon name="download" size={14} />
      </a>
      <audio {...bind} />
    </span>
  );
}
