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
 * The shell hides it on Home (which has its own composer), on the chat, and
 * during first run.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, chatApi } from '../api';
import { speakReply } from '../chat/ChatPage';
import { Composer, type ComposerDraft, type ComposerHandle } from '../chat/Composer';
import { MessageList, type LiveCall, type LiveTurnView } from '../chat/MessageList';
import { openChatStream } from '../chat/stream';
import type { ChatAgent, ChatConversation, ChatEvent, ChatMessage, UploadedAttachment } from '../chat/types';
import { readAloudPreference, saveReadAloud, stopPlayback } from '../chat/voice';
import { CHAT_ROUTE, HOME_ROUTE, chatRoute, parseWelcomeRoute, placeOf } from '../routes';
import { Blob, Button, ButtonLink, Dock, ErrorBanner, Mark } from '../ui';

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
}: {
  agent: ChatAgent;
  agents: ChatAgent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (route: string) => void;
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  const label = `Ask ${agent.name}`;
  /** A reply is on its way in the dock: the corner Blob thinks until it lands. */
  const [busy, setBusy] = useState(false);

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
    return <DockThread agent={agent} agents={agents} navigate={navigate} onClose={() => onOpenChange(false)} onBusy={setBusy} />;
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
  navigate,
  onClose,
  onBusy,
}: {
  agent: ChatAgent;
  agents: ChatAgent[];
  navigate: (route: string) => void;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
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
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [now, setNow] = useState(Date.now());
  const [readAloud, setReadAloud] = useState(readAloudPreference);
  const readAloudOn = useRef(readAloud);
  readAloudOn.current = readAloud;
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
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
          case 'message.appended':
          case 'awaiting-approval':
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
    composer.current?.focus();
  };

  const switchReadAloud = (on: boolean): void => {
    setReadAloud(on);
    saveReadAloud(on);
    if (!on) stopPlayback();
  };

  const route = conversationId ? chatRoute(agent.id, conversationId) : chatRoute(agent.id);
  const messages = [...(conversation?.messages ?? []), ...optimistic];

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
        />
        {voiceNote ? <p className="wb-voice-note" role="status">{voiceNote}</p> : null}
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
