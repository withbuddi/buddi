/**
 * The composer: what you type, what you drop on it, and the way out of a run
 * that is taking too long.
 *
 * One control, not three stacked ones. The border belongs to the whole box and
 * lights when the field inside has focus; the textarea, the paperclip and the
 * send button sit inside it. The keyboard hint only appears once you are
 * typing, so it never competes with the placeholder for the same line.
 *
 * A dropped file is uploaded immediately and shown as a chip in one of three
 * honest states — uploading, ready, failed. Nothing is sent with an attachment
 * that has not finished uploading, and a failure says so rather than sending a
 * message that quietly refers to nothing.
 */
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { chatApi, ApiError } from '../api';
import type { UploadedAttachment } from './types';

export interface PendingAttachment {
  key: string;
  filename: string;
  state: 'uploading' | 'ready' | 'failed';
  artifactId?: string;
  error?: string;
}

export function Composer({
  disabled,
  running,
  onSend,
  onStop,
  agentName,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (text: string, attachmentIds: string[]) => void;
  onStop: () => void;
  agentName: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const [focused, setFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const uploading = attachments.some((attachment) => attachment.state === 'uploading');
  const canSend = !disabled && !running && !uploading && text.trim() !== '';

  const take = (files: FileList | File[] | null): void => {
    for (const file of Array.from(files ?? [])) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((current) => [...current, { key, filename: file.name, state: 'uploading' }]);
      chatApi
        .attach(file)
        .then((uploaded: UploadedAttachment) =>
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.key === key
                ? { ...attachment, state: 'ready', artifactId: uploaded.artifactId }
                : attachment,
            ),
          ),
        )
        .catch((err: unknown) =>
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.key === key
                ? {
                    ...attachment,
                    state: 'failed',
                    error: err instanceof ApiError ? err.message : String(err),
                  }
                : attachment,
            ),
          ),
        );
    }
  };

  /** The field is as tall as what is in it, up to a point. */
  const resize = (): void => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  };

  const send = (): void => {
    if (!canSend) return;
    const ids = attachments
      .filter((attachment) => attachment.state === 'ready' && attachment.artifactId)
      .map((attachment) => attachment.artifactId as string);
    onSend(text.trim(), ids);
    setText('');
    setAttachments([]);
    window.requestAnimationFrame(resize);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter is a newline. The usual bargain.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDropping(false);
    take(event.dataTransfer?.files ?? null);
  };

  return (
    <div
      className="wb-composer"
      data-dropping={dropping}
      data-testid="composer"
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div className="wb-composer-box" data-focused={focused} data-disabled={disabled}>
        <label className="sr-only" htmlFor="wb-composer-input">
          Message {agentName}
        </label>
        <textarea
          id="wb-composer-input"
          ref={area}
          value={text}
          rows={1}
          placeholder={running ? `${agentName} is working…` : `Message ${agentName}`}
          onChange={(event) => {
            setText(event.target.value);
            resize();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />

        {attachments.length > 0 ? (
          <div className="wb-attachments">
            {attachments.map((attachment) => (
              <span
                key={attachment.key}
                className="wb-chip"
                data-pending={attachment.state === 'uploading'}
                data-failed={attachment.state === 'failed'}
                title={attachment.error}
              >
                {attachment.filename}
                {attachment.state === 'uploading' ? ' · uploading' : ''}
                {attachment.state === 'failed' ? ' · failed' : ''}
                <button
                  className="wb-chip-x"
                  aria-label={`Remove ${attachment.filename}`}
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item.key !== attachment.key))
                  }
                >
                  <CloseIcon />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="wb-composer-row">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            data-testid="file-input"
            onChange={(event) => {
              take(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            className="wb-icon-btn wb-icon-btn-sm"
            aria-label="Attach a file"
            onClick={() => fileInput.current?.click()}
            disabled={disabled}
          >
            <ClipIcon />
          </button>

          {/* The hint waits its turn: it appears only once the placeholder is
              gone, so the two never occupy the same line. */}
          <span className="wb-hint" data-shown={text !== '' || running}>
            {running ? `${agentName} is working` : 'Enter sends · Shift+Enter for a new line'}
          </span>

          {running ? (
            <button className="wb-btn" data-variant="stop" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              className="wb-btn wb-send"
              data-variant="accent"
              aria-label="Send"
              onClick={send}
              disabled={!canSend}
            >
              Send
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function ClipIcon(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true" {...stroke}>
      <path d="M13.2 8 8.4 12.8a3 3 0 0 1-4.2-4.2l5.1-5.1a2 2 0 1 1 2.8 2.8l-5 5" />
    </svg>
  );
}

function SendIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" {...stroke}>
      <path d="M2 7h9M7.4 3.4 11 7l-3.6 3.6" />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" {...stroke}>
      <path d="M3 3l5 5M8 3l-5 5" />
    </svg>
  );
}
