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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, chatApi, type AgentProfile, type ApprovalRow } from '../api';
import { Canvas } from '../canvas/Canvas';
import { Envelope } from '../canvas/views/Envelope';
import { renderablesFrom } from '../canvas/renderables';
import { profileRenderable, profileTabId } from './properties';
import { useAsync } from '../ui';
import { BrowserPanel } from '../views/Browser';
import { conversationBrowser } from './browser';
import type { Renderable, ViewDescriptor } from '../canvas/types';
import { AgentRail } from '../shell/AgentRail';
import type { AgentAttention, AgentGroups } from '../shell/roster';
import { Composer, type ComposerDraft } from './Composer';
import { QuestionPicker } from './QuestionPicker';
import { conversationLine } from './lifetime';
import { MessageList, type LiveCall } from './MessageList';
import { openChatStream } from './stream';
import type { ChatAgent, ChatConversation, ChatEvent, ChatMessage } from './types';

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 440;
const WIDTH_KEY = 'buddi.chatWidth';

export interface ChatPageProps {
  timezone: string;
  /**
   * The roster, already ordered, and who is selected. Owned by the shell now
   * that the agent rail lives there: two views of one choice would drift.
   */
  agents: AgentGroups;
  agentId: string | null;
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
  onSelectAgent,
  attention,
  agentsInHeader,
  narrow,
  canvasOpen,
  onOpenCanvas,
  onCloseCanvas,
  newConversationSignal,
}: ChatPageProps): JSX.Element {
  const [descriptors, setDescriptors] = useState<ViewDescriptor[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  /** The owner's accepted send, shown before the run has persisted it. */
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveCall[]>([]);
  const [running, setRunning] = useState(false);
  const [awaiting, setAwaiting] = useState<Map<string, string>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
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

  const agent =
    [...agents.top, ...agents.middle, ...agents.bottom].find((c) => c.id === agentId) ?? null;

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
    let cancelled = false;
    setConversationId(null);
    setConversation(null);
    setOptimistic([]);
    // Whoever this is now, it is not who the open panel described.
    setProfile(null);
    chatApi
      .conversations(agentId)
      .then((list) => {
        if (cancelled) return;
        const latest = [...(list.conversations ?? [])].sort(byRecency)[0];
        if (latest) setConversationId(latest.id);
      })
      .catch(() => {
        /* A fresh install has no conversations. That is not an error. */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const refresh = useCallback((id: string) => {
    return chatApi
      .conversation(id)
      .then((loaded) => {
        setConversation(loaded);
        setOptimistic((pending) => pending.filter((message) => !transcriptContains(loaded, message)));
      })
      .catch((err: unknown) => setError(message(err)));
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
  }, [conversationId]);

  /* ---- the live run ---- */

  useEffect(() => {
    if (!conversationId) return undefined;
    const handle = openChatStream({
      url: chatApi.streamUrl(conversationId),
      onEvent: (event: ChatEvent) => {
        switch (event.name) {
          case 'run.started':
            setRunning(true);
            break;
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
            void refresh(conversationId);
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
    const items = fromTranscript;
    if (browserTab) items.push(browserTab);
    return profile ? [...items, profileRenderable(profile)] : items;
  }, [conversation, descriptors, awaiting, profile, browserTabId]);

  const inlineApproval = useMemo(
    () => [...renderables].reverse().find((item) => item.source === 'approval') ?? null,
    [renderables],
  );
  const inlineApprovalId = inlineApproval
    ? (inlineApproval.props as { approvalId?: string }).approvalId ?? null
    : null;

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

  const send = (text: string, attachmentIds: string[]): void => {
    if (!agentId) return;
    const local: ChatMessage = {
      id: `optimistic:${Date.now()}`,
      role: 'user',
      at: new Date().toISOString(),
      blocks: [{ type: 'text', text }],
    };
    setOptimistic([local]);
    setError(null);
    setNotice(null);
    setRunning(true);
    chatApi
      .send(agentId, { ...(conversationId ? { conversationId } : {}), text, attachmentIds })
      .then((result) => {
        // The conversation the page was in had ended, and this message opened a
        // new one. The empty thread is explained rather than surprising.
        setNotice(result.boundary?.note ?? null);
        if (result.conversationId !== conversationId) {
          setConversation(null);
          setConversationId(result.conversationId);
        }
        else void refresh(result.conversationId);
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
    setLive([]);
    setAwaiting(new Map());
    setActiveTab(null);
    previousFocus.current = null;
  }, []);

  useEffect(() => {
    if (newConversationSignal) startNew();
  }, [newConversationSignal, startNew]);

  const onDecided = (action: ApprovalRow): void => {
    if (conversationId) void refresh(conversationId);
    // The rest of the dashboard counts pending approvals; keep it honest.
    void api.overview().catch(() => {});
    if (action.state !== 'pending') setAwaiting((current) => new Map(current));
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

  const canvas = (
    <Canvas
      renderables={renderables}
      activeId={activeTab}
      onActivate={setActiveTab}
      timezone={timezone}
      onDecided={onDecided}
      onChangeAgent={changeVia}
      browserPanel={browserTab ? <BrowserPanel key={browserTab.id} data={browser.data} error={browser.error} reload={browser.reload} compact /> : null}
      descriptors={descriptors}
      {...(agent ? { agentName: agent.name } : {})}
      emptyHint={
        conversation
          ? 'Nothing in this conversation has produced a view yet. Ask for a number, a list or a document and it lands here beside the answer.'
          : 'Ask for something. Whatever the run looks at is drawn here, beside the answer rather than inside it.'
      }
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
      <section className="wb-chat" style={narrow ? undefined : { width }} data-testid="chat-column">
        <header className="wb-chat-head" data-testid="chat-head">
          <div className="wb-head-row">
            <div className="wb-head-text">
              <span className="wb-head-title">{agent?.name ?? 'No agent'}</span>
              <span className="wb-head-meta" data-tone={line.tone} title={line.title}>
                {line.text}
              </span>
            </div>
            {narrow ? (
              <button className="wb-btn" onClick={onOpenCanvas} disabled={renderables.length === 0}>
                Canvas{renderables.length > 0 ? ` (${renderables.length})` : ''}
              </button>
            ) : null}
            {/*
              What this agent actually is. At the end of the header because
              that is where a thing's own menu belongs, and quiet because it
              answers a question most sessions never ask — and the one that
              matters most on the day somebody does.
            */}
            <button
              className="wb-icon-btn wb-head-more"
              data-testid="agent-properties"
              aria-label={`Properties of ${agent?.name ?? 'this agent'}`}
              aria-expanded={profile !== null}
              title={profile ? 'Close the properties panel' : 'What this agent can do'}
              disabled={!agentId || loadingProfile}
              data-open={profile ? 'true' : undefined}
              onClick={toggleProfile}
            >
              <MoreIcon />
            </button>
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

        {error ? <div className="err-banner m-2.5">{error}</div> : null}

        {notice ? (
          <div className="muted m-2.5 text-xs" data-testid="chat-notice">
            {notice}
          </div>
        ) : null}

        <MessageList
          messages={[...(conversation?.messages ?? []), ...optimistic]}
          live={live}
          now={now}
          // Which calls the canvas actually kept a panel for. A call whose
          // result is already in the answer has no panel, and this is what
          // stops its line offering to open one.
          opens={new Set(renderables.map((item) => item.id))}
          onOpen={(toolUseId) => {
            setActiveTab(toolUseId);
            if (narrow) onOpenCanvas?.();
          }}
          {...(agent ? { agentName: agent.name } : {})}
          emptyHint={
            agent
              ? `Nothing here yet. Ask ${agent.name} for something — a projection, a document, a decision.`
              : 'Loading agents…'
          }
        />

        {inlineApprovalId ? (
          <div className="wb-inline-approval" data-testid="inline-approval">
            <Envelope
              props={{ approvalId: inlineApprovalId }}
              timezone={timezone}
              onDecided={onDecided}
            />
          </div>
        ) : null}

        {(conversation?.offers ?? []).length > 0 ? (
          <div className="wb-offers" data-testid="chat-offers">
            {(conversation?.offers ?? []).map((offer) => (
              <button
                key={offer.id}
                className="wb-btn"
                disabled={takingOffer !== null}
                title={offer.prompt}
                onClick={() => takeOffer(offer.id)}
              >
                {offer.label}
              </button>
            ))}
          </div>
        ) : null}

        {conversation?.question ? (
          <QuestionPicker
            key={conversation.question.id}
            question={conversation.question}
            disabled={answeringQuestion || running}
            onAnswer={answerQuestion}
          />
        ) : (
          <Composer
            disabled={!agentId}
            running={running}
            onSend={send}
            onStop={stop}
            agentName={agent?.name ?? 'the agent'}
            draft={draft}
          />
        )}
      </section>

      {narrow ? (
        canvasOpen ? (
          <div className="wb-sheet" role="dialog" aria-label="Canvas">
            <div className="wb-sheet-head">
              <strong>Canvas</strong>
              <button className="wb-btn" onClick={onCloseCanvas}>
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

function byRecency(a: { lastMessageAt: string | null; createdAt: string }, b: { lastMessageAt: string | null; createdAt: string }): number {
  return Date.parse(b.lastMessageAt ?? b.createdAt) - Date.parse(a.lastMessageAt ?? a.createdAt);
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
  const sentAt = Date.parse(optimistic.at);
  return conversation.messages.some(
    (message) =>
      message.role === 'user' &&
      Date.parse(message.at) >= sentAt - 1_000 &&
      message.blocks.some(
        (block) => block.type === 'text' && block.text.trim().startsWith(wanted),
      ),
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
