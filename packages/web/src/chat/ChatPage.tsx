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
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ApiError, api, chatApi, type AgentProfile, type ApprovalRow } from '../api';
import { Canvas } from '../canvas/Canvas';
import { Envelope } from '../canvas/views/Envelope';
import { inspectToolCall, renderablesFrom } from '../canvas/renderables';
import { profileRenderable, profileTabId } from './properties';
import { useAsync } from '../ui';
import { BrowserPanel } from '../views/Browser';
import { HostControls } from '../views/HostControls';
import { ErrorBanner, Notice } from '../ui';
import { conversationBrowser } from './browser';
import { ConversationHistory } from './ConversationHistory';
import { readDismissedTabs, storeDismissedTabs } from './dismissed-tabs';
import { agentRoute, settingsRoute } from '../routes';
import type { Renderable, ViewDescriptor } from '../canvas/types';
import { AgentRail } from '../shell/AgentRail';
import { AgentAvatar } from '../ui';
import { cannotRunFix, cannotRunSentence, introOf, startersOf, type AgentAttention, type AgentGroups } from '../shell/roster';
import { Composer, type ComposerDraft, type ComposerHandle } from './Composer';
import { artifactRenderable, artifactTabId, type AttachmentBlock } from './attachments';
import { QuestionPicker } from './QuestionPicker';
import { conversationLine } from './lifetime';
import { MessageList, type LiveCall, type LiveTurnView } from './MessageList';
import { openChatStream } from './stream';
import type { ChatAgent, ChatConversation, ChatEvent, ChatMessage, GroupView, UploadedAttachment } from './types';

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 440;
const WIDTH_KEY = 'buddi.chatWidth';

export interface ChatPageProps {
  requestedConversationId?: string | undefined;
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
  onSelectAgent: (agentId: string) => void;
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

export function ChatPage({
  timezone,
  agents,
  agentId,
  defaultAgentId = null,
  group = null,
  onSelectAgent,
  attention,
  agentsInHeader,
  narrow,
  canvasOpen,
  onOpenCanvas,
  onCloseCanvas,
  newConversationSignal,
  requestedConversationId,
  onConversationOpened,
}: ChatPageProps): JSX.Element {
  const [descriptors, setDescriptors] = useState<ViewDescriptor[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  /** The owner's accepted send, shown before the run has persisted it. */
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveCall[]>([]);
  /** The answer as it is being written, ahead of the transcript. */
  const [partial, setPartial] = useState<LiveTurnView | null>(null);
  const [running, setRunning] = useState(false);
  const [awaiting, setAwaiting] = useState<Map<string, string>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [dismissedTabs, setDismissedTabs] = useState(readDismissedTabs);
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
  const dismissed = dismissedTabs[conversationId ?? ''] ?? [];
  const [error, setError] = useState<string | null>(null);
  /** "(New conversation — …)". Said once, above the thread it explains. */
  const [notice, setNotice] = useState<string | null>(null);
  const [takingOffer, setTakingOffer] = useState<string | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [width, setWidth] = useState(readWidth);
  /*
   * The properties panel, when the owner has asked for one. It is held here
   * rather than fetched by the canvas because it belongs to the *agent*, not to
   * the conversation: it survives a new thread, and it is dropped the moment
   * the owner switches to somebody else — a panel headed "Ledger" while the
   * conversation is with Scout would be a lie the tab strip cannot correct.
   */
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  /** A line the panel put in the composer's mouth. Never sent for the owner. */
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
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
    const left = takeDraft(agentId);
    if (left) setDraft({ text: left, at: Date.now() });
  }, [agentId]);

  const everyone = [...agents.top, ...agents.middle, ...agents.bottom];
  const agent = everyone.find((c) => c.id === agentId) ?? null;
  const members = group ? group.members.map((id) => everyone.find((a) => a.id === id)).filter((a): a is ChatAgent => Boolean(a)) : [];
  /** Who is speaking right now in a room, from the run's own event. */
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);

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
    setOptimistic([]);
    setError(null);
    setRunning(false);
    setActiveTab(null); setOpenedFiles([]);
    setHistoryOpen(false);
    // Whoever this is now, it is not who the open panel described.
    setProfile(null);
    if (requestedConversationId) {
      if (requestedConversationId !== 'new') setConversationId(requestedConversationId);
      return () => { cancelled = true; };
    }
    (group ? chatApi.groupConversations(group.id) : chatApi.conversations(agentId))
      .then((list) => {
        if (cancelled) return;
        const latest = [...(list.conversations ?? [])].sort(byRecency)[0];
        if (latest) {
          setConversationId(latest.id);
          onConversationOpened?.(agentId, latest.id);
        }
      })
      .catch(() => {
        /* A fresh install has no conversations. That is not an error. */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, group?.id, requestedConversationId, onConversationOpened]);

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
            setPartial({ runId, turn, text, thinking, thinkingStartedAt: thinking ? startedAt : null, textStartedAt: text ? startedAt : null, settled: false });
            break;
          }
          case 'live.settle': {
            const runId = str(event.data['runId']) ?? '';
            const turn = Number(event.data['turn'] ?? 0);
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
  const browserTab = conversationBrowser(browser.error ? undefined : browser.data, agentId, conversationId);
  const browserTabId = browserTab?.id ?? null;

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
  const renderables: Renderable[] = useMemo(() => {
    const fromTranscript = renderablesFrom({
      messages: conversation?.messages ?? [],
      descriptors,
      awaiting,
    });
    const items = fromTranscript.filter(item => item.source === 'approval' || !dismissed.includes(item.id));
    if (activeTab && !dismissed.includes(activeTab) && !items.some(item => item.id === activeTab)) {
      const inspection = inspectToolCall(conversation?.messages ?? [], activeTab);
      if (inspection) items.push(inspection);
    }
    if (browserTab) items.push(browserTab);
    for (const file of openedFiles) items.push(artifactRenderable(file));
    return profile ? [...items, profileRenderable(profile)] : items;
  }, [conversation, descriptors, awaiting, profile, browserTabId, activeTab, dismissedTabs, conversationId, openedFiles]);

  const inlineApprovals = useMemo(
    () => renderables.filter((item) => item.source === 'approval'),
    [renderables],
  );
  const inlineApproval = inlineApprovals.at(-1) ?? null;

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
      if (candidate?.substantial) return candidate.id;
    }
    return null;
  }, [renderables]);

  const previousFocus = useRef<string | null>(null);
  const lastId = renderables[renderables.length - 1]?.id ?? null;
  useEffect(() => {
    if (focusId && focusId !== previousFocus.current) {
      previousFocus.current = focusId;
      setActiveTab(focusId);
      return;
    }
    // Nothing substantial has ever arrived: show the newest tab rather than none.
    if (activeTab === null && lastId) setActiveTab(lastId);
  }, [focusId, activeTab, lastId]);

  // Select once when a session appears. Polls must not steal a chart the owner
  // selected, and a pending approval remains more important than the preview.
  const previousBrowser = useRef<string | null>(null);
  useEffect(() => {
    if (browserTabId !== previousBrowser.current) {
      previousBrowser.current = browserTabId;
      if (browserTabId && !inlineApproval) setActiveTab(browserTabId);
    }
  }, [browserTabId, inlineApproval]);

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
  // Which door that sentence opens: Plugins when a plugin is what is missing,
  // Model accounts otherwise.
  const blockedFix = cannotRunFix(group ? null : agent);

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

  const send = (text: string, attachments: UploadedAttachment[]): void => {
    if (!agentId) return;
    const attachmentIds = attachments.map((file) => file.artifactId);
    // The optimistic turn carries its files too, so the thread does not show
    // bare words for a second and then grow a picture.
    const local: ChatMessage = {
      id: `optimistic:${Date.now()}`,
      role: 'user',
      at: new Date().toISOString(),
      blocks: [
        { type: 'text', text },
        ...attachments.map((file): ChatMessage['blocks'][number] => ({
          type: 'attachment', artifactId: file.artifactId, filename: file.filename, mime: file.mime, kind: file.kind, sizeBytes: file.sizeBytes,
        })),
      ],
    };
    setOptimistic([local]);
    setError(null);
    setNotice(null);
    setRunning(true);
    (group
      ? chatApi.sendToGroup(group.id, { ...(conversationId ? { conversationId } : {}), text, attachmentIds })
      : chatApi.send(agentId, { ...(conversationId ? { conversationId } : {}), text, attachmentIds }))
      .then((result: { conversationId: string; boundary?: { note: string; previousConversationId: string }; rolledOver?: boolean }) => {
        if (selection.current.agentId !== agentId || selection.current.conversationId !== conversationId) return;
        // The conversation the page was in had ended, and this message opened a
        // new one. The empty thread is explained rather than surprising.
        setNotice(result.boundary?.note ?? (result.rolledOver ? '(New thread — the room had grown long. Where it stopped carries over as a summary.)' : null));
        if (result.conversationId !== conversationId) {
          setConversation(null);
          setConversationId(result.conversationId);
        }
        else void refresh(result.conversationId);
        onConversationOpened?.(agentId, result.conversationId);
      })
      .catch((err: unknown) => {
        setOptimistic((pending) => pending.filter((message) => message.id !== local.id));
        setError(message(err));
        setRunning(false);
      });
  };

  /**
   * The owner clicked one of the things this turn offered.
   *
   * It is the Telegram tap, in a browser: the request names an **id**, the
   * server claims that row once and runs the prompt the agent wrote. Nothing
   * here can carry a prompt of its own, and nothing about the run it starts is
   * shortened — an effect still comes back as the approval it always was.
   */
  const takeOffer = (id: string): void => {
    setError(null);
    setTakingOffer(id);
    api
      .takeOffer(id)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => {
        setTakingOffer(null);
        if (conversationId) void refresh(conversationId);
      });
  };

  const answerQuestion = (answer: string, optionId?: string): void => {
    const question = conversation?.question;
    if (!question) return;
    setError(null);
    setAnsweringQuestion(true);
    setRunning(true);
    chatApi
      .answerQuestion(question.id, { answer, ...(optionId ? { optionId } : {}) })
      .then(() => {
        if (conversationId) return refresh(conversationId);
      })
      .catch((err: unknown) => {
        setError(message(err));
        setRunning(false);
      })
      .finally(() => setAnsweringQuestion(false));
  };

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

  const startNew = useCallback(() => {
    setConversationId(null);
    setConversation(null);
    setOptimistic([]);
    setRunning(false);
    setError(null);
    setNotice(null);
    setLive([]);
    setAwaiting(new Map());
    setActiveTab(null); setOpenedFiles([]);
    previousFocus.current = null;
    if (group) {
      // A room needs its row before the first message: the request goes to a conversation, not to a group.
      chatApi.startGroupConversation(group.id).then(({ conversationId: next }) => {
        setConversationId(next);
        if (agentId) onConversationOpened?.(agentId, next);
      }).catch((err: unknown) => setError(message(err)));
      return;
    }
    if (agentId) onConversationOpened?.(agentId, 'new');
  }, [agentId, group, onConversationOpened]);

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
    if (action.state !== 'pending') setAwaiting((current) => new Map([...current].filter(([, id]) => id !== action.id)));
  };

  /* ---- the split ---- */

  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (!dragging.current) return;
      const next = Math.max(MIN_WIDTH, Math.min(720, event.clientX - 52));
      setWidth(next);
    };
    const onUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* a private window keeps the default; nothing breaks */
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [width]);

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
  const opening = !group && agent ? (
    <div className="wb-chat-opening" data-testid="chat-opening">
      <AgentAvatar agents={everyone} id={agent.id} size="xl" />
      <p className="wb-chat-empty">{introOf(agent)}</p>
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
  ) : null;

  /**
   * What an empty canvas says, in the agent's own words rather than in a
   * domain's. The page knows no domains: the sentence comes from the agent
   * file, and what could land here comes from the installed view descriptors.
   */
  const madeHere = agent
    ? `${introOf(agent)} What ${agent.name} makes appears here, beside the answer rather than inside it.`
    : 'Ask for something. Whatever the run looks at is drawn here, beside the answer rather than inside it.';

  const canvas = (
    <Canvas
      renderables={renderables}
      activeId={activeTab}
      onActivate={setActiveTab}
      onClose={(id) => {
        if (profile && id === profileTabId(profile.id)) setProfile(null);
        else if (openedFiles.some(file => artifactTabId(file.artifactId) === id)) setOpenedFiles(current => current.filter(file => artifactTabId(file.artifactId) !== id));
        else if (conversationId) setDismissedTabs(current => {
          const next = { ...current, [conversationId]: [...new Set([...(current[conversationId] ?? []), id])] };
          storeDismissedTabs(next); return next;
        });
        if (activeTab === id) setActiveTab(null);
      }}
      timezone={timezone}
      onDecided={onDecided}
      onChangeAgent={changeVia}
      agents={everyone}
      browserPanel={browserTab ? <BrowserPanel key={browserTab.id} data={browser.data} error={browser.error} reload={browser.reload} compact /> : null}
      descriptors={descriptors}
      {...(agent ? { agentName: agent.name } : {})}
      emptyHint={conversation ? `Nothing in this conversation has produced a view yet. ${madeHere}` : madeHere}
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
        style={narrow ? undefined : { width }}
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
        <header className="wb-chat-head" data-testid="chat-head">
          <div className="wb-head-row">
            {/* Whose column this is: the same face as in the roster, then the
                name, then the one fact the transcript hides — how old it is. */}
            {group ? (
              <span className="wb-head-face wb-head-group" aria-hidden="true">
                {members.slice(0, 3).map((m) => <AgentAvatar key={m.id} agents={everyone} id={m.id} size="sm" />)}
              </span>
            ) : agent ? <a className="wb-head-face" href={agentRoute(agent.id)} aria-label={`${agent.name}'s page`}><AgentAvatar agents={everyone} id={agent.id} /></a> : null}
            <div className="wb-head-text">
              {group ? (
                <span className="wb-head-title">{group.name}</span>
              ) : agent ? <a className="wb-head-title" href={agentRoute(agent.id)} title={`${agent.name}'s page`}>{agent.name}</a> : <span className="wb-head-title">No agent</span>}
              <span className="wb-head-meta" data-tone={line.tone} title={group ? `${members.map((m) => m.name).join(', ')}. Coordinator: ${agent?.name ?? group.coordinator}.` : line.title}>
                {group ? `${members.map((m) => m.name).join(', ')} · ${line.text}` : line.text}
              </span>
            </div>
            <button className="ui-btn" data-variant="accent" disabled={!agentId} onClick={() => { setHistoryOpen(false); startNew(); }}>New chat</button>
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
            <HeadMenu
              disabled={!agentId}
              items={group ? [
                ...members.map((m) => ({ label: m.name, hint: m.id === group.coordinator ? 'Coordinator · open page' : 'Member · open page', href: agentRoute(m.id) })),
              ] : [
                { label: profile ? 'Close properties' : 'Properties', hint: 'What this agent can do, on the Canvas', testId: 'agent-properties', disabled: loadingProfile, onSelect: toggleProfile },
                ...(agent ? [
                  { label: 'Set up', hint: 'Account, model, tools and skills', href: agentRoute(agent.id, 'setup') },
                  { label: 'Open agent page', hint: 'Profile, activity and setup', href: agentRoute(agent.id) },
                ] : []),
              ]}
            />
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
            />
          ) : null}
        </header>
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
          <div className="wb-carryover" data-testid="chat-carryover">{conversation.carriedOver}</div>
        ) : null}

        <MessageList
          messages={[...(conversation?.messages ?? []), ...optimistic]}
          live={live}
          now={now}
          working={running}
          partial={partial}
          agents={everyone}
          {...(group ? { speakers: everyone, coordinatorId: group.coordinator } : {})}
          {...(runningAgentId ? { workingAs: everyone.find((a) => a.id === runningAgentId)?.name ?? runningAgentId } : {})}
          onOpenFile={openFile}
          onOpen={(toolUseId) => {
            if (conversationId) setDismissedTabs(current => {
              const next = { ...current, [conversationId]: (current[conversationId] ?? []).filter(id => id !== toolUseId) };
              storeDismissedTabs(next); return next;
            });
            setActiveTab(toolUseId);
            if (narrow) onOpenCanvas?.();
          }}
          {...(agent ? { agentName: agent.name } : {})}
          {...(opening ? { empty: opening } : {})}
          emptyHint={agent ? `Nothing here yet. Ask ${agent.name} for something.` : 'Loading agents…'}
        >

        {inlineApprovals.length ? inlineApprovals.map(item => (
          <div key={item.id} className="wb-inline-approval" data-testid="inline-approval">
            <Envelope
              props={item.props as { approvalId: string }}
              timezone={timezone}
              onDecided={onDecided}
              compact
              onOpenFull={() => { setActiveTab(item.id); if (narrow) onOpenCanvas?.(); }}
            />
          </div>
        )) : null}
        </MessageList>

        {(conversation?.offers ?? []).length > 0 ? (
          <div className="wb-offers" data-testid="chat-offers">
            {(conversation?.offers ?? []).map((offer) => (
              <button
                key={offer.id}
                className="ui-btn"
                disabled={takingOffer !== null}
                title={offer.prompt}
                onClick={() => takeOffer(offer.id)}
              >
                {offer.label}
              </button>
            ))}
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
        ) : conversation?.question ? (
          <QuestionPicker
            key={conversation.question.id}
            question={conversation.question}
            disabled={answeringQuestion || running}
            onAnswer={answerQuestion}
          />
        ) : (
          <Composer
            ref={composer}
            disabled={!agentId}
            running={running}
            onSend={send}
            onStop={stop}
            agentName={group ? group.name : (agent?.name ?? 'the agent')}
            draft={draft}
            model={group ? null : (agent?.model ?? null)}
            setupHref={group ? null : (agent ? agentRoute(agent.id, 'setup') : null)}
            thinking={thinking}
            {...(!group && agent ? { onThinking: switchThinking } : {})}
            {...(group ? { mentions: members.map((m) => ({ handle: m.handle, name: m.name })) } : {})}
            onOpenFile={openFile}
          />
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
          <button
            className="wb-grip"
            aria-label="Resize the conversation column"
            onPointerDown={(event) => {
              dragging.current = true;
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') setWidth((current) => Math.max(MIN_WIDTH, current - 16));
              if (event.key === 'ArrowRight') setWidth((current) => Math.min(720, current + 16));
            }}
          />
          {canvas}
        </>
      )}
    </>
  );
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
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





export const DRAFT_KEY = 'buddi.chatDraft';

/** Leave a sentence for an agent; the chat picks it up when it opens on that agent. */
export function leaveDraft(agentId: string, text: string): void {
  try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ agentId, text })); } catch { /* a private window forgets */ }
}

function takeDraft(agentId: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { agentId?: string; text?: string };
    if (parsed.agentId !== agentId || typeof parsed.text !== 'string') return null;
    window.sessionStorage.removeItem(DRAFT_KEY);
    return parsed.text;
  } catch {
    return null;
  }
}

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
}

/**
 * The header's one menu. Plain markup rather than a menu library: three rows,
 * a click outside or Escape closes it, and a test can open it with a click.
 */
function HeadMenu({ items, disabled }: { items: HeadMenuItem[]; disabled: boolean }): JSX.Element {
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
  return (
    <div className="wb-head-menu" ref={root}>
      <button
        className="ui-icon-btn wb-head-more"
        data-testid="chat-menu"
        aria-label="More about this agent"
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open ? 'true' : undefined}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="ui-menu wb-head-menu-list" role="menu">
          {items.map((item) => item.href ? (
            <a key={item.label} className="ui-menu-item" role="menuitem" href={item.href} onClick={() => setOpen(false)}>
              <span className="ui-menu-item-text">{item.label}</span>
              {item.hint ? <span className="ui-menu-item-hint">{item.hint}</span> : null}
            </a>
          ) : (
            <button
              key={item.label}
              className="ui-menu-item"
              role="menuitem"
              data-testid={item.testId}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect?.(); }}
            >
              <span className="ui-menu-item-text">{item.label}</span>
              {item.hint ? <span className="ui-menu-item-hint">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
