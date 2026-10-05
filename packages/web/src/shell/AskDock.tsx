/**
 * The corner buddi: a quick question to the front desk from any page.
 *
 * A round button in the bottom-right corner carries the default agent's face.
 * Pressing it (or `/` on a page without a composer, or Alt+/) opens a small
 * dock over the page: the agent's name, a way into the full chat, the thread
 * and the same composer the chat uses. The first message opens a conversation
 * with the front desk exactly as Home's composer does, and the answer streams
 * in the dock rather than on another page. The dock remembers its thread for
 * the session, so closing and reopening it shows the same conversation; New
 * starts another.
 *
 * What the thread hands the owner to decide is drawn here exactly as the full
 * chat draws it, with the same components: the approval in the composer's
 * place (Approve, Reject), the agent's question as tappable choices, offer and
 * hand-off chips under the turn, and the edition card in the transcript. Open
 * in Chat is for a long thread, never for a button the dock could not press.
 *
 * The shell hides it on Home (which has its own composer), on the chat, and
 * during first run.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, chatApi } from '../api';
import { ApprovalDock } from '../chat/ApprovalDock';
import { QuestionPicker } from '../chat/QuestionPicker';
import { BrowserAsk, browserCardOf } from '../chat/BrowserAsk';
import { OfferButtons, pendingApprovals, useThreadActions } from '../chat/thread-actions';
import { speakReply } from '../chat/ChatPage';
import { Composer, type ComposerDraft, type ComposerHandle } from '../chat/Composer';
import { MessageList, type LiveCall, type LiveTurnView } from '../chat/MessageList';
import { openChatStream } from '../chat/stream';
import type { ChatAgent, ChatConversation, ChatEvent, ChatMessage, UploadedAttachment } from '../chat/types';
import type { ChatCommandName } from '../chat/commands';
import { leaveDraft } from '../chat/draft';
import { ROLE_MAKER } from './roster';
import { readAloudPreference, saveReadAloud, stopPlayback } from '../chat/voice';
import { CHAT_ROUTE, HOME_ROUTE, chatRoute, parseWelcomeRoute, placeOf } from '../routes';
import { Blob, Button, ButtonLink, Dock, ErrorBanner, Mark } from '../ui';
import { ASK_EVENT, type AskDetail } from './ask';

/**
 * The dock's conversation, for this page load: closing the dock keeps it.
 * `lastEventId` is where its stream stood when the dock closed, so the corner
 * button can go on listening for the end of a reply from there.
 */
let remembered: { agentId: string; conversationId: string; lastEventId?: string | null } | null = null;

/** For tests: forget the dock's conversation. */
export function forgetAskDockThread(): void {
  remembered = null;
}

/** Whether the corner button belongs on this page: not Home, not the chat, not first run. */
export function showsAskDock(hash: string): boolean {
  if (parseWelcomeRoute(hash) !== null) return false;
  const place = placeOf(hash);
  return place !== HOME_ROUTE && place !== CHAT_ROUTE;
}

export function AskDock({
  agent,
  agents,
  open,
  onOpenChange,
  navigate,
  timezone,
}: {
  agent: ChatAgent;
  agents: ChatAgent[];
  /** The owner's zone, for the times an approval card shows. */
  timezone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (route: string) => void;
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  const label = `Ask ${agent.name}`;
  /** A reply is on its way in the dock: the corner Blob thinks until it lands. */
  const [busy, setBusy] = useState(false);
  /** A request a page wrote in (an event sheet's Move or change…), for the dock's composer. */
  const [prefill, setPrefill] = useState<ComposerDraft | null>(null);
  useEffect(() => {
    const onAsk = (event: Event): void => {
      const detail = (event as CustomEvent<AskDetail>).detail;
      if (!detail || typeof detail.text !== 'string') return;
      detail.handled = true;
      setPrefill({ text: detail.text, at: Date.now() });
      onOpenChange(true);
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [onOpenChange]);

  // Closed mid-reply: listen on from where the dock left off, for the run's end.
  useEffect(() => {
    if (open || !busy || !remembered) return undefined;
    const handle = openChatStream({
      url: chatApi.streamUrl(remembered.conversationId),
      lastEventId: remembered.lastEventId ?? null,
      onEvent: (event: ChatEvent) => {
        if (event.name === 'run.finished') setBusy(false);
      },
    });
    return () => handle.close();
  }, [open, busy]);

  // Alt+/ toggles it from anywhere, fields included: a chord is never typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'Slash') return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  // Closed: focus goes back to the button, which is drawn again by now.
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (open) {
    return <DockThread agent={agent} agents={agents} timezone={timezone} navigate={navigate} onClose={() => onOpenChange(false)} onBusy={setBusy} prefill={prefill} />;
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button ref={button} type="button" className="wb-ask-fab" data-busy={busy ? 'true' : undefined} aria-label={label} onClick={() => onOpenChange(true)}>
          <FrontDeskFace busy={busy} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tip" side="left" sideOffset={8}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The Blob, as first run draws it, thinking while a reply streams; the mark if the picture will not load. */
function FrontDeskFace({ busy }: { busy: boolean }): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (broken) return <Mark size="lg" />;
  return <Blob state={busy ? 'working' : 'idle'} className="wb-ask-fab-face" onStillError={() => setBroken(true)} />;
}

function DockThread({
  agent,
  agents,
  timezone,
  navigate,
  onClose,
  onBusy,
  prefill,
}: {
  agent: ChatAgent;
  agents: ChatAgent[];
  timezone: string;
  navigate: (route: string) => void;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  /** A request a page wrote in: put in the box, never sent by itself. */
  prefill?: ComposerDraft | null;
}): JSX.Element {
  const composer = useRef<ComposerHandle>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    remembered && remembered.agentId === agent.id ? remembered.conversationId : null,
  );
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveCall[]>([]);
  const [partial, setPartial] = useState<LiveTurnView | null>(null);
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(prefill ?? null);
  useEffect(() => {
    if (prefill) setDraft(prefill);
  }, [prefill]);
  const [now, setNow] = useState(Date.now());
  const [readAloud, setReadAloud] = useState(readAloudPreference);
  const readAloudOn = useRef(readAloud);
  readAloudOn.current = readAloud;
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  /** Gated calls the stream announced before the transcript says so: tool-use id → approval id. */
  const [awaiting, setAwaiting] = useState<Map<string, string>>(new Map());
  /** The text of the turn being written, for reading it aloud when it ends. */
  const lastTurn = useRef<{ runId: string; turn: number; text: string } | null>(null);

  const refresh = useCallback(async (id: string): Promise<void> => {
    try {
      const loaded = await chatApi.conversation(id);
      setConversation(loaded);
      setOptimistic((pending) => pending.filter((message) => !carries(loaded, message)));
    } catch {
      /* The stream or the next event reads it again. */
    }
  }, []);

  useEffect(() => {
    if (conversationId) void refresh(conversationId);
  }, [conversationId, refresh]);

  /* The live run: the chat's events, the dock's share of them. */
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
            break;
          case 'live': {
            const runId = str(event.data['runId']) ?? '';
            const turn = Number(event.data['turn'] ?? 0);
            const kind = event.data['kind'] === 'thinking' ? 'thinking' : 'text';
            const text = str(event.data['text']) ?? '';
            const at = Date.now();
            if (kind === 'text') {
              const held = lastTurn.current;
              lastTurn.current = held && held.runId === runId && held.turn === turn ? { ...held, text: held.text + text } : { runId, turn, text };
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
            setRunning(true);
            setPartial({ runId, turn, text, thinking, thinkingStartedAt: thinking ? startedAt : null, textStartedAt: text ? startedAt : null, settled: false });
            break;
          }
          case 'live.settle': {
            const runId = str(event.data['runId']) ?? '';
            const turn = Number(event.data['turn'] ?? 0);
            // Withdrawn by the grounding guard: gone at once, never read aloud.
            if (event.data['retracted'] === true) {
              if (lastTurn.current?.runId === runId && lastTurn.current.turn === turn) lastTurn.current = null;
              setPartial((current) => (current && current.runId === runId && current.turn === turn ? null : current));
              break;
            }
            setPartial((current) => (current && current.runId === runId && current.turn === turn ? { ...current, settled: true } : current));
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
            void refresh(conversationId);
            break;
          }
          case 'awaiting-approval': {
            const approvalId = str(event.data['approvalId']) ?? str(event.data['actionId']);
            const toolUseId = str(event.data['toolUseId']);
            if (approvalId && toolUseId) setAwaiting((current) => new Map(current).set(toolUseId, approvalId));
            if (toolUseId) setLive((current) => current.filter((call) => call.toolUseId !== toolUseId));
            void refresh(conversationId).then(() => setPartial((current) => (current?.settled ? null : current)));
            break;
          }
          case 'message.appended':
            void refresh(conversationId).then(() => setPartial((current) => (current?.settled ? null : current)));
            break;
          case 'run.finished': {
            setRunning(false);
            setLive([]);
            setPartial(null);
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
    return () => {
      if (remembered && remembered.conversationId === conversationId) remembered.lastEventId = handle.lastEventId();
      handle.close();
    };
  }, [conversationId, refresh]);

  // The corner button's Blob follows the reply, before and after the dock closes.
  useEffect(() => {
    onBusy(running || sending);
  }, [running, sending, onBusy]);

  // Elapsed counters on tool rows tick while something is running.
  useEffect(() => {
    if (live.length === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live.length]);

  const send = (text: string, attachments: UploadedAttachment[]): void => {
    setSending(true);
    setError(null);
    const local: ChatMessage = { id: `local-${Date.now()}`, role: 'user', at: new Date().toISOString(), blocks: [{ type: 'text', text }] };
    setOptimistic((pending) => [...pending, local]);
    void (async () => {
      try {
        // The same two calls Home's composer makes, and the thread stays here.
        const id = conversationId ?? (await chatApi.startConversation(agent.id)).conversationId;
        if (id !== conversationId) {
          remembered = { agentId: agent.id, conversationId: id };
          setConversationId(id);
        }
        const sent = await chatApi.send(agent.id, {
          conversationId: id,
          text,
          ...(attachments.length > 0 ? { attachmentIds: attachments.map((file) => file.artifactId) } : {}),
        });
        if (sent.conversationId !== id) {
          remembered = { agentId: agent.id, conversationId: sent.conversationId };
          setConversationId(sent.conversationId);
        }
        setRunning(true);
        void refresh(sent.conversationId);
      } catch (err) {
        setOptimistic((pending) => pending.filter((message) => message.id !== local.id));
        setError(err instanceof ApiError ? err.message : String(err));
        setDraft({ text, at: Date.now() });
      } finally {
        setSending(false);
      }
    })();
  };

  /** `/` commands, as the full chat runs them; one that changes who you talk to opens that chat. */
  const runCommand = (name: ChatCommandName, arg: string): void => {
    setError(null);
    if (name === 'stop') { stop(); return; }
    if (name === 'use') {
      const wanted = arg.replace(/^@/, '').toLowerCase();
      const target = agents.find((a) => a.handle.toLowerCase() === wanted || a.id === wanted);
      if (!target) { setVoiceNote(wanted ? `No agent called @${wanted}.` : 'Say who: /use @handle.'); return; }
      navigate(chatRoute(target.id));
      return;
    }
    if (name === 'new') {
      const maker = agents.find((a) => a.roles.includes(ROLE_MAKER));
      if (!maker) { setVoiceNote('There is no agent here that makes agents.'); return; }
      if (arg.trim()) leaveDraft(maker.id, `I'd like a teammate for this: ${arg.trim()}`);
      navigate(chatRoute(maker.id));
      return;
    }
    api.quiet(arg)
      .then((answer) => setVoiceNote(answer.text))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const stop = (): void => {
    if (!conversationId) return;
    chatApi.cancel(conversationId).catch((err: unknown) => setError(String(err))).finally(() => setRunning(false));
  };

  const startNew = (): void => {
    remembered = null;
    setConversationId(null);
    setConversation(null);
    setOptimistic([]);
    setLive([]);
    setPartial(null);
    setRunning(false);
    setError(null);
    setAwaiting(new Map());
    composer.current?.focus();
  };

  const switchReadAloud = (on: boolean): void => {
    setReadAloud(on);
    saveReadAloud(on);
    if (!on) stopPlayback();
  };

  const route = conversationId ? chatRoute(agent.id, conversationId) : chatRoute(agent.id);
  const messages = [...(conversation?.messages ?? []), ...optimistic];

  /* The same decisions the full chat offers, through the same calls. */
  const { openOffers, takingOffer, takeOffer, answeringQuestion, answerQuestion, skipQuestion } = useThreadActions({
    conversation,
    conversationId,
    agentId: agent.id,
    now,
    refresh,
    onRunStarted: () => setRunning(true),
    onError: (failed, endedRun) => { setError(failed); if (endedRun) setRunning(false); },
    navigate,
  });
  const approvals = useMemo(() => pendingApprovals(conversation, agents, awaiting), [conversation, agents, awaiting]);
  const question = approvals.length === 0 ? conversation?.question ?? null : null;
  const onDecided = (action: { id: string; state: string }): void => {
    if (conversationId) void refresh(conversationId);
    void api.overview().catch(() => {});
    if (action.state !== 'pending') setAwaiting((current) => new Map([...current].filter(([, id]) => id !== action.id)));
  };

  return (
    <Dock
      title={agent.name}
      label={`${agent.name}, a quick chat`}
      onClose={onClose}
      onOpenAutoFocus={(event) => { event.preventDefault(); composer.current?.focus(); }}
      onCloseAutoFocus={(event) => event.preventDefault()}
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={startNew} disabled={conversationId === null && optimistic.length === 0}>New</Button>
          <ButtonLink size="sm" variant="ghost" href={route} onClick={(event) => { event.preventDefault(); navigate(route); }}>Open in Chat</ButtonLink>
        </>
      }
    >
      <div className="wb-ask-thread">
        <MessageList
          messages={messages}
          live={live}
          now={now}
          working={running || sending}
          partial={partial}
          agents={agents}
          agentName={agent.name}
          agentId={agent.id}
          onOpen={() => navigate(route)}
          onReadAloud={(messageId, text) => {
            setVoiceNote(null);
            void speakReply(text, conversationId ?? undefined, messageId).then((note) => { if (note) setVoiceNote(note); });
          }}
          emptyHint={`Ask ${agent.name} anything, without leaving this page.`}
        />
      </div>
      <div className="wb-ask-compose">
        {error ? <ErrorBanner message={error} /> : null}
        <OfferButtons offers={openOffers} disabled={takingOffer !== null} onTake={takeOffer} />
        {approvals.length > 0 ? (
          <ApprovalDock
            approvals={approvals}
            timezone={timezone}
            now={now}
            version={conversation}
            onDecided={onDecided}
            onSay={(text) => send(text, [])}
            onOpenFull={() => navigate(route)}
          />
        ) : question && browserCardOf(question) ? (
          <BrowserAsk key={question.id} card={browserCardOf(question)!} disabled={answeringQuestion || running} onAnswer={answerQuestion} />
        ) : question ? (
          <QuestionPicker
            key={question.id}
            question={question}
            disabled={answeringQuestion || running}
            onAnswer={answerQuestion}
            onSkip={skipQuestion}
          />
        ) : null}
        <div hidden={approvals.length > 0 || question !== null} data-testid="composer-slot">
        <Composer
          ref={composer}
          disabled={sending || !agent.available}
          running={running}
          onSend={send}
          onStop={stop}
          agentName={agent.name}
          placeholder={`Message ${agent.name}…`}
          draft={draft}
          threadKey={`dock.${conversationId ?? agent.id}`}
          conversationId={conversationId}
          readAloud={readAloud}
          onReadAloud={switchReadAloud}
          team={{ agents, selfId: agent.id }}
          onCommand={runCommand}
        />
        {voiceNote ? <p className="wb-voice-note" role="status">{voiceNote}</p> : null}
        </div>
      </div>
    </Dock>
  );
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The transcript now holds what was sent: the owner's words, in a turn of theirs. */
function carries(conversation: ChatConversation, sent: ChatMessage): boolean {
  const text = sent.blocks?.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') return false;
  return conversation.messages.some((message) =>
    message.role === 'user' && (message.blocks ?? []).some((block) => block.type === 'text' && block.text.includes(text.text)),
  );
}
