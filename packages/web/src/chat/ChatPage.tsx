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
 * **The canvas is derived, never pushed.** Everything on the right comes from
 * the transcript's own tool calls, so it fills in for a run happening now and
 * for a mission that ran while nobody was watching, without either of them
 * knowing a canvas exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, chatApi, type ApprovalRow } from '../api';
import { Canvas } from '../canvas/Canvas';
import { renderablesFrom } from '../canvas/renderables';
import type { Renderable, ViewDescriptor } from '../canvas/types';
import { AgentSwitcher } from './AgentSwitcher';
import { Composer } from './Composer';
import { MessageList, type LiveCall } from './MessageList';
import { openChatStream } from './stream';
import type { ChatAgent, ChatConversation, ChatEvent } from './types';

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 440;
const WIDTH_KEY = 'buddi.chatWidth';

export interface ChatPageProps {
  timezone: string;
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
  narrow,
  canvasOpen,
  onOpenCanvas,
  onCloseCanvas,
  newConversationSignal,
}: ChatPageProps): JSX.Element {
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [descriptors, setDescriptors] = useState<ViewDescriptor[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [live, setLive] = useState<LiveCall[]>([]);
  const [running, setRunning] = useState(false);
  const [awaiting, setAwaiting] = useState<Map<string, string>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [width, setWidth] = useState(readWidth);

  const agent = agents.find((candidate) => candidate.id === agentId) ?? null;

  /* ---- what the page knows before anyone types ---- */

  useEffect(() => {
    let cancelled = false;
    Promise.all([chatApi.agents(), chatApi.views().catch(() => ({ views: [] as ViewDescriptor[] }))])
      .then(([agentList, viewList]) => {
        if (cancelled) return;
        setAgents(agentList.agents);
        setAgentId((current) => current ?? agentList.defaultAgentId ?? agentList.agents[0]?.id ?? null);
        setDescriptors(viewList.views ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err));
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
      .then((loaded) => setConversation(loaded))
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
        if (!cancelled) setConversation(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /* ---- the live run ---- */

  const openCanvasRef = useRef(onOpenCanvas);
  openCanvasRef.current = onOpenCanvas;

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
              setActiveTab(toolUseId);
              openCanvasRef.current?.();
            }
            setLive((current) => current.filter((call) => call.toolUseId !== toolUseId));
            void refresh(conversationId);
            break;
          }
          case 'run.finished':
            setRunning(false);
            setLive([]);
            void refresh(conversationId);
            break;
          default:
            break;
        }
      },
    });
    return () => handle.close();
  }, [conversationId, refresh]);

  // One clock for every elapsed counter, and only while something is running.
  useEffect(() => {
    if (live.length === 0) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [live.length]);

  /* ---- the canvas ---- */

  const renderables: Renderable[] = useMemo(
    () =>
      renderablesFrom({
        messages: conversation?.messages ?? [],
        descriptors,
        awaiting,
      }),
    [conversation, descriptors, awaiting],
  );

  // A new renderable is the one you want to see, unless you have gone back to
  // an older tab on purpose — in which case an approval still interrupts.
  const lastId = renderables[renderables.length - 1]?.id ?? null;
  const previousLast = useRef<string | null>(null);
  useEffect(() => {
    if (lastId && lastId !== previousLast.current) {
      previousLast.current = lastId;
      setActiveTab(lastId);
    }
  }, [lastId]);

  /* ---- actions ---- */

  const send = (text: string, attachmentIds: string[]): void => {
    if (!agentId) return;
    setError(null);
    setRunning(true);
    chatApi
      .send(agentId, { ...(conversationId ? { conversationId } : {}), text, attachmentIds })
      .then((result) => {
        if (result.conversationId !== conversationId) setConversationId(result.conversationId);
        else void refresh(result.conversationId);
      })
      .catch((err: unknown) => {
        setError(message(err));
        setRunning(false);
      });
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
    previousLast.current = null;
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
      descriptors={descriptors}
      {...(agent ? { agentName: agent.name } : {})}
      emptyHint={
        conversation
          ? 'Nothing in this conversation has produced a view yet. Ask for a number, a list or a document and it lands here beside the answer.'
          : 'Ask for something. Whatever the run looks at is drawn here, beside the answer rather than inside it.'
      }
    />
  );

  return (
    <>
      <section className="wb-chat" style={narrow ? undefined : { width }} data-testid="chat-column">
        <header className="wb-chat-head">
          <AgentSwitcher agents={agents} current={agent} onSelect={setAgentId} />
          {narrow ? (
            <button className="wb-btn" onClick={onOpenCanvas} disabled={renderables.length === 0}>
              Canvas{renderables.length > 0 ? ` (${renderables.length})` : ''}
            </button>
          ) : null}
        </header>

        {error ? <div className="err-banner m-2.5">{error}</div> : null}

        <MessageList
          messages={conversation?.messages ?? []}
          live={live}
          now={now}
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

        <Composer
          disabled={!agentId}
          running={running}
          onSend={send}
          onStop={stop}
          agentName={agent?.name ?? 'the agent'}
        />
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
