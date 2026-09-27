/**
 * The quiet row under an agent's reply: Copy, and Read aloud.
 *
 * Copy puts the reply's words on the clipboard as plain text and says
 * "Copied" for a second. Read aloud speaks this one reply through the page's
 * one audio element and the same `say` route as the composer's toggle, so
 * starting one stops any other; while it speaks, the button is stop.
 *
 * Shown on hover and on focus within the message; always on a touch screen,
 * where there is no hover (styles.css, `.wb-reply-actions`).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../ui';
import { playbackKey, stopPlayback, subscribePlayback } from './voice';

export const COPIED_MS = 1000;

export function ReplyActions({
  messageId,
  text,
  onReadAloud,
}: {
  messageId: string;
  text: string;
  /** Absent: no Read aloud (a surface with no speech route). */
  onReadAloud?: ((messageId: string, text: string) => void) | undefined;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speaking = useSyncExternalStore(subscribePlayback, playbackKey) === messageId;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    }, () => undefined);
  };

  return (
    <div className="wb-reply-actions" data-testid="reply-actions">
      <button type="button" className="ui-icon-btn" data-size="sm" aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'} onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
      {copied ? <span className="wb-reply-copied" role="status">Copied</span> : null}
      {onReadAloud ? (
        <button
          type="button"
          className="ui-icon-btn"
          data-size="sm"
          aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'}
          title={speaking ? 'Stop reading aloud' : 'Read aloud'}
          aria-pressed={speaking}
          onClick={() => (speaking ? stopPlayback() : onReadAloud(messageId, text))}
        >
          <Icon name={speaking ? 'stop' : 'play'} size={14} />
        </button>
      ) : null}
    </div>
  );
}
