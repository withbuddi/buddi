/**
 * The composer: what you type, what you attach, and the way out of a run that
 * is taking too long.
 *
 * One control, not three stacked ones. The border belongs to the whole box and
 * lights when the field inside has focus; the files, the textarea, the
 * paperclip and the send button sit inside it. The keyboard hint only appears
 * once you are typing, so it never competes with the placeholder for the same
 * line.
 *
 * Files arrive three ways — the paperclip, a paste, a drop — and all three
 * land in the same row above the text, as tiles: an image as its own
 * thumbnail, anything else as a mark for its family with the name and size.
 * The drop target is the whole chat column, not this box; the page owns that
 * and hands the files in through `addFiles`, because a file let go two inches
 * above the composer should not open in a new tab.
 *
 * A file is uploaded the moment it arrives and its tile shows one of three
 * honest states — uploading, ready, failed. Nothing is sent with an attachment
 * that has not finished uploading, and a failure says so rather than sending
 * a message that quietly refers to nothing.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { chatApi, ApiError } from '../api';
import { FileTile } from './FileTile';
import type { AttachmentBlock } from './attachments';
import type { UploadedAttachment } from './types';

export interface PendingAttachment {
  key: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  /** The browser's own copy, for an image's thumbnail. Revoked when the tile goes. */
  thumbnail: string | null;
  state: 'uploading' | 'ready' | 'failed';
  uploaded?: UploadedAttachment;
  error?: string;
}

/**
 * A line put in the owner's mouth by something they clicked, and when.
 *
 * `at` is what makes it re-applicable: clicking the same button twice means the
 * same text twice, and a value-only prop would look unchanged the second time.
 * It is a *draft* and never a send — the owner still reads it, edits it and
 * presses the key. Nothing in this package may put words into a run on its own.
 */
export interface ComposerDraft {
  text: string;
  at: number;
}

/** What the page may do to the composer from outside: hand it files. */
export interface ComposerHandle {
  addFiles: (files: FileList | File[] | null) => void;
  focus: () => void;
}

export const Composer = forwardRef<ComposerHandle, {
  disabled: boolean;
  running: boolean;
  onSend: (text: string, attachments: UploadedAttachment[]) => void;
  onStop: () => void;
  agentName: string;
  draft?: ComposerDraft | null;
  /** The model this agent runs on, shown where the decision is made. */
  model?: string | null;
  /** Where the model is changed. The pill is a link when this is given. */
  setupHref?: string | null;
  /** A file in the tray was clicked. It is stored already, so it can be looked at. */
  onOpenFile?: (attachment: AttachmentBlock) => void;
  /** In a room: who can be addressed with `@`. Typing `@` offers them. */
  mentions?: Array<{ handle: string; name: string }>;
}>(function Composer({ disabled, running, onSend, onStop, agentName, draft, model, setupHref, onOpenFile, mentions }, ref) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [focused, setFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  /** The `@word` the caret is inside, when there is one and there are people to offer. */
  const [mentionAt, setMentionAt] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const offered = mentionAt && mentions
    ? mentions.filter((m) => m.handle.toLowerCase().startsWith(mentionAt.query.toLowerCase()) || m.name.toLowerCase().startsWith(mentionAt.query.toLowerCase())).slice(0, 6)
    : [];
  const trackMention = (value: string, caret: number): void => {
    if (!mentions || mentions.length === 0) { setMentionAt(null); return; }
    const before = value.slice(0, caret);
    const match = /(^|\s)@([\w-]*)$/.exec(before);
    if (!match) { setMentionAt(null); return; }
    setMentionAt({ start: caret - match[2]!.length - 1, query: match[2]! });
    setMentionIndex(0);
  };
  const completeMention = (handle: string): void => {
    if (!mentionAt) return;
    const node = area.current;
    const caret = node ? node.selectionStart : text.length;
    const next = `${text.slice(0, mentionAt.start)}@${handle} ${text.slice(caret)}`;
    setText(next);
    setMentionAt(null);
    window.requestAnimationFrame(() => {
      if (!node) return;
      const at = mentionAt.start + handle.length + 2;
      node.focus();
      node.setSelectionRange(at, at);
      resize();
    });
  };

  const uploading = attachments.some((attachment) => attachment.state === 'uploading');
  const canSend = !disabled && !running && !uploading && text.trim() !== '';

  const take = (files: FileList | File[] | null): void => {
    for (const file of Array.from(files ?? [])) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`;
      const thumbnail = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : null;
      setAttachments((current) => [
        ...current,
        { key, filename: file.name || 'Pasted image', mime: file.type || 'application/octet-stream', sizeBytes: file.size, thumbnail, state: 'uploading' },
      ]);
      chatApi
        .attach(file)
        .then((uploaded: UploadedAttachment) =>
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.key === key ? { ...attachment, state: 'ready', uploaded } : attachment,
            ),
          ),
        )
        .catch((err: unknown) =>
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.key === key
                ? { ...attachment, state: 'failed', error: err instanceof ApiError ? err.message : String(err) }
                : attachment,
            ),
          ),
        );
    }
  };

  const release = (attachment: PendingAttachment): void => {
    if (attachment.thumbnail && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(attachment.thumbnail);
  };

  /*
   * A file taken back out. It was stored the moment it landed, so the store
   * is told; a refusal (the same bytes already sent in some message) is fine
   * and needs no telling — the tray is what the owner asked to change.
   */
  const remove = (key: string): void => {
    const gone = attachments.find((attachment) => attachment.key === key);
    if (gone) {
      release(gone);
      if (gone.state === 'ready' && gone.uploaded) void chatApi.discardAttachment(gone.uploaded.artifactId).catch(() => undefined);
    }
    setAttachments((current) => current.filter((attachment) => attachment.key !== key));
  };

  useImperativeHandle(ref, () => ({
    addFiles: (files) => {
      take(files);
      area.current?.focus();
    },
    focus: () => area.current?.focus(),
  }));

  // Thumbnails are browser memory; let go of them with the component.
  const held = useRef(attachments);
  held.current = attachments;
  useEffect(() => () => held.current.forEach(release), []);

  /*
   * Something offered a sentence to start from. It replaces what is in the box
   * only when the box is empty — a half-typed message is the owner's, and no
   * button may take it.
   */
  const lastDraft = useRef<number>(0);
  useEffect(() => {
    if (!draft || draft.at === lastDraft.current) return;
    lastDraft.current = draft.at;
    setText((current) => (current.trim() === '' ? draft.text : current));
    const node = area.current;
    if (node) {
      node.focus();
      window.requestAnimationFrame(() => {
        node.style.height = 'auto';
        node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
        node.setSelectionRange(node.value.length, node.value.length);
      });
    }
  }, [draft]);

  /** The field is as tall as what is in it, up to a point. */
  const resize = (): void => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  };

  const send = (): void => {
    if (!canSend) return;
    const ready = attachments
      .filter((attachment) => attachment.state === 'ready' && attachment.uploaded)
      .map((attachment) => attachment.uploaded as UploadedAttachment);
    onSend(text.trim(), ready);
    attachments.forEach(release);
    setText('');
    setAttachments([]);
    window.requestAnimationFrame(resize);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // With people on offer, the keys pick one before they do anything else.
    if (mentionAt && offered.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex((i) => (i + 1) % offered.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex((i) => (i - 1 + offered.length) % offered.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); completeMention(offered[mentionIndex]!.handle); return; }
      if (event.key === 'Escape') { event.preventDefault(); setMentionAt(null); return; }
    }
    // Enter sends; Shift+Enter is a newline. The usual bargain.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  /*
   * A pasted screenshot is a file, and the commonest one. Text pastes are left
   * to the textarea: only a clipboard that carries files is taken here.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    take(files);
  };

  const failures = attachments.filter((attachment) => attachment.state === 'failed');
  const failed = failures.length;

  return (
    <div className="wb-composer" data-testid="composer">
      <div className="wb-composer-box" data-focused={focused} data-disabled={disabled}>
        {attachments.length > 0 ? (
          <div className="wb-composer-files" role="list" aria-label="Files to send">
            {attachments.map((attachment) => (
              <span role="listitem" key={attachment.key}>
                <FileTile
                  name={attachment.filename}
                  mime={attachment.mime}
                  sizeBytes={attachment.sizeBytes}
                  thumbnail={attachment.thumbnail}
                  state={attachment.state}
                  error={attachment.error}
                  onRemove={() => remove(attachment.key)}
                  {...(onOpenFile && attachment.state === 'ready' && attachment.uploaded
                    ? { onOpen: () => onOpenFile(asBlock(attachment.uploaded as UploadedAttachment)) }
                    : {})}
                  size="sm"
                />
              </span>
            ))}
          </div>
        ) : null}

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
            trackMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
            resize();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
        />

        {mentionAt && offered.length > 0 ? (
          <div className="wb-mentions" role="listbox" aria-label="Members">
            {offered.map((m, i) => (
              <button
                type="button"
                key={m.handle}
                role="option"
                aria-selected={i === mentionIndex}
                className="wb-mention"
                data-active={i === mentionIndex || undefined}
                onMouseDown={(event) => { event.preventDefault(); completeMention(m.handle); }}
              >
                <span className="wb-mention-handle">@{m.handle}</span>
                <span className="wb-mention-name">{m.name}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="wb-composer-row">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            onChange={(event) => {
              take(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            className="ui-icon-btn" data-size="sm"
            aria-label="Attach a file"
            title="Attach a file — or paste one, or drop it anywhere on the chat"
            onClick={() => fileInput.current?.click()}
            disabled={disabled}
          >
            <ClipIcon />
          </button>

          {model ? (
            setupHref ? (
              <a className="wb-composer-model" href={setupHref} title="The model this agent runs on. Click to change it.">
                <span className="wb-composer-model-dot" aria-hidden="true" />
                {model}
              </a>
            ) : (
              <span className="wb-composer-model" title="The model this agent runs on">
                <span className="wb-composer-model-dot" aria-hidden="true" />
                {model}
              </span>
            )
          ) : null}

          {/* The hint waits its turn: it appears only once the placeholder is
              gone, so the two never occupy the same line. A failed upload
              takes the line over. What the agent is doing is said in the
              thread, where the reply will land, not here. */}
          <span
            className="wb-hint"
            data-shown={(text !== '' && !running) || failed > 0}
            data-tone={failed > 0 ? 'critical' : undefined}
          >
            {failed > 0
              ? (failed === 1 && failures[0]?.error ? failures[0].error : `${failed} files failed to upload and will not be sent`)
              : 'Enter sends, Shift+Enter for a new line'}
          </span>

          {running ? (
            <button className="ui-btn" data-variant="stop" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              className="wb-send"
              aria-label="Send"
              title={uploading ? 'Waiting for the upload to finish' : 'Send'}
              onClick={send}
              disabled={!canSend}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function asBlock(uploaded: UploadedAttachment): AttachmentBlock {
  return { type: 'attachment', artifactId: uploaded.artifactId, filename: uploaded.filename, mime: uploaded.mime, kind: uploaded.kind, sizeBytes: uploaded.sizeBytes };
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

/** Up, not right: the message leaves the box and goes to the thread above. */
function SendIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.8}>
      <path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" />
    </svg>
  );
}
