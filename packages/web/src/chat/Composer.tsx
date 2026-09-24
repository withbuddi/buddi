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
import { Icon } from '../ui';
import { FileTile } from './FileTile';
import type { AttachmentBlock } from './attachments';
import type { UploadedAttachment } from './types';

/**
 * The one thing that waits for the answer. A run's attachments are hydrated
 * when the request is built, so there is no honest way to add one to a call
 * already in flight; the server says the same sentence.
 */
export const FILES_DURING_RUN = 'Send files once the agent has answered.';

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
  /**
   * Whether this agent reasons before answering. `null` is the model's own
   * default, which is on — so the switch shows what will happen, not what the
   * file happens to say.
   */
  thinking?: 'on' | 'off' | null;
  /**
   * Switch it. Given only when there is one agent to switch: the setting
   * belongs to an agent file, and a room has several.
   */
  onThinking?: (next: 'on' | 'off') => void;
  /** A file in the tray was clicked. It is stored already, so it can be looked at. */
  onOpenFile?: (attachment: AttachmentBlock) => void;
  /** In a room: who can be addressed with `@`. Typing `@` offers them. */
  mentions?: Array<{ handle: string; name: string }>;
  /**
   * What the owner said in this conversation, newest first. Up walks back
   * through it, the way a shell does. The page reads it off the transcript it
   * already holds; the composer never asks for it.
   */
  history?: string[];
  /**
   * Which thread this box belongs to: the conversation id, or the agent id
   * while there is no conversation yet.
   *
   * A half-typed message is the owner's, and switching agents to check
   * something should not cost it. So the text is kept per thread in this
   * browser and comes back when that thread opens again — and a new chat,
   * being a different key, opens empty while the old draft stays where it was
   * typed. Only the text: an attachment is an upload, not a draft.
   */
  threadKey?: string | null;
}>(function Composer({ disabled, running, onSend, onStop, agentName, draft, model, setupHref, thinking, onThinking, onOpenFile, mentions, history, threadKey }, ref) {
  /*
   * Where this thread's draft is kept, and the function that reads it.
   *
   * Every read and every write is wrapped: a private window, blocked site
   * data and a browser that simply refuses all throw, and none of them may be
   * the reason somebody cannot type. The box is seeded from it while
   * rendering, so a restored draft is there the first time it is painted.
   */
  const storageKey = threadKey ? `buddi.draft.${threadKey}` : null;
  const readDraft = (key: string | null): string => {
    if (!key) return '';
    try {
      return window.localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  };

  const [text, setText] = useState(() => readDraft(storageKey));
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
    if (recalled < 0) remember(next);
    setMentionAt(null);
    window.requestAnimationFrame(() => {
      if (!node) return;
      const at = mentionAt.start + handle.length + 2;
      node.focus();
      node.setSelectionRange(at, at);
      resize();
    });
  };

  /*
   * Walking back through what the owner already said.
   *
   * `recalled` is how far back we are, -1 for "not recalling", and `stashed`
   * is what was in the box when the walk began, so coming forward past the
   * newest message gives the owner their own half-typed line back rather than
   * an empty field. The walk only starts from an empty box or from the entry
   * it put there itself: the moment the owner edits a recalled line it is
   * theirs, and Up goes back to moving the caret.
   */
  const past = history ?? [];
  const [recalled, setRecalled] = useState(-1);
  const stashed = useRef(text);

  /*
   * Opening another thread: this box belongs to that one now, so it shows what
   * was left there — nothing, most of the time.
   *
   * Read while rendering rather than in an effect, so that the box is right
   * the first time it is painted and a mount that restores nothing costs no
   * extra render at all. React re-runs this render with the new state before
   * committing anything, which is what makes a plain assignment here correct.
   */
  const loadedFor = useRef<string | null>(storageKey);
  if (loadedFor.current !== storageKey) {
    loadedFor.current = storageKey;
    const saved = readDraft(storageKey);
    stashed.current = saved;
    if (saved !== text) {
      setText(saved);
      setRecalled(-1);
      setMentionAt(null);
    }
  }

  /*
   * Keep this thread's draft, or forget it when there is nothing left to keep.
   *
   * What is kept is exactly `stashed` — the owner's own line, never a recalled
   * one — which is why Down and Escape hand back the text that is on disk.
   */
  const remember = (value: string): void => {
    stashed.current = value;
    if (!storageKey) return;
    try {
      if (value === '') window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, value);
    } catch {
      // A browser that will not remember is a browser that forgets. Typing works.
    }
  };

  /** Replace what is in the box and leave the caret at the end of it. */
  const put = (next: string): void => {
    setText(next);
    setMentionAt(null);
    const node = area.current;
    if (node) {
      node.value = next;
      node.setSelectionRange(next.length, next.length);
    }
    window.requestAnimationFrame(resize);
  };

  /** Up only recalls from the first line; otherwise it is a caret key. */
  const onFirstLine = (node: HTMLTextAreaElement): boolean =>
    !node.value.slice(0, node.selectionStart ?? node.value.length).includes('\n');

  /** The box holds nothing of the owner's own, so a recall costs them nothing. */
  const freeToRecall = (): boolean => text === '' || (recalled >= 0 && text === past[recalled]);

  const stopRecalling = (): void => {
    if (recalled < 0) return;
    setRecalled(-1);
    put(stashed.current);
  };

  const uploading = attachments.some((attachment) => attachment.state === 'uploading');
  /*
   * A file cannot join a run that has already been sent: its bytes are
   * hydrated and capped when the request is built. So the one thing the box
   * will not do mid-run is send a file, and it says so on the line where it
   * says everything else.
   */
  const holdingFiles = attachments.length > 0;
  const filesWait = running && holdingFiles;
  /*
   * The box always sends.
   *
   * While the agent works the message is not a second run: it goes to the run
   * that is going, which takes it between two tool calls. Refusing it was the
   * old bargain — type it, wait, type it again — and it cost the owner the
   * one minute in which saying "actually, in euros" is worth anything.
   */
  const canSend = !disabled && !uploading && !filesWait && text.trim() !== '';

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
    // An offered line the box accepted is now this thread's draft too.
    if (recalled < 0 && text.trim() === '') remember(draft.text);
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
    setRecalled(-1);
    // Sent is not drafted: the thread's draft is dropped, here and on disk.
    remember('');
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
    /*
     * The shell's bargain: Up walks back through what was said, Down comes
     * forward again, and past the newest the owner gets their draft back.
     * Every guard here is about giving the arrows back the moment they are
     * wanted for the caret instead.
     */
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const node = event.currentTarget;
      if (past.length > 0 && recalled + 1 < past.length && onFirstLine(node) && freeToRecall()) {
        event.preventDefault();
        if (recalled < 0) stashed.current = text;
        setRecalled(recalled + 1);
        put(past[recalled + 1]!);
        return;
      }
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (recalled >= 0 && text === past[recalled]) {
        event.preventDefault();
        if (recalled === 0) { stopRecalling(); return; }
        setRecalled(recalled - 1);
        put(past[recalled - 1]!);
        return;
      }
    }
    if (event.key === 'Escape' && recalled >= 0) {
      event.preventDefault();
      stopRecalling();
      return;
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
            // While walking back through what was said, what is in the box is
            // not the draft — the draft is what the walk stashed.
            if (recalled < 0) remember(event.target.value);
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
            <Icon name="clip" />
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

          {/*
            Thinking, switched where the owner talks rather than three clicks
            away on a settings page. It writes the agent file through the same
            endpoint the Agents page uses, so the two can never disagree.

            A run already under way was started with the old setting, and
            changing the file mid-flight would say something that is not true
            of the answer being written — so it waits, and says why.
          */}
          {onThinking ? (
            <button
              type="button"
              className="wb-composer-think"
              aria-pressed={thinkingOn(thinking)}
              disabled={disabled || running}
              title={
                running
                  ? `Wait for ${agentName} to finish — this run started with thinking ${thinkingOn(thinking) ? 'on' : 'off'}`
                  : thinkingOn(thinking)
                    ? 'Reasoning before the answer is on. Click to turn it off — answers come back faster.'
                    : 'Reasoning before the answer is off. Click to turn it on.'
              }
              onClick={() => onThinking(thinkingOn(thinking) ? 'off' : 'on')}
            >
              <span className="wb-composer-think-dot" aria-hidden="true" />
              Thinking
            </button>
          ) : null}

          {/* The hint waits its turn: it appears only once the placeholder is
              gone, so the two never occupy the same line. A failed upload
              takes the line over. What the agent is doing is said in the
              thread, where the reply will land, not here. */}
          <span
            className="wb-hint"
            data-shown={(text !== '' && !running) || failed > 0 || filesWait}
            data-tone={failed > 0 ? 'critical' : undefined}
          >
            {failed > 0
              ? (failed === 1 && failures[0]?.error ? failures[0].error : `${failed} files failed to upload and will not be sent`)
              : filesWait
                ? FILES_DURING_RUN
                : 'Enter sends, Shift+Enter for a new line'}
          </span>

          {/* Stop keeps its meaning — it ends the run — and the send button
              stays beside it, on the right where the primary action lives:
              what the owner types now joins the run rather than waiting for
              it. */}
          {running ? (
            <button className="ui-btn" data-variant="stop" onClick={onStop}>
              Stop
            </button>
          ) : null}
          <button
            className="wb-send"
            aria-label="Send"
            title={
              filesWait
                ? FILES_DURING_RUN
                : uploading
                  ? 'Waiting for the upload to finish'
                  : running
                    ? `Send — ${agentName} picks it up between steps`
                    : 'Send'
            }
            onClick={send}
            disabled={!canSend}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
});

/** Absent means the model's own default, and every model here thinks by default. */
function thinkingOn(thinking: 'on' | 'off' | null | undefined): boolean {
  return (thinking ?? 'on') === 'on';
}

function asBlock(uploaded: UploadedAttachment): AttachmentBlock {
  return { type: 'attachment', artifactId: uploaded.artifactId, filename: uploaded.filename, mime: uploaded.mime, kind: uploaded.kind, sizeBytes: uploaded.sizeBytes };
}

