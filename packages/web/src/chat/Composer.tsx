/**
 * The composer: what you type, what you drop on it, and the way out of a run
 * that is taking too long.
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
  const fileInput = useRef<HTMLInputElement>(null);

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

  const send = (): void => {
    if (!canSend) return;
    const ids = attachments
      .filter((attachment) => attachment.state === 'ready' && attachment.artifactId)
      .map((attachment) => attachment.artifactId as string);
    onSend(text.trim(), ids);
    setText('');
    setAttachments([]);
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
      <label className="sr-only" htmlFor="wb-composer-input">
        Message {agentName}
      </label>
      <textarea
        id="wb-composer-input"
        value={text}
        placeholder={running ? `${agentName} is working…` : `Message ${agentName}`}
        onChange={(event) => setText(event.target.value)}
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
                aria-label={`Remove ${attachment.filename}`}
                onClick={() =>
                  setAttachments((current) => current.filter((item) => item.key !== attachment.key))
                }
              >
                ×
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
        <button className="wb-btn" onClick={() => fileInput.current?.click()} disabled={disabled}>
          Attach
        </button>
        <span className="wb-hint">{running ? 'Running' : 'Enter sends · Shift+Enter for a new line'}</span>
        {running ? (
          <button className="wb-btn" data-variant="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="wb-btn" data-variant="accent" onClick={send} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
