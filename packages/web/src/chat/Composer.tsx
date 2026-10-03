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
 * Files arrive four ways — the paperclip, a paste, a drop, a tab snap — and all four
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
 *
 * Composer v2 (docs/dashboard.md, The composer): the textarea stays the thing
 * typed into, with its text transparent, and a paint layer in the same grid
 * cell draws the same characters with live Markdown styling (ComposerPaint).
 * What is sent is the plain Markdown. `@` opens the mention popup (Agent
 * Father and the team in a one-to-one chat, the members in a room), `/` at the
 * start of the message opens the commands, lists carry on with Enter and
 * indent with Tab, pasted code is fenced (Undo), and a paste over 4,000
 * characters becomes a file at once (Put it in the message).
 */
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { chatApi, ApiError } from '../api';
import { Button, Icon } from '../ui';
import { accentAttrs, accentOf } from '../shell/accent';
import { ROLE_MAKER } from '../shell/roster';
import { useMediaQuery } from '../useMediaQuery';
import { FileTile } from './FileTile';
import type { AttachmentBlock } from './attachments';
import { chatCommands, isChatCommand, needsWords, pluginRows, usePluginCommands, type ChatCommandName, type CommandRow } from './commands';
import {
  LONG_PASTE,
  completeMention,
  continueList,
  fencePaste,
  guessLang,
  inFence,
  indentItem,
  langName,
  leadingMention,
  listItem,
  looksLikeCode,
  mentionAt,
  mentionedHandles,
  parseCommand,
  slashAt,
  useAt,
  type Edit,
} from './composer-text';
import { ZWSP, paint } from './ComposerPaint';
import { CommandMenu, MentionPopup, optionId, type Mentionable } from './ComposerPopups';
import { ListeningPanel, MicButton, useVoice } from './MicButton';
import { snapTab } from './snap';
import type { ChatAgent, UploadedAttachment } from './types';

/**
 * The one thing that waits for the answer. A run's attachments are hydrated
 * when the request is built, so there is no honest way to add one to a call
 * already in flight; the server says the same sentence.
 */
export const FILES_DURING_RUN = 'Send files once the agent has answered.';

/**
 * The id of the one composer field on a page. The shell's `/` looks for it
 * (shell/slash.ts): a page has at most one composer, so an id is enough.
 */
export const COMPOSER_INPUT_ID = 'wb-composer-input';

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
  /** The tile's second line instead of family and size: a long paste says how many lines. */
  detail?: string;
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

/** Who `@` offers in a one-to-one chat: the roster, and which agent the box talks to. */
export interface ComposerTeam {
  agents: readonly ChatAgent[];
  selfId: string;
}

/** What the last paste did, with its way out. */
type PasteNote =
  | { kind: 'fenced'; lang: string; block: string; text: string }
  | { kind: 'long'; key: string; text: string; caret: number };

/** The phone width the kit draws the composer's popups for: finger-tall rows, no key hints. */
const PHONE_QUERY = '(max-width: 720px)';
/** The popups' own list heights (kit.css): six rows on a desk, five on a phone. */
const LIST_MAX = { desk: 288, phone: 240 };

/**
 * How tall a popup may be: the room between the top of what is visible and the
 * box. On a phone the visible part is what the keyboard leaves
 * (`visualViewport`), so the popup stays above the keyboard and never runs off
 * the top of the screen.
 */
function usePopupRoom(anchor: RefObject<HTMLElement>, open: boolean, phone: boolean): number | undefined {
  const [room, setRoom] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!open) return undefined;
    const view = window.visualViewport ?? null;
    const measure = (): void => {
      const box = anchor.current;
      if (!box || typeof box.getBoundingClientRect !== 'function') return;
      const top = box.getBoundingClientRect().top - (view ? view.offsetTop : 0);
      // The foot (key hints) and the gap take about 56px on a desk; a phone has no foot.
      const free = Math.floor(top - (phone ? 16 : 64));
      const max = phone ? LIST_MAX.phone : LIST_MAX.desk;
      setRoom(free > 0 && free < max ? Math.max(free, 96) : undefined);
    };
    measure();
    view?.addEventListener('resize', measure);
    view?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      view?.removeEventListener('resize', measure);
      view?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [open, phone, anchor]);
  return room;
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
  mentions?: Array<{ handle: string; name: string; id?: string }>;
  /**
   * In a one-to-one chat: the roster, so `@` offers Agent Father (borrowed for
   * one message) and every teammate (the agent asks them). Ignored in a room.
   */
  team?: ComposerTeam | null;
  /**
   * The chat's own commands, run by the page: `/use <handle>`, `/new [words]`,
   * `/stop`, `/quiet [1d|1w|off]`. Given, `/` at the start of the message
   * opens the menu, with the plugins' commands under them.
   */
  onCommand?: (name: ChatCommandName, arg: string) => void;
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
  /** The conversation a recording is heard in, so the plugin counts it there. */
  conversationId?: string | null;
  /**
   * Read replies aloud (docs/dashboard.md, Talking to buddi). The page owns
   * the preference and the playing; the switch sits here, with the others.
   */
  readAloud?: boolean;
  onReadAloud?: (on: boolean) => void;
  /** What the empty box says, when the page wants other words than "Message <agent>". */
  placeholder?: string;
  /** One line that grows as it is typed into, the controls on its right (Home's box). */
  slim?: boolean;
}>(function Composer({ disabled, running, onSend, onStop, agentName, draft, model, setupHref, thinking, onThinking, onOpenFile, mentions, team, onCommand, history, threadKey, conversationId, readAloud, onReadAloud, placeholder, slim }, ref) {
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
  const [caret, setCaret] = useState(() => text.length);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [snapping, setSnapping] = useState(false);
  /** Why the last tab snap or recording gave nothing, in the browser's words made plain. */
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [note, setNote] = useState<PasteNote | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const listId = `cv-pop-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const pluginCommands = usePluginCommands();

  /*
   * Who `@` can name, and what naming them does. In a room, the members: the
   * room asks them. In a one-to-one chat, Agent Father first — borrowed for
   * this one message — then every teammate, whom the agent here asks.
   */
  const people = useMemo<Mentionable[]>(() => {
    const face = (id: string): ChatAgent | undefined => team?.agents.find((a) => a.id === id);
    const accent = (agent: ChatAgent | undefined, id: string) => accentAttrs(accentOf(agent ?? { id }));
    if (mentions) {
      return mentions.map((m) => {
        const id = m.id ?? m.handle;
        const agent = face(id);
        return { id, handle: m.handle, name: m.name, effect: `Asks @${m.handle} in this room`, group: 'In this room', accent: accent(agent, id), ...(agent ? { face: agent } : {}) };
      });
    }
    if (!team) return [];
    const maker = team.agents.find((a) => a.roles.includes(ROLE_MAKER) && a.id !== team.selfId);
    const rest = team.agents.filter((a) => a.id !== team.selfId && a !== maker);
    return [
      ...(maker ? [{ id: maker.id, handle: maker.handle, name: maker.name, effect: `Borrows ${maker.name} for this message`, group: 'Borrow', accent: accentAttrs({ key: 'buddi' }), face: maker }] : []),
      ...rest.map((a) => ({ id: a.id, handle: a.handle, name: a.name, effect: `${agentName} asks @${a.handle}`, group: 'Ask a teammate', accent: accent(a, a.id), face: a })),
    ];
  }, [mentions, team, agentName]);
  const makerHandle = !mentions && team ? team.agents.find((a) => a.roles.includes(ROLE_MAKER) && a.id !== team.selfId)?.handle ?? null : null;

  /** Closed by Escape until the text changes again. */
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState(0);

  // What the caret is in decides the popup and the hint.
  const commandsOn = Boolean(onCommand);
  const useMode = commandsOn && useAt(text, caret);
  const mention = !closed && people.length > 0 ? mentionAt(text, caret) : null;
  const slash = !closed && commandsOn && !mention ? slashAt(text, caret) : null;
  const mentionItems: Mentionable[] = mention
    ? people
      .filter((m) => !useMode || m.group !== 'Borrow')
      .filter((m) => m.handle.toLowerCase().startsWith(mention.query.toLowerCase()) || m.name.toLowerCase().startsWith(mention.query.toLowerCase()))
      .map((m) => (useMode ? { ...m, group: 'Talk to', effect: `Talk to ${m.name} from here on` } : m))
      .slice(0, 8)
    : [];
  const allCommands: CommandRow[] = useMemo(() => [...chatCommands(agentName, running), ...pluginRows(pluginCommands)], [agentName, running, pluginCommands]);
  const commandItems = slash ? allCommands.filter((c) => c.name.startsWith(slash.query.toLowerCase())) : [];
  const popup: 'mention' | 'slash' | null = mention && mentionItems.length > 0 ? 'mention' : slash ? 'slash' : null;
  const items: ReadonlyArray<Mentionable | CommandRow> = popup === 'mention' ? mentionItems : popup === 'slash' ? commandItems : [];
  const activeIndex = items.length > 0 ? Math.min(active, items.length - 1) : -1;
  const room = usePopupRoom(box, popup !== null, phone);

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
      setCaret(saved.length);
      setRecalled(-1);
      setNote(null);
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

  /** Put an edit in the box: the text, the caret, the draft, and the popups opened afresh. */
  const apply = (edit: Edit): void => {
    setText(edit.value);
    setCaret(edit.caret);
    setClosed(false);
    setActive(0);
    if (recalled < 0) remember(edit.value);
    const node = area.current;
    if (node) {
      node.value = edit.value;
      node.setSelectionRange(edit.caret, edit.caret);
      window.requestAnimationFrame(() => {
        node.focus();
        node.setSelectionRange(edit.caret, edit.caret);
      });
    }
  };

  /** Replace what is in the box and leave the caret at the end of it. */
  const put = (next: string): void => {
    setText(next);
    setCaret(next.length);
    setClosed(false);
    const node = area.current;
    if (node) {
      node.value = next;
      node.setSelectionRange(next.length, next.length);
    }
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

  /** Upload files as they arrive; answers each one's tray key. */
  const take = (files: FileList | File[] | null): string[] => {
    const keys: string[] = [];
    for (const file of Array.from(files ?? [])) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`;
      keys.push(key);
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
    return keys;
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
    if (note?.kind === 'long' && note.key === key) setNote(null);
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
    const taken = text.trim() === '';
    setText((current) => (current.trim() === '' ? draft.text : current));
    // An offered line the box accepted is now this thread's draft too.
    if (recalled < 0 && taken) remember(draft.text);
    const node = area.current;
    if (node) {
      node.focus();
      window.requestAnimationFrame(() => {
        node.setSelectionRange(node.value.length, node.value.length);
        setCaret(node.value.length);
      });
    }
  }, [draft]);

  const clearAfterSend = (): void => {
    setRecalled(-1);
    // Sent is not drafted: the thread's draft is dropped, here and on disk.
    remember('');
    setText('');
    setCaret(0);
    setNote(null);
    setClosed(false);
  };

  /** One of the chat's own commands, typed whole or picked: the page runs it and the box empties. */
  const runChatCommand = (name: ChatCommandName, arg: string): void => {
    if (!onCommand) return;
    if (name === 'stop' && !running) { clearAfterSend(); return; }
    clearAfterSend();
    onCommand(name, arg);
  };

  const send = (spoken?: string): void => {
    const outgoing = (spoken ?? text).trim();
    if (spoken === undefined ? !canSend : disabled || uploading || filesWait || outgoing === '') return;
    // `/quiet 1d`, typed whole: the page runs it, nothing is sent to the agent.
    const command = spoken === undefined && onCommand ? parseCommand(outgoing) : null;
    if (command && isChatCommand(command.name) && attachments.length === 0) {
      if (command.name === 'use' && command.arg === '') { apply({ value: '/use @', caret: 6 }); return; }
      runChatCommand(command.name, command.arg.replace(/^@/, ''));
      return;
    }
    const ready = attachments
      .filter((attachment) => attachment.state === 'ready' && attachment.uploaded)
      .map((attachment) => attachment.uploaded as UploadedAttachment);
    onSend(outgoing, ready);
    attachments.forEach(release);
    clearAfterSend();
    setAttachments([]);
  };

  const pickMention = (item: Mentionable): void => {
    if (!mention) return;
    if (useMode && onCommand) { runChatCommand('use', item.handle); return; }
    apply(completeMention(text, caret, mention.start, item.handle));
  };

  /** A command picked: run it, or — when it needs words, or Tab asked for them — put it in the box to finish. */
  const pickCommand = (row: CommandRow, forWords: boolean): void => {
    if (row.off) return;
    const rest = text.slice(caret);
    if (forWords || needsWords(row)) {
      const lead = `/${row.name} ${row.name === 'use' ? '@' : ''}`;
      apply({ value: lead + rest.replace(/^\S*/, '').replace(/^ /, ''), caret: lead.length });
      return;
    }
    if (row.source === 'chat' && isChatCommand(row.name)) { runChatCommand(row.name, ''); return; }
    // A plugin's command is the owner's words to the agent: sent as typed.
    const words = `/${row.name}`;
    if (disabled || uploading || filesWait) { apply({ value: `${words} `, caret: words.length + 1 }); return; }
    send(words);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    // With something on offer, the keys pick before they do anything else.
    if (popup && items.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((activeIndex + 1) % items.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((activeIndex - 1 + items.length) % items.length); return; }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        const item = items[activeIndex]!;
        if (popup === 'mention') pickMention(item as Mentionable);
        else pickCommand(item as CommandRow, event.key === 'Tab');
        return;
      }
    }
    if (popup && event.key === 'Escape') { event.preventDefault(); setClosed(true); return; }
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
    // Esc stops the run, as the menu's /stop row says — only from the box, and only with nothing else to close.
    if (event.key === 'Escape' && running && onCommand) {
      event.preventDefault();
      onStop();
      return;
    }
    const node = event.currentTarget;
    const at = node.selectionStart ?? caret;
    const collapsed = node.selectionStart === node.selectionEnd;
    // Tab and Shift+Tab move a list item in and out; anywhere else Tab leaves the box, as it should.
    if (event.key === 'Tab' && collapsed && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const edit = indentItem(text, at, event.shiftKey);
      if (edit) { event.preventDefault(); apply(edit); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // A list carries on; an empty item ends it.
      const edit = collapsed ? continueList(text, at) : null;
      if (edit) { event.preventDefault(); apply(edit); return; }
      // Inside an open code block Enter is a new line; ⌘Enter sends.
      if (inFence(text, at)) return;
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };

  /*
   * A paste. A pasted screenshot is a file, and the commonest one. Text over
   * 4,000 characters becomes a file at once — a log, a whole email — with
   * "Put it in the message" to undo it. Several lines that read as code are
   * fenced, with Undo. Anything else is left to the textarea.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      take(files);
      return;
    }
    const pasted = typeof event.clipboardData?.getData === 'function' ? event.clipboardData.getData('text/plain') : '';
    if (pasted === '') return;
    const node = event.currentTarget;
    const from = node.selectionStart ?? caret;
    const to = node.selectionEnd ?? from;
    const base = text.slice(0, from) + text.slice(to);
    if (pasted.length > LONG_PASTE) {
      event.preventDefault();
      const file = new File([pasted], 'pasted-text.txt', { type: 'text/plain' });
      const [key] = take([file]);
      const lines = pasted.replace(/\n$/, '').split('\n').length;
      const detail = `${lines} ${lines === 1 ? 'line' : 'lines'} · ${Math.ceil(pasted.length / 1024)} KB`;
      setAttachments((current) => current.map((a) => (a.key === key ? { ...a, detail } : a)));
      if (base !== text) apply({ value: base, caret: from });
      setNote({ kind: 'long', key: key!, text: pasted, caret: from });
      return;
    }
    if (looksLikeCode(pasted) && !inFence(base, from)) {
      event.preventDefault();
      const lang = guessLang(pasted);
      const edit = fencePaste(base, from, pasted, lang);
      setNote({ kind: 'fenced', lang, block: edit.value.slice(from, edit.caret), text: pasted });
      apply(edit);
    }
  };

  /** The note's way out: the paste as it was. */
  const undoNote = (): void => {
    if (!note) return;
    if (note.kind === 'fenced') {
      const at = text.indexOf(note.block);
      if (at >= 0) apply({ value: text.slice(0, at) + note.text + text.slice(at + note.block.length), caret: at + note.text.length });
    } else {
      remove(note.key);
      const at = Math.min(note.caret, text.length);
      apply({ value: text.slice(0, at) + note.text + text.slice(at), caret: at + note.text.length });
    }
    setNote(null);
  };

  const failures = attachments.filter((attachment) => attachment.state === 'failed');
  const failed = failures.length;

  /*
   * Talking. While the microphone listens the box becomes the Listening
   * panel; what was heard joins what is typed, for the owner to read and
   * send, and Shift at the ✓ sends it straight away.
   */
  const voice = useVoice({
    conversationId: conversationId ?? null,
    onNotice: setSnapNote,
    onText: (heard, sendNow) => {
      const joined = text.trim() === '' ? heard : `${text.replace(/\s+$/, '')} ${heard}`;
      if (sendNow) { send(joined); return; }
      put(joined);
      if (recalled < 0) remember(joined);
    },
  });
  const listening = voice.state !== 'idle';
  // The panel takes the focus when it opens (its ✓); the box gets it back when it closes.
  const wasListening = useRef(false);
  useEffect(() => {
    if (wasListening.current && !listening) area.current?.focus();
    wasListening.current = listening;
  }, [listening]);

  const showPopup = popup !== null && !listening && !disabled;

  /*
   * The hint line: one sentence about what the caret is in. A failed upload,
   * a refused snap and a held file take it over; a popup has its own foot.
   */
  const item = listItem(text, caret);
  const fenced = inFence(text, caret);
  const named = mentionedHandles(text)
    .map((handle) => people.find((p) => p.handle.toLowerCase() === handle))
    .filter((p): p is Mentionable => Boolean(p));
  const borrowing = makerHandle !== null && leadingMention(text)?.handle === makerHandle.toLowerCase();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const effectOf = (p: Mentionable): string =>
    p.group === 'Borrow' ? (borrowing ? `borrows ${p.name} for this message` : `${agentName} asks them`)
      : p.group === 'In this room' ? 'is asked in this room' : `${agentName} asks them`;
  const problem = failed > 0
    ? (failed === 1 && failures[0]?.error ? failures[0].error : `${failed} files failed to upload and will not be sent`)
    : snapNote ?? (filesWait ? FILES_DURING_RUN : null);
  const hint = problem
    ?? (running || showPopup ? null
      : item ? 'Enter continues the list · Enter on an empty item ends it · Tab indents'
      : fenced ? `In a code block Enter adds a line · ${mac ? '⌘' : 'Ctrl+'}Enter sends`
      : named.length > 0 ? (
        <>
          <span className="cv-chip" {...named[0]!.accent}>@{named[0]!.handle}</span> {effectOf(named[0]!)}{named.length > 1 ? ` · and ${named.length - 1} more` : ''}
        </>
      )
      : text !== '' ? 'Enter sends, Shift+Enter for a new line' : null);

  const words = placeholder ?? (running
    ? `${agentName} is working…`
    : mentions ? 'Message the room · @ to ask someone'
    : team && commandsOn ? `Message ${agentName} · @ to mention, / for commands`
    : `Message ${agentName}`);
  const paintPeople = useMemo(() => people.map((p) => ({ handle: p.handle, accent: p.accent })), [people]);
  const trackCaret = (node: HTMLTextAreaElement): void => setCaret(node.selectionStart ?? node.value.length);

  return (
    // `data-busy`: something here a reload would lose (the shell's auto-reload waits, `shell/freshness.ts`).
    <div className="wb-composer cv" data-testid="composer" data-slim={slim || undefined} data-phone={phone ? 'true' : undefined} data-busy={text.trim() !== '' || holdingFiles || listening ? 'true' : undefined}>
      <div className="cv-anchor">
        {showPopup && popup === 'mention' ? (
          <MentionPopup id={listId} items={mentionItems} active={activeIndex} onPick={pickMention} phone={phone} maxHeight={room} />
        ) : null}
        {showPopup && popup === 'slash' ? (
          <CommandMenu id={listId} items={commandItems} active={activeIndex} onPick={(row) => pickCommand(row, false)} phone={phone} query={slash?.query ?? ''} maxHeight={room} />
        ) : null}
        <div ref={box} className="wb-composer-box cv-box" data-focused={focused || listening} data-disabled={disabled} data-listening={listening || undefined}>
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
                    detail={attachment.detail}
                  />
                </span>
              ))}
            </div>
          ) : null}

          <label className="sr-only" htmlFor={COMPOSER_INPUT_ID}>
            Message {agentName}
          </label>
          <div className="cv-field" hidden={listening}>
            <div className="cv-paint" aria-hidden="true" data-testid="composer-paint">
              {paint(text, paintPeople)}
              <span className="cv-tail">{ZWSP}</span>
            </div>
            <textarea
              id={COMPOSER_INPUT_ID}
              ref={area}
              value={text}
              rows={1}
              spellCheck={false}
              placeholder={words}
              aria-controls={showPopup ? listId : undefined}
              aria-expanded={showPopup ? true : undefined}
              aria-autocomplete={people.length > 0 || commandsOn ? 'list' : undefined}
              aria-activedescendant={showPopup && activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
              onChange={(event) => {
                setText(event.target.value);
                trackCaret(event.target);
                setClosed(false);
                setActive(0);
                // While walking back through what was said, what is in the box is
                // not the draft — the draft is what the walk stashed.
                if (recalled < 0) remember(event.target.value);
              }}
              onSelect={(event) => trackCaret(event.currentTarget)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              disabled={disabled}
              hidden={listening}
            />
          </div>

          {listening ? <ListeningPanel voice={voice} /> : null}

          {note && !listening ? (
            <div className="cv-note" role="status">
              <span className="cv-note-icon"><Icon name={note.kind === 'long' ? 'pasted-doc' : 'code'} /></span>
              <span className="cv-note-text">{note.kind === 'fenced' ? <>Pasted as code · {langName(note.lang)}</> : <>Long paste, attached as a file</>}</span>
              <Button size="sm" variant="ghost" onClick={undoNote}>{note.kind === 'fenced' ? 'Undo' : 'Put it in the message'}</Button>
            </div>
          ) : null}

          <div className="wb-composer-row" hidden={listening}>
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
            <MicButton disabled={disabled} voice={voice} />
            {/* A phone has no other tabs to snap, and no room for the model: the kit draws neither there. */}
            {phone ? null : <button
              className="ui-icon-btn" data-size="sm"
              aria-label="Snap a tab"
              title="Snap a tab — one picture of another tab in this browser, attached here"
              onClick={() => {
                setSnapNote(null);
                setSnapping(true);
                snapTab()
                  .then((file) => { if (file) { take([file]); area.current?.focus(); } })
                  .catch((err: unknown) => setSnapNote(err instanceof Error ? err.message : String(err)))
                  .finally(() => setSnapping(false));
              }}
              disabled={disabled || snapping}
            >
              <Icon name="camera" />
            </button>}

            {model && !phone ? (
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

            {onReadAloud ? (
              <button
                type="button"
                className="ui-icon-btn wb-read-aloud"
                data-size="sm"
                aria-label="Read replies aloud"
                aria-pressed={Boolean(readAloud)}
                title={readAloud ? 'Replies are read aloud. Click to stop.' : 'Read replies aloud, through the voice chosen in Settings → Speech'}
                onClick={() => onReadAloud(!readAloud)}
              >
                <Icon name="speaker" />
              </button>
            ) : null}

            {/* The hint waits its turn: it appears only once the placeholder is
                gone, so the two never occupy the same line. A failed upload
                takes the line over. What the agent is doing is said in the
                thread, where the reply will land, not here. On a phone only a
                problem is said: the line is too short for advice. */}
            <span
              className="wb-hint cv-hint"
              data-shown={Boolean(hint) && (!phone || problem !== null)}
              data-tone={failed > 0 || snapNote !== null ? 'critical' : undefined}
            >
              {phone && problem === null ? null : hint}
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
              onClick={() => send()}
              disabled={!canSend}
            >
              <Icon name="send" />
            </button>
          </div>
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
