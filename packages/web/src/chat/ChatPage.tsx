/**
 * The workbench: a conversation on the left driving a canvas on the right.
 *
 * Two things this page insists on.
 *
 * **It shows something real at rest.** On open it finds the most recent
 * conversation and renders it, canvas and all — not an empty shell with a
 * prompt in the middle. A dashboard whose front page is blank until you type
 * is a dashboard that has nothing to say about the work already done.
 *
 * **Results are derived, never pushed.** Result panels come from
 * the transcript's own tool calls, so they fill in for a run happening now and
 * for a mission that ran while nobody was watching, without either of them
 * knowing a canvas exists. Properties and the live host-browser session are
 * trusted platform panels beside those results, not agent-authored views.
 */
import { readReference, clearReference, withReference, type ChatReference } from './reference';
import { leaveDraft, takeDraft } from './draft';
import type { ChatCommandName } from './commands';
import { leadingMention } from './composer-text';
import { effectiveProviderKind, thinkingIsHonoured } from '../shell/thinking';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { ApiError, api, chatApi, type AgentProfile, type ApprovalRow } from '../api';
import { Canvas } from '../canvas/Canvas';
import { Splitter, WIDTH_VAR } from '../canvas/Splitter';
import { readWidth } from '../canvas/split-math';
import { awaitingPreviews, inspectToolCall, opensTurn, previewKey, renderablesFrom, sourcesHolding, type SourcesPanelProps } from '../canvas/renderables';
import { useServedPreviews } from '../canvas/served';
import { FILES_TAB_ID, filesRenderable, useAgentWorkspace, workspaceChanges } from '../canvas/files';
import { profileRenderable, profileTabId } from './properties';
import { useAsync } from '../ui';
import { BrowserMenu, BrowserView } from '../canvas/views/BrowserView';
import { HostControls } from '../views/HostControls';
import { ErrorBanner, Notice } from '../ui';
import { BROWSER_TOOLS, conversationBrowser, endedBrowser, pausedBrowser, stepFor } from './browser';
import { BrowserAsk, browserCardOf } from './BrowserAsk';
import { SecretRequestDock, secretRequestOf } from './SecretRequest';
import { WEB_SOURCE_TOOLS } from './sources';
import { OWN_TOOL_TITLES, QUIET_TOOLS } from './own-tools';
import { ConversationHistory } from './ConversationHistory';
import { useCanvasTabs } from './canvas-tabs';
import { selfClosed, tabStamp, versionHolding } from '../canvas/tab-order';
import { agentRoute, chatRoute, settingsRoute } from '../routes';
import type { PreviewProps, Renderable, ViewDescriptor } from '../canvas/types';
import { AgentRail } from '../shell/AgentRail';
import { AgentAvatar, FaceMark, GradientField, Icon } from '../ui';
import { NewAgentStrip } from './NewAgentStrip';
import { ROLE_MAKER, cannotRunFix, cannotRunSentence, introOf, startersOf, type AgentAttention, type AgentGroups } from '../shell/roster';
import { Composer, type ComposerDraft, type ComposerHandle } from './Composer';
import { artifactRenderable, artifactTabId, type AttachmentBlock } from './attachments';
import { QuestionPicker } from './QuestionPicker';
import { ApprovalDock, type DockedApproval } from './ApprovalDock';
import { OfferButtons, askedByLine, delegatedApprovals, useThreadActions } from './thread-actions';
import { conversationLine } from './lifetime';
import { CarryOverNote } from './CarryOver';
import { MessageList, type LiveCall, type LiveTurnView } from './MessageList';
import { openChatStream } from './stream';
import { claimPlayback, playAudio, playbackCurrent, readAloudPreference, saveReadAloud, stopPlayback } from './voice';
import { OWNER_INTERJECTION_SPEAKER } from './types';
import type { ChatAgent, ChatConversation, ChatEvent, ChatMessage, GroupView, UploadedAttachment } from './types';
import { groupProblem, namesSentence, type GroupAction } from '../shell/GroupRoom';
import { accentAttrs, accentOf } from '../shell/accent';
import { useThisMachine } from '../useThisMachine';

/* Until the owner drags the grip, the column has no width of its own: the
   kit's flex (420px basis, 600px at most) shares the window with the canvas.
   The grip and its arithmetic are `canvas/Splitter.tsx` and `canvas/split-math.ts`. */

export interface ChatPageProps {
  requestedConversationId?: string | undefined;
  /**
   * The panel the link asked to land on — `browser`, from a Take over button
   * sent to another surface. Honoured once, when that panel exists; after
   * that the canvas is the owner's again and a poll never re-steals it.
   */
  requestedTab?: string | undefined;
  onConversationOpened?: (agentId: string, conversationId: string, replace?: boolean) => void;
  timezone: string;
  /**
   * The roster, already ordered, and who is selected. Owned by the shell now
   * that the agent rail lives there: two views of one choice would drift.
   */
  agents: AgentGroups;
  agentId: string | null;
  /** Whose name a starter's `{{default}}` stands for. */
  defaultAgentId?: string | null;
  /** Set when the page is a group's room rather than one agent's thread. */
  group?: GroupView | null;
  /** One of the group's own things from its ⋯ menu: Members, Rename, Clear, Delete. Shell-owned. */
  onGroupAction?: (action: GroupAction) => void;
  onSelectAgent: (agentId: string) => void;
  /** Who is working in the open conversation right now, or null: the roster's accent dot. */
  onWorking?: (agentId: string | null) => void;
  /** Who is waiting on the owner — drawn on the narrow strip's faces. */
  attention: Map<string, AgentAttention>;
  /**
   * True when the shell's agent rail has lain down, so the conversation header
   * carries it instead. A separate flag from `narrow`: the rail gives way
   * before the canvas does.
   */
  agentsInHeader: boolean;
  /** The canvas becomes a sheet below this; passed in so tests can force it. */
  narrow: boolean;
  onOpenCanvas?: () => void;
  canvasOpen?: boolean;
  onCloseCanvas?: () => void;
  /** Set by the shell so the rail's "new conversation" button reaches here. */
  newConversationSignal?: number;
}

/** A sheet or dialog is open, or this is a touch screen: leave the focus where it is. */
function composerFocusUnwanted(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  return window.matchMedia?.('(pointer: coarse)').matches === true;
}

export function ChatPage({
  timezone,
  agents,
  agentId,
  defaultAgentId = null,
  group = null,
  onGroupAction,
  onSelectAgent,
  onWorking,
  attention,
  agentsInHeader,
  narrow,
  canvasOpen,
  onOpenCanvas,
  onCloseCanvas,
  newConversationSignal,
  requestedConversationId,
  requestedTab,
  onConversationOpened,
}: ChatPageProps): JSX.Element {
  const thisMachine = useThisMachine();
  const [textSize, setTextSize] = useState(() => {
    try { const value = Number(localStorage.getItem('buddi.chatTextSize')); return Number.isInteger(value) && value >= 11 && value <= 19 ? value : 13; }
    catch { return 13; }
  });
  const changeTextSize = (value: number): void => {
    setTextSize(value);
    try { localStorage.setItem('buddi.chatTextSize', String(value)); } catch { /* Session-only when storage is unavailable. */ }
  };
  const readingControls = <div className="wb-reading-controls" role="group" aria-label="Message text size">
    <span>Text size</span>
    <button className="ui-btn" data-size="sm" role="menuitem" aria-label="Decrease message text size" disabled={textSize <= 11} onClick={() => changeTextSize(textSize - 1)}>A−</button>
    <button className="ui-btn" data-size="sm" role="menuitem" aria-label="Increase message text size" disabled={textSize >= 19} onClick={() => changeTextSize(textSize + 1)}>A+</button>
    <button className="ui-btn" data-size="sm" role="menuitem" aria-label="Reset message text size" disabled={textSize === 13} onClick={() => changeTextSize(13)}>Reset</button>
  </div>;

  const [descriptors, setDescriptors] = useState<ViewDescriptor[]>([]);
  const mediaTools = useMemo(() => new Set(descriptors.filter((view) => view.messenger?.mediaFirst === true).map((view) => view.tool)), [descriptors]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  /*
   * Whose thread is known to be new: the agent (or room) whose most recent
   * conversation was looked for and not found, or that the owner started
   * afresh. Only then does the empty thread wear the agent's opening; while a
   * conversation is still on its way the thread stays blank, so an existing
   * one never flashes "Hi, I'm …" before its messages.
   */
  const [freshFor, setFreshFor] = useState<string | null>(null);
  /** The owner's accepted send, shown before the run has persisted it. */
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveCall[]>([]);
  /** The answer as it is being written, ahead of the transcript. */
  const [partial, setPartial] = useState<LiveTurnView | null>(null);
  const [running, setRunning] = useState(false);
  const [awaiting, setAwaiting] = useState<Map<string, string>>(new Map());
  /**
   * Approvals this page has seen settle (decided here or elsewhere, expired):
   * gone from the dock at once, whatever transcript the page still holds. A
   * dock that kept one would hide the question and the composer behind a card
   * that draws nothing.
   */
  const [settledApprovals, setSettledApprovals] = useState<ReadonlySet<string>>(new Set());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** The canvas's closed tabs and their order, kept on the server per conversation. */
  const canvasTabs = useCanvasTabs(conversationId ?? null);
  /** The minute, so a tab past its expiry closes itself while the page is open. */
  const [minute, setMinute] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setMinute(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  /*
   * Files the owner opened from the thread. Held per conversation and dropped
   * with it: a picture from one thread has no business on another's canvas.
   */
  const [openedFiles, setOpenedFiles] = useState<AttachmentBlock[]>([]);
  /** Whether a file is being dragged over the column, for the drop overlay. */
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const composer = useRef<ComposerHandle>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const previousNewSignal = useRef(newConversationSignal ?? 0);
  const routeAgent = useRef(agentId);
  const selection = useRef({ agentId, conversationId });
  selection.current = { agentId, conversationId };
  const dismissed = canvasTabs.closed;
  const [error, setError] = useState<string | null>(null);
  /**
   * A line about the thread itself, said once, above it. A room that rolled
   * over is the only thing that still speaks here: an agent conversation
   * ending is not announced at all — memory carries over, and where work was
   * in flight the grey "Carried over" note in the transcript says so.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Chips the owner has clicked, gone from the page before the server answers.
   *
   * A chip is a thing you click once, and leaving it sitting there while the
   * take is in flight invites the second click that the claim then refuses. It
   * comes back if the take fails — with the reason in the banner — because a
   * chip that vanished and did nothing is the worse half of the same bug.
   */
  const [now, setNow] = useState(() => Date.now());
  const [width, setWidth] = useState<number | null>(readWidth);
  const columnRef = useRef<HTMLElement>(null);
  /*
   * The properties panel, when the owner has asked for one. It is held here
   * rather than fetched by the canvas because it belongs to the *agent*, not to
   * the conversation: it survives a new thread, and it is dropped the moment
   * the owner switches to somebody else — a panel headed "Ledger" while the
   * conversation is with Scout would be a lie the tab strip cannot correct.
   */
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [reference, setReference] = useState<ChatReference | null>(null);
  /** A line the panel put in the composer's mouth. Never sent for the owner. */
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  /*
   * Read replies aloud (docs/dashboard.md, Talking to buddi): a preference of
   * this browser, off until switched on. The last turn's words are followed
   * as they stream, and at `run.finished` they are spoken through the speech
   * plugin and played through the page's one audio element.
   */
  const [readAloud, setReadAloud] = useState(readAloudPreference);
  const readAloudOn = useRef(readAloud);
  readAloudOn.current = readAloud;
  const lastTurn = useRef<{ runId: string; turn: number; text: string } | null>(null);
  /** Why replies are not being read aloud, said once per page load. */
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const switchReadAloud = useCallback((on: boolean) => {
    setReadAloud(on);
    saveReadAloud(on);
    if (!on) stopPlayback();
  }, []);
  /*
   * Thinking, as this page has it since the owner switched it.
   *
   * The roster is fetched by the shell and is the truth; this is the answer
   * between the click and the next fetch of it, so the switch moves under the
   * finger rather than a second later. It is dropped when the agent changes —
   * one agent's setting is not another's — and on a refusal, so the control
   * never shows a state the file does not have.
   */
  const [thinkingNow, setThinkingNow] = useState<'on' | 'off' | null>(null);
  const [switchedFor, setSwitchedFor] = useState<string | null>(null);
  // Another page may leave a sentence for this agent (an alert to ask about).
  // It is read once, for the agent it was written for, and then forgotten.
  useEffect(() => {
    if (!agentId) return;
    setReference(readReference(agentId));
    const left = takeDraft(agentId);
    if (left) setDraft({ text: left, at: Date.now() });
  }, [agentId]);

  /** Whose thread this is: a room, or one agent. */
  const threadOwner = group ? `group:${group.id}` : (agentId ?? null);
  const everyone = [...agents.top, ...agents.middle, ...agents.bottom];
  const agent = everyone.find((c) => c.id === agentId) ?? null;
  // Which kind of account the agent runs on decides whether the thinking switch is real.
  const providerAccounts = useAsync(() => api.providerAccounts(), []);
  const members = group ? group.members.map((id) => everyone.find((a) => a.id === id)).filter((a): a is ChatAgent => Boolean(a)) : [];
  /** Who is speaking right now in a room, from the run's own event. */
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);

  // The roster draws a dot on whoever is working here; tell it, and clear it
  // when this page stops watching.
  const workingId = running ? (runningAgentId ?? agentId ?? null) : null;
  useEffect(() => { onWorking?.(workingId); }, [workingId, onWorking]);
  useEffect(() => () => onWorking?.(null), [onWorking]);

  /* ---- what the page knows before anyone types ---- */

  useEffect(() => {
    let cancelled = false;
    chatApi
      .views()
      .then((viewList) => {
        if (!cancelled) setDescriptors(viewList.views ?? []);
      })
      .catch(() => {
        /* No descriptors means the canvas draws shapes generically. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opening on the most recent conversation is what makes the page useful at
  // rest: the last thing that happened, already drawn.
  useEffect(() => {
    if (!agentId) return undefined;
    const sameAgent = routeAgent.current === agentId;
    routeAgent.current = agentId;
    // Our own successful send/latest-load just canonicalized the URL. Keep its
    // running state, optimistic message and in-flight transcript fetch intact.
    if (sameAgent && requestedConversationId && requestedConversationId === selection.current.conversationId) return undefined;
    let cancelled = false;
    setConversationId(null);
    setConversation(null);
    setFreshFor(null);
    setOptimistic([]);
    setError(null);
    setRunning(false);
    setActiveTab(null); setOpenedFiles([]); setFocusedStep(null);
    setHistoryOpen(false);
    // Whoever this is now, it is not who the open panel described.
    setProfile(null);
    if (requestedConversationId) {
      if (requestedConversationId !== 'new') setConversationId(requestedConversationId);
      else setFreshFor(threadOwner);
      return () => { cancelled = true; };
    }
    (group ? chatApi.groupConversations(group.id) : chatApi.conversations(agentId))
      .then((list) => {
        if (cancelled) return;
        const latest = [...(list.conversations ?? [])].sort(byRecency)[0];
        if (latest) {
          setConversationId(latest.id);
          onConversationOpened?.(agentId, latest.id);
        } else setFreshFor(threadOwner);
      })
      .catch(() => {
        /* A fresh install has no conversations. That is not an error. */
        if (!cancelled) setFreshFor(threadOwner);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, group?.id, threadOwner, requestedConversationId, onConversationOpened]);

  const refresh = useCallback((id: string) => {
    return chatApi
      .conversation(id)
      .then((loaded) => {
        if (selection.current.conversationId !== id) return;
        if (loaded.agentId !== selection.current.agentId) throw new Error('This conversation belongs to another agent. Open it from that agent’s history.');
        setConversation(loaded);
        setOptimistic((pending) => pending.filter((message) => !transcriptContains(loaded, message)));
      })
      .catch((err: unknown) => { if (selection.current.conversationId === id) setError(message(err)); });
  }, []);

  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    setAwaiting(new Map());
    setSettledApprovals(new Set());
    setLive([]);
    void chatApi
      .conversation(conversationId)
      .then((loaded) => {
        if (!cancelled) {
          if (loaded.agentId !== agentId) throw new Error('This conversation belongs to another agent. Open it from that agent’s history.');
          setConversation(loaded);
          setOptimistic((pending) => pending.filter((message) => !transcriptContains(loaded, message)));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, agentId]);

  // A decision may arrive from Telegram or another dashboard. Reconcile from
  // durable state, including after a lost SSE frame or a page reload.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void chatApi.conversation(conversationId).then(loaded => {
        if (cancelled || loaded.agentId !== selection.current.agentId) return;
        setConversation(loaded);
        // The same rule every load applies: once the transcript has what we
        // sent, the optimistic copy has done its job.
        setOptimistic((pending) => pending.filter((message) => !transcriptContains(loaded, message)));
      }).catch(() => {});
    }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [conversationId, agentId]);

  /* ---- the live run ---- */

  useEffect(() => {
    if (!conversationId) return undefined;
    const handle = openChatStream({
      url: chatApi.streamUrl(conversationId),
      onEvent: (event: ChatEvent) => {
        switch (event.name) {
          case 'run.started':
            lastTurn.current = null;
            setRunning(true);
            setPartial(null);
            setRunningAgentId(str(event.data['agentId']));
            break;
          case 'live': {
            const runId = str(event.data['runId']) ?? '';
            const turn = Number(event.data['turn'] ?? 0);
            const kind = event.data['kind'] === 'thinking' ? 'thinking' : 'text';
            const text = str(event.data['text']) ?? '';
            const at = Date.now();
            if (kind === 'text') {
              const held = lastTurn.current;
              lastTurn.current = held && held.runId === runId && held.turn === turn
                ? { ...held, text: held.text + text }
                : { runId, turn, text };
            }
            setPartial((current) => {
              const base: LiveTurnView = current && current.runId === runId && current.turn === turn
                ? current
                : { runId, turn, text: '', thinking: '', thinkingStartedAt: null, textStartedAt: null, settled: false };
              return kind === 'thinking'
                ? { ...base, thinking: base.thinking + text, thinkingStartedAt: base.thinkingStartedAt ?? at }
                : { ...base, text: base.text + text, textStartedAt: base.textStartedAt ?? at };
            });
            break;
          }
          case 'live.snapshot': {
            const runId = str(event.data['runId']) ?? '';
            const turn = Number(event.data['turn'] ?? 0);
            const text = str(event.data['text']) ?? '';
            const thinking = str(event.data['thinking']) ?? '';
            const startedAt = Number(event.data['startedAt'] ?? Date.now());
            lastTurn.current = { runId, turn, text };
            setPartial({ runId, turn, text, thinking, thinkingStartedAt: thinking ? startedAt : null, textStartedAt: text ? startedAt : null, settled: false });
            break;
          }
          case 'live.settle': {
            const runId = str(event.data['runId']) ?? '';
            const turn = Number(event.data['turn'] ?? 0);
            // Withdrawn by the grounding guard: no message will carry these
            // words, so they go now, and are never read aloud.
            if (event.data['retracted'] === true) {
              if (lastTurn.current?.runId === runId && lastTurn.current.turn === turn) lastTurn.current = null;
              setPartial((current) => current && current.runId === runId && current.turn === turn ? null : current);
              break;
            }
            // Marked, not dropped: it stays on screen until the refresh that
            // carries the real message has landed, so the words never blink.
            setPartial((current) => current && current.runId === runId && current.turn === turn ? { ...current, settled: true } : current);
            break;
          }
          case 'tool.called': {
            const id = str(event.data['toolUseId']) ?? str(event.data['id']);
            const name = str(event.data['name']) ?? str(event.data['tool']) ?? 'tool';
            if (id) setLive((current) => [...current.filter((c) => c.toolUseId !== id), { toolUseId: id, name, startedAt: Date.now() }]);
            break;
          }
          case 'tool.result': {
            const id = str(event.data['toolUseId']) ?? str(event.data['id']);
            if (id) setLive((current) => current.filter((call) => call.toolUseId !== id));
            // The canvas fills in as the run proceeds, not after it.
            void refresh(conversationId);
            break;
          }
          case 'reaction':
            // A reaction left on Telegram, drawn under its message now.
            void refresh(conversationId);
            break;
          case 'message.appended':
            void refresh(conversationId).then(() => {
              setPartial((current) => (current?.settled ? null : current));
            });
            break;
          case 'awaiting-approval': {
            const approvalId = str(event.data['approvalId']) ?? str(event.data['actionId']);
            const toolUseId = str(event.data['toolUseId']);
            if (approvalId && toolUseId) {
              setAwaiting((current) => new Map(current).set(toolUseId, approvalId));
            }
            setLive((current) => current.filter((call) => call.toolUseId !== toolUseId));
            void refresh(conversationId);
            break;
          }
          case 'run.finished': {
            setRunning(false);
            setLive([]);
            setPartial(null);
            setRunningAgentId(null);
            // A turn that failed says so in words the server already wrote for
            // a person. The raw error stays in the log: the page is never
            // handed it, so it can never put it on the screen.
            const failed = str(event.data['message']);
            setError(failed ?? null);
            const spoken = lastTurn.current?.text.trim() ?? '';
            lastTurn.current = null;
            if (!failed && spoken !== '' && readAloudOn.current) {
              void speakReply(spoken, conversationId).then((note) => { if (note) setVoiceNote(note); });
            }
            void refresh(conversationId);
            break;
          }
          default:
            break;
        }
      },
    });
    return () => handle.close();
  }, [conversationId, refresh]);

  // One clock. A second while something is running, because elapsed counters
  // are read; a minute otherwise, because the header's "this one has aged out"
  // has to become true on its own for an owner who left the tab open.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), live.length === 0 ? 60_000 : 1000);
    return () => window.clearInterval(handle);
  }, [live.length]);

  /* ---- the canvas ---- */

  const browser = useAsync(() => agentId && conversationId ? api.browser({ agentId, conversationId }) : Promise.resolve(undefined), [agentId, conversationId], 1500);
  /*
   * The status, but only while it is demonstrably about *this* conversation.
   *
   * A poll in flight leaves the previous answer in hand for a render, so the
   * status arriving here during a switch can still be the thread the owner
   * just left. Matched on the session's own agent and conversation, so
   * somebody else's screen can never be drawn under this one's name.
   */
  const browserStatus = browser.error ? undefined : browser.data;
  const ownStatus = browserStatus?.session
    && browserStatus.session.agentId === agentId
    && browserStatus.session.conversationId === conversationId
    ? browserStatus : undefined;
  const liveBrowser = conversationBrowser(ownStatus, agentId, conversationId);
  const browserTabId = liveBrowser?.id ?? null;

  /*
   * A session that has ended keeps its tab.
   *
   * What was on the screen when the agent let go is the last thing the owner
   * has to check the work against, and the steps that led there are on the
   * same panel. It simply stops holding the strip: it is history now, so it is
   * unpinned and says so. Held per conversation, because another thread's
   * screen has no business on this one's canvas.
   */
  const [endedBrowserTab, setEndedBrowserTab] = useState<{ agentId: string; conversationId: string; tab: Renderable } | null>(null);
  // Rewritten whenever the session or the mode changes: the first poll can
  // land before the gateway has said which mode this is, and a computer
  // session must not be remembered as a browser.
  const browserMode = ownStatus?.mode;
  useEffect(() => {
    if (liveBrowser && agentId && conversationId) setEndedBrowserTab({ agentId, conversationId, tab: endedBrowser(liveBrowser, browserMode) });
  }, [browserTabId, browserMode, agentId, conversationId]);
  const keptBrowserTab = endedBrowserTab && endedBrowserTab.agentId === agentId && endedBrowserTab.conversationId === conversationId
    // Put away like any other panel of history.
    && !dismissed.includes(endedBrowserTab.tab.id)
    ? endedBrowserTab.tab : null;
  /*
   * The card the conversation is parked on, when it is one of the browser's
   * five: drawn the kit's way in the dock, and — for the Stop's Resume — the
   * reason the Page tab shows the pause with no page open.
   */
  const browserCard = browserCardOf(conversation?.question);
  /* An agent's `secret.request`: its own card, with the composer still under it as the kit draws it. */
  const signInCard = secretRequestOf(conversation?.question);
  const pausedTab = liveBrowser ? null : pausedBrowser(browserStatus, conversationId ?? null, browserCard?.kind === 'paused');
  const browserTab = liveBrowser ?? pausedTab ?? keptBrowserTab;
  /*
   * The composer's "Use my Chrome": this conversation pinned to the owner's
   * Chrome. Offered only once his Chrome is allowed and paired, since a pin
   * never allows what the switches forbid.
   */
  const chromeRoute = browserStatus?.routes?.find((route) => route.kind === 'chrome');
  const chromeChip = !group && conversationId && chromeRoute?.allowed && chromeRoute.paired ? {
    on: browserStatus?.pin === 'chrome',
    onChange: (on: boolean) => { void api.browserPin(conversationId, on ? 'chrome' : 'auto').catch(() => undefined).finally(browser.reload); },
  } : undefined;
  /** A step the owner clicked in the chat, held until they click another. */
  const [focusedStep, setFocusedStep] = useState<string | null>(null);

  /*
   * The canvas contents: everything the transcript produced, and — last, when
   * the owner has opened it — the properties panel.
   *
   * It is appended rather than mixed in because it is not part of the
   * conversation's history: it takes no place in the cap on how far back the
   * canvas remembers, it cannot be pushed off by a long run, and it is marked
   * unsubstantial so that a result arriving mid-read still takes the screen.
   * The owner asked a question about the agent; they did not ask the canvas to
   * stop following the work.
   */
  /*
   * Previews this conversation is waiting on: a process that was started but
   * was not listening yet. Asked about until it is served, then drawn.
   */
  const awaitedPreviews = useMemo(
    () => awaitingPreviews({ messages: conversation?.messages ?? [], descriptors }),
    [conversation, descriptors],
  );
  const servedPreviews = useServedPreviews(awaitedPreviews, conversationId ?? null);

  /*
   * The agent's workspace, when a plugin keeps one for it: a Files tab, first
   * on the strip and pinned there, read again whenever a change to a file
   * comes back in this conversation. A room has no one agent, so no tab.
   */
  const workspace = useAgentWorkspace(group ? null : agentId);
  const fileChanges = useMemo(() => workspaceChanges(conversation?.messages ?? []), [conversation]);

  /** The transcript's tabs before closing, for a chat row reopening one by any call it holds. */
  const transcriptTabs = useRef<Renderable[]>([]);
  const renderables: Renderable[] = useMemo(() => {
    const fromTranscript = renderablesFrom({
      messages: conversation?.messages ?? [],
      descriptors,
      awaiting,
      served: servedPreviews.served,
      // While the Browser panel is on this canvas it is already drawing every
      // one of those calls. Without a session there is no panel, and they fall
      // back to a tab each, exactly as an old conversation has always shown.
      ...(browserTab ? { folded: BROWSER_TOOLS } : {}),
      // A turn's web reads and searches share one Sources tab.
      gathered: WEB_SOURCE_TOOLS,
      // What an agent reads to know its owner opens no tab of its own.
      quiet: QUIET_TOOLS,
      titles: OWN_TOOL_TITLES,
    });
    transcriptTabs.current = fromTranscript;
    /*
     * Closed by the owner, or closed by itself (past its expiry; a failure
     * with no view is parked in the timeline instead). Either way a chat row
     * clicked brings it back while it is the one being read.
     */
    const asked = (item: Renderable): boolean => activeTab !== null
      && (item.id === activeTab || (item.versions ?? []).some(version => version.id === activeTab));
    const items: Renderable[] = [];
    // Until the stored state is in, the transcript's tabs wait: a tab the owner closed must not flash back.
    for (const item of canvasTabs.ready ? fromTranscript : fromTranscript.filter(item => item.source === 'approval')) {
      if (item.source !== 'approval' && dismissed.includes(tabStamp(item)) && !asked(item)) continue;
      const closedBySelf = selfClosed(item, minute);
      if (closedBySelf === 'gone' && !asked(item)) continue;
      items.push(closedBySelf === 'parked' ? { ...item, parked: true } : item);
    }
    // A web call clicked in the conversation opens its turn's Sources tab on that call;
    // an earlier call on a subject opens that subject's tab on that version.
    const holder = activeTab ? sourcesHolding(items, activeTab) : null;
    if (holder) holder.props = { ...(holder.props as SourcesPanelProps), focus: activeTab };
    const versioned = activeTab && !holder ? versionHolding(items, activeTab) : null;
    if (versioned) versioned.focus = activeTab;
    if (activeTab && !holder && !versioned && !dismissed.includes(activeTab) && !items.some(item => item.id === activeTab)) {
      const inspection = inspectToolCall(conversation?.messages ?? [], activeTab, { redactInputOf: BROWSER_TOOLS, resultOf: QUIET_TOOLS, titles: OWN_TOOL_TITLES });
      // A browser call is never inspected as raw arguments: what was typed on
      // the owner's screen belongs on the panel as a step, not in a JSON tree
      // on the canvas.
      if (inspection && !BROWSER_TOOLS.has(inspection.tool)) items.push(inspection);
    }
    if (browserTab) items.push(browserTab);
    for (const file of openedFiles) items.push(artifactRenderable(file));
    if (workspace) items.unshift(filesRenderable(workspace, fileChanges));
    return profile ? [...items, profileRenderable(profile)] : items;
  }, [conversation, descriptors, awaiting, profile, browserTabId, browserTab?.title, activeTab, canvasTabs.closed, canvasTabs.ready, minute, conversationId, openedFiles, servedPreviews.served, workspace, fileChanges]);

  /*
   * What the owner has said here, newest first, for the composer's Up key.
   *
   * Only their own words: a tool result travels as a user message with no
   * text, an approval coming back is nobody speaking, and in a room the
   * agents' turns carry their own speaker. The transcript the page already
   * holds is the whole source — the carried-over note and first run's opening
   * turn are not in it, so neither can be recalled.
   */
  const ownHistory = useMemo(() => {
    const said: string[] = [];
    for (const message of conversation?.messages ?? []) {
      if (message.role !== 'user') continue;
      if (message.speaker && message.speaker !== 'owner') continue;
      const text = message.blocks.find((block) => block.type === 'text')?.text.trim();
      if (text) said.unshift(text);
    }
    return said;
  }, [conversation]);

  const inlineApprovals = useMemo(
    () => renderables.filter((item) => item.source === 'approval'),
    [renderables],
  );
  const inlineApproval = inlineApprovals.at(-1) ?? null;
  /** What the dock holds: every pending approval here, oldest first. */
  const docked: DockedApproval[] = useMemo(
    () => [
      ...inlineApprovals.map((item) => ({ approvalId: (item.props as { approvalId: string }).approvalId, toolUseId: item.id })),
      // A colleague's approval under one of this thread's delegations is
      // decided here as well: the owner is here, not in the colleague's thread.
      ...delegatedApprovals(conversation, everyone),
    ].filter((item) => !settledApprovals.has(item.approvalId)),
    // `everyone` is only read for handles; the roster is stable for a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inlineApprovals, conversation?.delegatedApprovals, settledApprovals],
  );

  /*
   * What the canvas turns to on its own.
   *
   * Not simply the newest thing: a run that calls six tools to answer one
   * question would otherwise flick through six panels and land on whichever
   * happened to be last — often a write that returned `{ok: true}`. So the
   * canvas follows the newest renderable that has something in it — rows,
   * points, figures, a document — and a result with nothing to draw takes a
   * tab and waits there instead of taking the screen. An approval still
   * interrupts everything; that is handled where it arrives.
   */
  const focusId = useMemo(() => {
    for (let index = renderables.length - 1; index >= 0; index -= 1) {
      const candidate = renderables[index];
      if (candidate?.substantial) return tabStamp(candidate);
    }
    return null;
  }, [renderables]);

  /** The tab in front: the one holding the call when the owner opened a call. */
  const shownTab = (activeTab
    ? sourcesHolding(renderables, activeTab)?.id ?? versionHolding(renderables, activeTab)?.id
    : null) ?? activeTab;
  // Looking at a tab puts it first on the strip, here and on the next device.
  const touchTab = canvasTabs.touch;
  useEffect(() => {
    if (shownTab && renderables.some(item => item.id === shownTab)) touchTab(shownTab);
    // Only when what is in front changes, not on every new result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTab, touchTab]);
  /** When the owner last spoke: the timeline's "this turn". */
  const turnStartedAt = useMemo(() => {
    const messages = conversation?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if ((!message.speaker || message.speaker === 'owner') && opensTurn(message)) return message.at ?? null;
    }
    return null;
  }, [conversation]);

  const previousFocus = useRef<string | null>(null);
  /*
   * The tab to fall back on when nothing substantial has ever arrived.
   *
   * A finished browser session is skipped here: it is appended after the
   * transcript, so "the newest tab" would mean a panel of history every time
   * the owner opened an old conversation, instead of whatever that
   * conversation actually produced. A live one is not skipped — it has its own
   * rule below, and it really is the newest thing. The Files tab is never
   * chosen here: it is shown when it is alone, and selected only by the owner.
   */
  const lastId = renderables.filter((item) => (item.source !== 'browser' || item.pinned === true) && item.id !== FILES_TAB_ID).at(-1)?.id
    ?? renderables.filter((item) => item.id !== FILES_TAB_ID).at(-1)?.id ?? null;
  useEffect(() => {
    if (focusId && focusId !== previousFocus.current) {
      previousFocus.current = focusId;
      setActiveTab(focusId);
      return;
    }
    // Nothing substantial has ever arrived: show the newest tab rather than none.
    if (activeTab === null && lastId) setActiveTab(lastId);
  }, [focusId, activeTab, lastId]);

  /*
   * A preview that has just started being served is selected once, the way a
   * new result is — unless the owner has moved off what the canvas last
   * turned to, or a decision is waiting. Only one confirmed while it was
   * being waited for: reopening an old conversation opens nothing by itself.
   */
  const previousLive = useRef<ReadonlySet<string>>(servedPreviews.live);
  useEffect(() => {
    const before = previousLive.current;
    previousLive.current = servedPreviews.live;
    const arrived = [...servedPreviews.live].filter((key) => !before.has(key));
    if (arrived.length === 0 || inlineApproval) return;
    const ownerMoved = activeTab !== null && activeTab !== previousFocus.current;
    if (ownerMoved) return;
    const tab = [...renderables].reverse().find((item) => item.source === 'descriptor'
      && item.renderer === 'preview'
      && (item.props as PreviewProps).target !== null
      && arrived.includes(previewKey((item.props as PreviewProps).target!)));
    if (tab) setActiveTab(tab.id);
  }, [servedPreviews.live, renderables, inlineApproval, activeTab]);

  // Select once when a session appears. Polls must not steal a chart the owner
  // selected, and a pending approval remains more important than the preview.
  const previousBrowser = useRef<string | null>(null);
  useEffect(() => {
    if (browserTabId !== previousBrowser.current) {
      previousBrowser.current = browserTabId;
      if (browserTabId && !inlineApproval) setActiveTab(browserTabId);
    }
  }, [browserTabId, inlineApproval]);

  /*
   * The link said "Browser".
   *
   * A Take over button on Telegram is a deep link to this conversation's
   * Browser tab, and the tab only exists once the status poll has found the
   * session — so this waits for it rather than selecting nothing. Once.
   */
  const honouredTab = useRef<string | null>(null);
  const requestedBrowserTab = requestedTab === 'browser' ? browserTab?.id ?? null : null;
  useEffect(() => {
    if (!requestedBrowserTab || honouredTab.current === requestedBrowserTab) return;
    honouredTab.current = requestedBrowserTab;
    setActiveTab(requestedBrowserTab);
  }, [requestedBrowserTab]);

  /*
   * A browser call the owner had open before the panel appeared.
   *
   * Its tab has just been folded away, so the selection points at nothing.
   * The step it made is on the panel; go there rather than leaving the canvas
   * to fall back to whatever happens to be last.
   */
  const browserTabTarget = browserTab?.id ?? null;
  useEffect(() => {
    if (!browserTabTarget || !activeTab) return;
    // `stepFor` refuses a call that is waiting on the owner: that one keeps
    // its envelope, and the selection with it.
    if (stepFor(conversation?.messages ?? [], activeTab) === null) return;
    setFocusedStep(activeTab);
    setActiveTab(browserTabTarget);
  }, [browserTabTarget, activeTab, conversation]);

  /* ---- actions ---- */

  /** A file, from the thread or the tray, onto the canvas. */
  const openFile = (file: AttachmentBlock): void => {
    setOpenedFiles(current => current.some(item => item.artifactId === file.artifactId) ? current : [...current, file]);
    setActiveTab(artifactTabId(file.artifactId));
    if (narrow) onOpenCanvas?.();
  };

  /**
   * The sentence that replaces the composer, or null when there is one.
   *
   * A group is never blocked here: its members are checked per turn by the
   * coordinator, and one member without an account is not the room being shut.
   */
  const blocked = !group && agent && !agent.available ? cannotRunSentence(agent) : null;
  /*
   * A room that lost an agent to an uninstall. Its coordinator gone, the
   * server refuses the room's turns, so the sentence takes the composer's
   * place like `blocked` does; one member left only says so above it.
   */
  /*
   * A room's face: its first two members crossed on the diagonal, the same
   * mark the rail draws for it. One that left buddi is a "?".
   */
  const groupFaces = group ? (
    <span className="wb-group-stack" aria-hidden="true">
      {group.members.slice(0, 2).map((id) => {
        const member = everyone.find((a) => a.id === id);
        return <FaceMark key={id} className="wb-group-chip" id={id} name={member?.name ?? '?'} face={member} initials={1} />;
      })}
    </span>
  ) : null;
  // Not before the roster has loaded: an empty list would read as everyone gone.
  const roomProblem = group && everyone.length > 0 ? groupProblem(group, everyone) : null;
  const roomBlocked = roomProblem?.kind === 'coordinator';
  // Which door that sentence opens: Plugins when a plugin is what is missing,
  // Model accounts otherwise.
  const blockedFix = cannotRunFix(group ? null : agent);

  /*
   * The cursor goes where the owner is about to type: a thread opened from
   * the list, New conversation, or first run's Open buddi lands in the
   * composer. Not while a card stands in its place (an approval, a question),
   * not over an open sheet or dialog, and not on a touch screen, where focus
   * would throw the keyboard up over the thread.
   */
  const hasCard = docked.length > 0 || Boolean(conversation?.question);
  const cardShown = useRef(hasCard);
  cardShown.current = hasCard;
  useEffect(() => {
    if (cardShown.current || composerFocusUnwanted()) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (cardShown.current || composerFocusUnwanted()) return;
      composer.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [agentId, group?.id, conversationId, newConversationSignal]);

  const thinking = agent && switchedFor === agent.id ? thinkingNow : (agent?.thinking ?? null);
  /**
   * Switch thinking from the composer.
   *
   * The very call the Agents page makes (`api.setAgentEngine`), because it is
   * the same decision written to the same key of the same file: two writers
   * with two implementations is how the two surfaces end up disagreeing about
   * what the agent does.
   */
  const switchThinking = (next: 'on' | 'off'): void => {
    if (!agent) return;
    const id = agent.id;
    setSwitchedFor(id);
    setThinkingNow(next);
    api.setAgentEngine(id, { thinking: next }).catch((err: unknown) => {
      setSwitchedFor(null);
      setError(err instanceof ApiError ? err.message : String(err));
    });
  };

  const send = (text: string, attachments: UploadedAttachment[], preserveDraft = false): void => {
    if (!agentId) return;
    /*
     * `@father …` at the start of a one-to-one message: Agent Father is
     * borrowed for this one message, the way the terminal and Telegram do it —
     * his own turn in his own thread, which the page follows so his answer and
     * any approval it asks for are in front of the owner.
     */
    const borrowed = group ? null : borrowedMaker(text, everyone, agentId);
    if (borrowed) {
      setError(null);
      chatApi.send(borrowed.agent.id, { text: borrowed.rest, attachmentIds: attachments.map((file) => file.artifactId) })
        .then((result) => { window.location.hash = chatRoute(borrowed.agent.id, result.conversationId); })
        .catch((err: unknown) => setError(message(err)));
      return;
    }
    text = withReference(text, group ? null : reference);
    const attachmentIds = attachments.map((file) => file.artifactId);
    /*
     * Said while the agent is working: it goes into the run that is going,
     * not into a queue of its own, so it is drawn where it will be answered —
     * under the turn already in flight, marked for what it is — and it is
     * added to what is on screen rather than replacing it.
     */
    const interjecting = running;
    // The optimistic turn carries its files too, so the thread does not show
    // bare words for a second and then grow a picture.
    const local: ChatMessage = {
      id: `optimistic:${Date.now()}`,
      role: 'user',
      at: new Date().toISOString(),
      blocks: [
        // Files sent alone carry no words, and no empty bubble stands in for them.
        ...(text.trim() === '' ? [] : [{ type: 'text' as const, text }]),
        ...attachments.map((file): ChatMessage['blocks'][number] => ({
          type: 'attachment', artifactId: file.artifactId, filename: file.filename, mime: file.mime, kind: file.kind, sizeBytes: file.sizeBytes,
        })),
      ],
      ...(interjecting ? { speaker: OWNER_INTERJECTION_SPEAKER } : {}),
    };
    setOptimistic((pending) => (interjecting ? [...pending, local] : [local]));
    setError(null);
    setNotice(null);
    setRunning(true);
    (group
      ? chatApi.sendToGroup(group.id, { ...(conversationId ? { conversationId } : {}), text, attachmentIds })
      : chatApi.send(agentId, { ...(conversationId ? { conversationId } : {}), text, attachmentIds }))
      .then(async (result: { conversationId: string; rolledOver?: boolean; queued?: boolean }) => {
        if (selection.current.agentId !== agentId || selection.current.conversationId !== conversationId) return;
        if (!group && reference) {
          clearReference(agentId);
          setReference(null);
        }
        // A room summarises itself across a rollover, and says so. A one-to-one
        // conversation says nothing: the page lands in the new thread, and the
        // carry-over note is in the transcript when there was work to carry.
        setNotice(result.rolledOver === true ? '(New thread — the room had grown long. Where it stopped carries over as a summary.)' : null);
        if (result.conversationId !== conversationId) {
          if (preserveDraft) composer.current?.carryDraftTo(result.conversationId);
          setConversation(null);
          setConversationId(result.conversationId);
        }
        else await refresh(result.conversationId);
        /*
         * A queued message is the server's now, under an id of its own, and
         * the refresh above has just read it back — waiting, inside the turn
         * that took it, or promoted with whatever else was queued into one
         * turn. So this copy goes by *identity*: matching on text cannot
         * survive the joining, and two half-thoughts would otherwise sit on
         * the screen for ever beside the turn they became.
         */
        if (result.queued === true) {
          setOptimistic((pending) => pending.filter((entry) => entry.id !== local.id));
        }
        onConversationOpened?.(agentId, result.conversationId);
      })
      .catch((err: unknown) => {
        setOptimistic((pending) => pending.filter((message) => message.id !== local.id));
        setError(message(err));
        setRunning(false);
      });
  };

  const { openOffers, takingOffer, takeOffer, answeringQuestion, answerQuestion, skipQuestion } = useThreadActions({
    conversation,
    conversationId: conversationId ?? null,
    agentId: agent?.id ?? null,
    now,
    refresh,
    onRunStarted: () => { setNotice(null); setRunning(true); },
    onError: (failed, endedRun) => { setError(failed); if (endedRun) setRunning(false); },
    navigate: (route) => { window.location.hash = route; },
  });

  /**
   * The three dots: open what this agent actually is, or put it away.
   *
   * Fetched on every open rather than cached, because the answer is read from
   * the agent's file and the owner may have just changed it through the maker.
   * A failure says so in the same banner every other failure uses.
   */
  const toggleProfile = (): void => {
    if (!agentId) return;
    if (profile) {
      setProfile(null);
      return;
    }
    setLoadingProfile(true);
    api
      .agentProfile(agentId)
      .then((loaded) => {
        setProfile(loaded);
        setActiveTab(profileTabId(loaded.id));
        if (narrow) onOpenCanvas?.();
      })
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoadingProfile(false));
  };

  /**
   * "Ask @father to change this."
   *
   * The panel is read-only and must stay that way — a grant change is an
   * approval the owner reads, not a control they toggle. So the most this does
   * is walk them to the door: select the maker, and offer the opening sentence
   * the *server* wrote, in the composer, unsent. They still read it, may edit
   * it, and press the key themselves.
   */
  const changeVia = (target: { agentId: string; prompt: string }): void => {
    setDraft({ text: target.prompt, at: Date.now() });
    onSelectAgent(target.agentId);
    if (narrow) onCloseCanvas?.();
  };

  const stop = (): void => {
    if (!conversationId) return;
    chatApi
      .cancel(conversationId)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => {
        setRunning(false);
        setLive([]);
      });
  };

  /*
   * The composer's own commands (docs/dashboard.md, The composer). Each is a
   * thing the page already does: switch agent, open Agent Father with the
   * words, stop the run, or `/quiet` — answered in the words Telegram uses.
   */
  const runCommand = (name: ChatCommandName, arg: string): void => {
    setError(null);
    if (name === 'stop') { stop(); return; }
    if (name === 'use') {
      const wanted = arg.replace(/^@/, '').toLowerCase();
      const target = everyone.find((a) => a.handle.toLowerCase() === wanted || a.id === wanted);
      if (!target) { setNotice(wanted ? `No agent called @${wanted}.` : 'Say who: /use @handle.'); return; }
      setNotice(null);
      onSelectAgent(target.id);
      return;
    }
    if (name === 'new') {
      const maker = everyone.find((a) => a.roles.includes(ROLE_MAKER));
      if (!maker) { setNotice('There is no agent here that makes agents.'); return; }
      if (arg.trim()) leaveDraft(maker.id, `I'd like a teammate for this: ${arg.trim()}`);
      onSelectAgent(maker.id);
      return;
    }
    api.quiet(arg)
      .then((answer) => setNotice(answer.text))
      .catch((err: unknown) => setError(message(err)));
  };

  const startNew = useCallback(() => {
    setConversationId(null);
    setConversation(null);
    setOptimistic([]);
    setRunning(false);
    setError(null);
    setNotice(null);
    setLive([]);
    setAwaiting(new Map());
    setSettledApprovals(new Set());
    setActiveTab(null); setOpenedFiles([]); setFocusedStep(null);
    previousFocus.current = null;
    if (group) {
      // A room needs its row before the first message: the request goes to a conversation, not to a group.
      chatApi.startGroupConversation(group.id).then(({ conversationId: next }) => {
        setConversationId(next);
        if (agentId) onConversationOpened?.(agentId, next);
      }).catch((err: unknown) => setError(message(err)));
      return;
    }
    setFreshFor(threadOwner);
    if (agentId) onConversationOpened?.(agentId, 'new');
  }, [agentId, group, threadOwner, onConversationOpened]);

  useEffect(() => {
    if (newConversationSignal && newConversationSignal !== previousNewSignal.current) {
      previousNewSignal.current = newConversationSignal;
      startNew();
    }
  }, [newConversationSignal, startNew]);

  const onDecided = (action: ApprovalRow): void => {
    if (conversationId) void refresh(conversationId);
    // The rest of the dashboard counts pending approvals; keep it honest.
    void api.overview().catch(() => {});
    if (action.state !== 'pending') {
      setAwaiting((current) => new Map([...current].filter(([, id]) => id !== action.id)));
      setSettledApprovals((current) => (current.has(action.id) ? current : new Set([...current, action.id])));
    }
  };


  /**
   * What an empty thread with one agent shows: its face, what it says it does,
   * and up to three things to ask it.
   *
   * A starter is a *draft*: it fills the composer and puts the caret in it, and
   * the owner presses the key. Nothing on this page may send a message the
   * owner did not send, and a suggestion that fires on one click is exactly
   * that. `{{default}}` in a starter is resolved here, where the roster is.
   */
  const defaultAgentName = everyone.find((a) => a.id === defaultAgentId)?.name ?? null;
  const starters = group ? [] : startersOf(agent, defaultAgentName);
  /*
   * Where the thread stands: *new* (nothing to fetch, or known to hold
   * nothing), *loading* (a conversation is chosen, or being looked for, and has
   * not arrived) or *loaded*. Only a thread that is not loading may say hello.
   */
  const threadLoading = !(conversation && conversation.conversationId === conversationId)
    && !(!conversationId && freshFor !== null && freshFor === threadOwner);
  const opening = threadLoading ? <div className="wb-chat-loading" data-testid="chat-loading" aria-busy="true" /> : !group && agent ? (
    <GradientField quiet still className="wb-chat-field">
    <div className="wb-chat-opening" data-testid="chat-opening">
      <AgentAvatar agents={everyone} id={agent.id} size="xl" />
      <h2 className="wb-chat-hello">{`Hi, I'm ${agent.name}.`}</h2>
      <p className="wb-chat-intro">{introOf(agent)}</p>
      {starters.length > 0 ? (
        <div className="wb-starters" role="group" aria-label={`Things to ask ${agent.name}`}>
          {starters.map((starter) => (
            <button
              type="button"
              key={starter}
              className="wb-starter"
              onClick={() => {
                setDraft({ text: starter, at: Date.now() });
                composer.current?.focus();
              }}
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}
    </div>
    </GradientField>
  ) : null;

  const closeTabs = (ids: readonly string[]): void => {
    const stamps: string[] = [];
    for (const id of ids) {
      if (profile && id === profileTabId(profile.id)) setProfile(null);
      else if (openedFiles.some(file => artifactTabId(file.artifactId) === id)) setOpenedFiles(current => current.filter(file => artifactTabId(file.artifactId) !== id));
      else {
        const tab = renderables.find(item => item.id === id);
        stamps.push(tab ? tabStamp(tab) : id);
      }
    }
    if (stamps.length > 0) canvasTabs.close(stamps);
    if (activeTab !== null && (ids.includes(activeTab) || ids.includes(shownTab ?? ''))) setActiveTab(null);
  };

  const canvas = (
    <Canvas
      renderables={renderables}
      activeId={shownTab}
      onActivate={setActiveTab}
      onClose={(id) => closeTabs([id])}
      onCloseMany={closeTabs}
      touched={canvasTabs.touched}
      turnStartedAt={turnStartedAt}
      timezone={timezone}
      onDecided={onDecided}
      onChangeAgent={changeVia}
      agents={everyone}
      browserPanel={browserTab ? (
        <BrowserView
          key={browserTab.id}
          status={ownStatus}
          error={browser.error}
          reload={browser.reload}
          live={liveBrowser !== null}
          agentName={agent?.name ?? 'The agent'}
          timezone={timezone}
          paused={pausedTab && browserStatus?.stop ? browserStatus.stop : null}
        />
      ) : null}
      browserMenu={browserTab ? <BrowserMenu status={browserStatus} timezone={timezone} reload={browser.reload} /> : null}
      descriptors={descriptors}
      grantedTools={group ? members.flatMap((member) => member.tools ?? []) : agent?.tools ?? []}
      {...(agent ? { agentName: agent.name } : {})}
      loading={threadLoading}
      {...(!group && agent ? { face: <AgentAvatar agents={everyone} id={agent.id} size="xl" />, cardFace: <AgentAvatar agents={everyone} id={agent.id} size="sm" /> } : {})}
    />
  );

  /*
   * The header's freed space.
   *
   * With the switcher gone, what the owner cannot otherwise know goes here:
   * whether this is a fresh conversation or a long one, and whether the next
   * message will start a new thread because this one has aged out. That is not
   * decoration — it is the one piece of state the transcript itself hides.
   */
  // The conversation's own title, as the kit's head writes it: what the owner
  // first asked, or "New conversation" before anything is said.
  const firstAsk = [...(conversation?.messages ?? []), ...optimistic]
    .find((m) => m.role === 'user')?.blocks.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text.trim();
  const headTitle = firstAsk ? firstAsk.split('\n')[0]! : 'New conversation';
  const line = conversationLine({
    lifetime: conversation?.lifetime ?? null,
    startedAt: conversation?.startedAt ?? null,
    now,
    timezone,
  });

  return (
    <>
      <section
        className="wb-chat"
        ref={columnRef}
        style={{ ...(narrow || width === null ? {} : { [WIDTH_VAR]: `${width}px` }), "--chat-text-scale": textSize / 13 } as CSSProperties}
        data-sized={!narrow && width !== null ? 'true' : undefined}
        data-testid="chat-column"
        data-dropping={dropping || undefined}
        onDragEnter={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dropDepth.current += 1;
          setDropping(true);
        }}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!carriesFiles(event)) return;
          dropDepth.current = Math.max(0, dropDepth.current - 1);
          if (dropDepth.current === 0) setDropping(false);
        }}
        onDrop={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dropDepth.current = 0;
          setDropping(false);
          if (agentId) composer.current?.addFiles(event.dataTransfer.files);
        }}
      >
        {/* The whole column is the target; the overlay says so the moment a
            file crosses it, and names where it will go. */}
        {dropping ? (
          <div className="wb-drop" aria-hidden="true">
            <div className="wb-drop-card">
              <DropIcon />
              <strong>Drop to attach</strong>
              <span>{agent ? `It goes with your next message to ${agent.name}` : 'Pick an agent first'}</span>
            </div>
          </div>
        ) : null}
        <header className="wb-chat-head" data-testid="chat-head" {...(!group && agent ? accentAttrs(accentOf(agent)) : {})}>
          <div className="wb-head-row">
            {/* Whose column this is: the same face as in the roster, then the
                name, then the one fact the transcript hides — how old it is. */}
            {group ? (
              <span className="wb-head-face" aria-hidden="true">{groupFaces}</span>
            ) : agent ? <a className="wb-head-face" href={agentRoute(agent.id)} aria-label={`${agent.name}'s page`}><AgentAvatar agents={everyone} id={agent.id} /></a> : null}
            <div className="wb-head-text">
              {group ? (
                <span className="wb-head-title">{group.name}</span>
              ) : (
                /* The kit's head: what this conversation is about on top, and
                   whose it is beneath — the name, the handle you type to reach
                   it, and how old the thread is. */
                <span className="wb-head-title" title={headTitle}>{headTitle}</span>
              )}
              <span className="wb-head-meta" data-tone={line.tone} title={group ? `${members.map((m) => m.name).join(', ')}. Coordinator: ${agent?.name ?? group.coordinator}.` : line.title}>
                {group ? `${members.map((m) => m.name).join(', ')} · ${line.text}` : agent ? (
                  <>
                    <a className="wb-head-name" href={agentRoute(agent.id)} title={`${agent.name}'s page`}>{agent.name}</a>
                    {' '}<span className="wb-head-handle">@{agent.handle}</span>
                    {` · ${line.tone === 'quiet' && line.text === 'New conversation' ? `on ${thisMachine}` : line.text}`}
                  </>
                ) : 'No agent'}
              </span>
            </div>
            <button
              className="ui-icon-btn wb-head-more"
              data-size="sm"
              aria-label="New chat"
              title="New chat"
              disabled={!agentId}
              onClick={() => { setHistoryOpen(false); startNew(); }}
            >
              <Icon name="plus" size={16} />
            </button>
            <button
              className="ui-icon-btn wb-head-more"
              aria-label="History"
              title="Earlier conversations"
              aria-expanded={historyOpen}
              data-open={historyOpen ? 'true' : undefined}
              disabled={!agentId}
              onClick={() => setHistoryOpen(value => !value)}
            >
              <HistoryIcon />
            </button>
            {narrow ? (
              <button className="ui-btn" onClick={onOpenCanvas} disabled={renderables.length === 0}>
                Canvas{renderables.length > 0 ? ` (${renderables.length})` : ''}
              </button>
            ) : null}
            {/*
              Everything else about this agent, behind one labelled menu: what
              it can do (a panel beside the work), how it is set up (its page),
              and its page itself. One place, with words, instead of two icons
              that each open something different.
            */}
            {group ? (
              /*
               * The group's menu is about the group: who is in it, its name,
               * its history, and deleting it. A member's page is a row inside
               * Members, never what this menu is for. Same order as an
               * agent's: what it is, how it is set up, then — under a
               * hairline — what takes something away.
               */
              <HeadMenu
                readingControls={readingControls}
                disabled={false}
                label="More about this group"
                title={group.name}
                sub={namesSentence(members.map((m) => m.name))}
                face={groupFaces}
                items={[
                  { label: 'Members', hint: `${group.members.length} agents · ${agent ? `${agent.name} coordinates` : 'no coordinator'}`, testId: 'group-members', onSelect: () => onGroupAction?.('members') },
                  { label: 'Rename…', hint: 'What this team is for', testId: 'group-rename', onSelect: () => onGroupAction?.('rename') },
                  'separator',
                  { label: 'Clear history…', hint: 'Keeps the group and its members', testId: 'group-clear', onSelect: () => onGroupAction?.('clear') },
                  { label: 'Delete group…', hint: 'With its history; the agents stay', tone: 'critical', testId: 'group-delete', onSelect: () => onGroupAction?.('delete') },
                ]}
              />
            ) : (
              <HeadMenu
                readingControls={readingControls}
                disabled={!agentId}
                label="More about this agent"
                title={agent?.name ?? 'Agent'}
                {...(agent ? { sub: `@${agent.handle}`, face: <AgentAvatar agents={everyone} id={agent.id} size="sm" /> } : {})}
                items={[
                  { label: profile ? 'Close properties' : 'Properties', hint: 'What this agent can do, on the Canvas', testId: 'agent-properties', disabled: loadingProfile, onSelect: toggleProfile },
                  ...(agent ? [
                    { label: 'Set up', hint: 'Identity, model and access', href: agentRoute(agent.id, 'setup') },
                    { label: 'Open agent page', hint: 'Profile, activity and setup', href: agentRoute(agent.id) },
                  ] : []),
                ]}
              />
            )}
          </div>
          {/*
            Two rails plus a conversation plus a canvas do not fit a phone. Below
            the breakpoint the agent rail lies down here instead of taking a
            second 56px column out of a 420px screen: every face is still one
            tap away, every badge is still visible, and the canvas keeps its
            width. Collapsing it back into a menu would have put "someone needs
            you" behind a chevron again, which is the thing this change removed.
          */}
          {agentsInHeader ? (
            <AgentRail
              agents={agents}
              currentId={agentId}
              attention={attention}
              onSelect={onSelectAgent}
              orientation="horizontal"
              {...(workingId ? { working: new Set([workingId]) } : {})}
            />
          ) : null}
        </header>
        {!group && agent ? <NewAgentStrip key={agent.id} agentId={agent.id} /> : null}
        {historyOpen && agentId ? <ConversationHistory agentId={agentId} {...(group ? { groupId: group.id } : {})} currentId={conversationId} timezone={timezone}
          onNew={() => { setHistoryOpen(false); startNew(); }}
          onSelect={id => {
            if (id === conversationId) { setHistoryOpen(false); return; }
            setHistoryOpen(false); setConversation(null); setOptimistic([]); setRunning(false); setActiveTab(null); setError(null); setNotice(null); setOpenedFiles([]);
            setConversationId(id);
            onConversationOpened?.(agentId, id, false);
          }} /> : null}

        {agentId && conversationId ? <HostControls key={`${agentId}:${conversationId}`} agentId={agentId} conversationId={conversationId} /> : null}

        {error ? <div className="wb-chat-notice"><ErrorBanner message={error} /></div> : null}

        {notice ? (
          <div className="wb-chat-notice" data-testid="chat-notice">
            {notice}
          </div>
        ) : null}

        {conversation?.carriedOver ? (
          <CarryOverNote
            key={conversation.conversationId}
            text={conversation.carriedOver}
            onDelete={async () => {
              const id = conversation.conversationId;
              await chatApi.deleteCarryOver(id);
              setConversation((current) => {
                if (!current || current.conversationId !== id) return current;
                const { carriedOver: _gone, ...rest } = current;
                return rest;
              });
            }}
          />
        ) : null}

        <MessageList
          timezone={timezone}
          mediaTools={mediaTools}
          messages={[...(conversation?.messages ?? []), ...optimistic]}
          live={live}
          now={now}
          working={running}
          partial={partial}
          agents={everyone}
          {...(conversation?.runs ? { runs: conversation.runs } : {})}
          {...(agentId && conversationId ? { onContinue: () => send('continue', []) } : {})}
          {...(group ? { speakers: everyone, coordinatorId: group.coordinator } : {})}
          {...(runningAgentId ? { workingAs: everyone.find((a) => a.id === runningAgentId)?.name ?? runningAgentId } : {})}
          onOpenFile={openFile}
          onReadAloud={(messageId, text) => {
            setVoiceNote(null);
            void speakReply(text, conversationId ?? undefined, messageId).then((note) => { if (note) setVoiceNote(note); });
          }}
          onOpen={(toolUseId) => {
            /*
             * A browser call has no tab of its own while the Browser panel is
             * up. Clicking its row goes to the step it made, on the panel that
             * shows the screen it made it on — not to a second copy of the
             * same call.
             */
            if (browserTab) {
              const step = stepFor([...(conversation?.messages ?? []), ...optimistic], toolUseId);
              if (step) {
                setFocusedStep(step);
                setActiveTab(browserTab.id);
                if (narrow) onOpenCanvas?.();
                return;
              }
            }
            const holding = transcriptTabs.current.find(item => item.id === toolUseId || (item.versions ?? []).some(version => version.id === toolUseId));
            canvasTabs.reopen(holding ? [toolUseId, tabStamp(holding)] : [toolUseId]);
            setActiveTab(toolUseId);
            if (narrow) onOpenCanvas?.();
          }}
          {...(agent ? { agentName: agent.name, agentId: agent.id } : {})}
          {...(opening ? { empty: opening } : {})}
          emptyHint={group
            ? `Give the team a task once; ${agent ? agent.name : 'the coordinator'} brings members in. @ addresses one of them.`
            : agent ? `Nothing here yet. Ask ${agent.name} for something.` : 'Loading agents…'}
        >

        </MessageList>

        <OfferButtons offers={openOffers} disabled={takingOffer !== null} onTake={takeOffer} />

        {roomProblem ? (
          <div className="wb-composer-blocked" data-testid="group-problem" data-kind={roomProblem.kind}>
            <Notice tone={roomBlocked ? 'warning' : undefined} role="status">
              <span>
                {roomProblem.text}{' '}
                <button type="button" className="wb-link-btn" onClick={() => onGroupAction?.('members')}>{roomProblem.action}</button>
              </span>
            </Notice>
          </div>
        ) : null}
        {blocked ? (
          /*
           * No brain, no composer. An agent whose account is missing, disabled
           * or unconfigured cannot answer, and a composer that takes the
           * owner's words and loses them is worse than one that is not there.
           * The server refuses the same turn with the same reason, so this is
           * the door rather than the only lock.
           */
          <div className="wb-composer-blocked" data-testid="composer-blocked">
            <Notice tone="warning" role="status">
              {blocked}{' '}
              <a href={settingsRoute(blockedFix.section)}>{blockedFix.label}</a>
            </Notice>
          </div>
        ) : null}
        {/*
          * A question first, then the approvals: a pending question is always
          * answerable from the chat, whatever else waits. Both stand in the
          * composer's place.
          */}
        {blocked ? null : conversation?.question && signInCard ? (
          /* An agent's sign-in card: the fields as inputs, posted to the secrets API and never into the thread. */
          <SecretRequestDock
            key={conversation.question.id}
            question={conversation.question}
            card={signInCard}
            phone={narrow}
            container={columnRef.current}
            page={ownStatus}
            disabled={running}
            onSettled={() => {
              if (conversationId) void refresh(conversationId);
              browser.reload();
            }}
          />
        ) : conversation?.question && browserCard ? (
          <BrowserAsk
            key={conversation.question.id}
            card={browserCard}
            disabled={answeringQuestion || running}
            onAnswer={answerQuestion}
            site={browserStatus?.needsOwner?.site ?? browserStatus?.page?.url?.replace(/^https?:\/\/(www\.)?([^/]+).*$/, '$2')}
          />
        ) : conversation?.question ? (
          <QuestionPicker
            key={conversation.question.id}
            question={conversation.question}
            disabled={answeringQuestion || running}
            onAnswer={answerQuestion}
            onSkip={skipQuestion}
          />
        ) : null}
        {!blocked && docked.length > 0 ? (
          <ApprovalDock
            approvals={docked}
            timezone={timezone}
            now={now}
            version={conversation}
            onDecided={onDecided}
            onSay={(text) => send(text, [])}
            onOpenFull={(toolUseId) => { setActiveTab(toolUseId); if (narrow) onOpenCanvas?.(); }}
            phone={narrow}
            onSignInMyself={() => {
              const sessionId = ownStatus?.session?.id;
              if (sessionId) void api.browserControl('takeover', sessionId).catch(() => undefined).finally(browser.reload);
            }}
          />
        ) : null}
        {blocked || roomBlocked ? null : (
          /*
           * Hidden, not unmounted, while a question or an approval stands in
           * its place: the half-written line and its files are exactly where
           * the owner left them when it comes back.
           */
          <div hidden={docked.length > 0 || (Boolean(conversation?.question) && !signInCard)} data-testid="composer-slot">
          {!group && reference ? <section className="wb-chat-reference" aria-label="Story reference">
            <div className="wb-chat-reference-head">
              <div><small>Asking about</small><p><strong>{reference.title}</strong></p></div>
              <button type="button" className="ui-btn" onClick={() => { if (agentId) clearReference(agentId); setReference(null); }}>Remove reference</button>
            </div>
            <details><summary>Context sent with your question</summary><p>{reference.text}</p></details>
            <div className="wb-starters" role="group" aria-label="Questions about this story">
              {reference.suggestions.map((suggestion) => (
                <button key={suggestion} type="button" className="wb-starter" disabled={running || !agentId}
                  title="Send this question" onClick={() => send(suggestion, [], true)}>
                  {suggestion} <Icon name="send" size={16} />
                </button>
              ))}
            </div>
          </section> : null}
          <Composer
            ref={composer}
            disabled={!agentId}
            running={running}
            onSend={send}
            onStop={stop}
            agentName={group ? group.name : (agent?.name ?? 'the agent')}
            draft={draft}
            history={ownHistory}
            threadKey={conversationId ?? (group ? `group:${group.id}` : agentId)}
            model={group ? null : (agent?.model ?? null)}
            chrome={chromeChip}
            setupHref={group ? null : (agent ? agentRoute(agent.id, 'setup', 'brain') : null)}
            thinking={thinking}
            {...(!group && agent && thinkingIsHonoured(effectiveProviderKind(agent, providerAccounts.data)) ? { onThinking: switchThinking } : {})}
            {...(group
              ? { mentions: members.map((m) => ({ id: m.id, handle: m.handle, name: m.name })), team: { agents: everyone, selfId: '' } }
              : agentId ? { team: { agents: everyone, selfId: agentId } } : {})}
            onCommand={runCommand}
            onOpenFile={openFile}
            conversationId={conversationId ?? null}
            readAloud={readAloud}
            onReadAloud={switchReadAloud}
          />
          {voiceNote ? <p className="wb-voice-note" role="status">{voiceNote}</p> : null}
          </div>
        )}
      </section>

      {narrow ? (
        canvasOpen ? (
          <div className="wb-sheet" role="dialog" aria-label="Canvas">
            <div className="wb-sheet-head">
              <strong>Canvas</strong>
              <button className="ui-btn" onClick={onCloseCanvas}>
                Close
              </button>
            </div>
            {canvas}
          </div>
        ) : null
      ) : (
        <>
          <Splitter columnRef={columnRef} width={width} onChange={setWidth} />
          {canvas}
        </>
      )}
    </>
  );
}

function byRecency(a: { lastMessageAt: string | null; createdAt?: string; startedAt?: string | null }, b: { lastMessageAt: string | null; createdAt?: string; startedAt?: string | null }): number {
  return Date.parse(b.lastMessageAt ?? b.startedAt ?? b.createdAt ?? '') - Date.parse(a.lastMessageAt ?? a.startedAt ?? a.createdAt ?? '');
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
}

function transcriptContains(conversation: ChatConversation, optimistic: ChatMessage): boolean {
  const wanted = optimistic.blocks.find((block) => block.type === 'text')?.text.trim();
  if (!wanted) return true;
  // The server has it once the newest user message *with words* says what we
  // sent. Tool results also travel as user messages, without any text, so
  // those are skipped rather than mistaken for the owner's turn. No clock
  // comparison: the two clocks are not the same clock.
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.blocks.find((block) => block.type === 'text');
    if (!text) continue;
    return text.text.trim() === wanted;
  }
  return false;
}

/**
 * Only a drag that carries files is ours. Dragging selected text across the
 * column is the browser's business and must keep working as it always has.
 */
function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes('Files'));
}

function DropIcon(): JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4v13M8.5 11.5 14 17l5.5-5.5" />
      <path d="M5 19.5v2a2.5 2.5 0 0 0 2.5 2.5h13a2.5 2.5 0 0 0 2.5-2.5v-2" />
    </svg>
  );
}





export { DRAFT_KEY, leaveDraft } from './draft';

/** A clock face with its hand: what came before. */
function HistoryIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
      <path d="M2.4 2.6v2.6h2.6M8 5.2V8l2 1.3" />
    </svg>
  );
}

/** Three dots, vertical: this thing has more to say about itself. */
function MoreIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <circle cx="8" cy="3.4" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="8" cy="12.6" r="1.35" />
    </svg>
  );
}

interface HeadMenuItem {
  label: string;
  hint?: string;
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  testId?: string;
  /** What takes something away: drawn in the critical ink, last, under a hairline. */
  tone?: 'critical';
}

/**
 * The header's one menu, an agent's or a group's. Plain markup rather than a
 * menu library: a click outside or Escape closes it, and a test can open it
 * with a click. `'separator'` draws the hairline before what takes something
 * away. On a phone the stylesheet lays the same list out as a sheet from the
 * bottom, with whose menu it is on top and Cancel under the rows.
 */
function HeadMenu({ items, disabled, label, title, sub, face, readingControls }: {
  readingControls?: JSX.Element;
  items: Array<HeadMenuItem | 'separator'>;
  disabled: boolean;
  label: string;
  /** The sheet's head on a phone: the name, one quiet line, the face. */
  title: string;
  sub?: string;
  face?: JSX.Element | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const key = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); };
  }, [open]);
  const row = (item: HeadMenuItem): JSX.Element => {
    const body = (
      <>
        <span className="ui-menu-item-text">{item.label}</span>
        {item.hint ? <span className="ui-menu-item-hint">{item.hint}</span> : null}
      </>
    );
    return item.href ? (
      <a key={item.label} className="ui-menu-item" role="menuitem" href={item.href} data-tone={item.tone} onClick={() => setOpen(false)}>{body}</a>
    ) : (
      <button
        key={item.label}
        className="ui-menu-item"
        role="menuitem"
        data-testid={item.testId}
        data-tone={item.tone}
        disabled={item.disabled}
        onClick={() => { setOpen(false); item.onSelect?.(); }}
      >
        {body}
      </button>
    );
  };
  return (
    <div className="wb-head-menu" ref={root}>
      <button
        className="ui-icon-btn wb-head-more"
        data-testid="chat-menu"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open ? 'true' : undefined}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <>
          <div className="wb-head-menu-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="ui-menu wb-head-menu-list" role="menu" aria-label={title}>
            <div className="wb-head-menu-head" aria-hidden="true">
              {face}
              <span className="wb-head-menu-heading">
                <span className="wb-head-menu-title">{title}</span>
                {sub ? <span className="wb-head-menu-sub">{sub}</span> : null}
              </span>
            </div>
            {readingControls}
            {items.map((item, index) => item === 'separator' ? <div key={`sep-${index}`} className="ui-menu-sep" role="separator" /> : row(item))}
            <button type="button" className="ui-btn wb-head-menu-cancel" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export { askedByLine };

/** Said once per page load: why replies are not read aloud. */
let voiceNoted = false;
const VOICE_NOTE_REASONS = new Set(['missing', 'unconfigured', 'not-english']);

/**
 * Speak a finished reply and play it, interrupting any other. A refusal the
 * owner can act on (no plugin, nothing set up, a language the voice cannot
 * speak) comes back as a sentence, once per page load; anything else is
 * quiet — the text is on the screen either way.
 */
export async function speakReply(
  text: string,
  conversationId: string | undefined,
  /** A reply's own Read aloud: its message id, and the refusal is said every time it is asked for. */
  key: string | null = null,
): Promise<string | null> {
  const claim = claimPlayback(key);
  try {
    const said = await chatApi.say({ text, ...(conversationId ? { conversationId } : {}) });
    // Stopped, or another reply started, while the words were being spoken.
    if (!playbackCurrent(claim)) return null;
    await playAudio(said.audioUrl, said.mime, key);
    return null;
  } catch (err) {
    if (playbackCurrent(claim)) stopPlayback();
    const reason = err instanceof ApiError && err.detail && typeof err.detail === 'object' ? (err.detail as { reason?: unknown }).reason : undefined;
    if (typeof reason === 'string' && VOICE_NOTE_REASONS.has(reason) && (key !== null || !voiceNoted)) {
      voiceNoted = true;
      return (err as ApiError).message;
    }
    return null;
  }
}

/** For tests: forget that the note was said. */
export function resetVoiceNote(): void {
  voiceNoted = false;
}

/**
 * `@father …` leading a one-to-one message, when the agent here is not the
 * maker: who is borrowed and what they are asked. Null for any other message.
 */
export function borrowedMaker(text: string, agents: readonly ChatAgent[], selfId: string): { agent: ChatAgent; rest: string } | null {
  const lead = leadingMention(text);
  if (!lead || lead.rest === '') return null;
  const maker = agents.find((a) => a.roles.includes(ROLE_MAKER));
  if (!maker || maker.id === selfId || maker.handle.toLowerCase() !== lead.handle) return null;
  return { agent: maker, rest: lead.rest };
}
