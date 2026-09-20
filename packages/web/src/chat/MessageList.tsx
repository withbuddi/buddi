/**
 * The conversation itself.
 *
 * The two turns are told apart by shape, not by a label: what the owner said
 * is a tinted bubble pushed to the right edge of the column; what the agent
 * said is prose against the page, under the agent's own name, at a line length
 * you can actually read. A message that carries only a tool result — which is
 * how a transcript records the server's half of a call — prints nothing at
 * all, because "USER" over an empty box is noise.
 *
 * Tool calls appear inline as they happen — the tool's human label and the
 * seconds it has been running — because a column that goes quiet for forty
 * seconds looks broken, and a spinner does not say what is taking the time.
 * Every recorded call opens its result or an on-demand input/output inspector.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { approvalIdOf, labelFor } from '../canvas/renderables';
import { isPreviewable, previewUrl, type AttachmentBlock } from './attachments';
import { FileTile } from './FileTile';
import { Markdown, MarkdownAgents } from './markdown';
import type { ChatAgent, ChatBlock, ChatMessage } from '../chat/types';
import { AgentAvatar } from '../ui';

/**
 * The answer as it is being written: what has arrived of this turn's thinking
 * and text, and when each began, so "thought for 4s" can be said truthfully.
 */
export interface LiveTurnView {
  runId: string;
  turn: number;
  text: string;
  thinking: string;
  thinkingStartedAt: number | null;
  textStartedAt: number | null;
  /** The transcript now holds this turn; it is hidden once the refresh shows it. */
  settled: boolean;
}

/** A tool call that has not come back yet. */
export interface LiveCall {
  toolUseId: string;
  name: string;
  startedAt: number;
}

export function MessageList({
  messages,
  live,
  now,
  onOpen,
  working = false,
  partial = null,
  agents,
  speakers,
  coordinatorId,
  workingAs,
  onOpenFile,
  children,
  agentName,
  emptyHint,
}: {
  messages: ChatMessage[];
  live: LiveCall[];
  /** Passed in so the elapsed counter ticks without this component owning a clock. */
  now: number;
  onOpen: (toolUseId: string) => void;
  /**
   * The agent is on it and has not said anything yet. Drawn where the reply
   * will land, under the agent's name, so the column never goes quiet between
   * the owner's message and the first word back.
   */
  working?: boolean;
  /** The turn being written right now, if any. */
  partial?: LiveTurnView | null;
  /** Every agent, so an `@handle` in an answer opens that agent. */
  agents?: ChatAgent[];
  /** In a room: every agent, so a turn can carry its speaker's face and name. */
  speakers?: ChatAgent[];
  coordinatorId?: string;
  /** Who is working, when the room says so; falls back to `agentName`. */
  workingAs?: string;
  /** A file in the thread was clicked: show it on the canvas. */
  onOpenFile?: (attachment: AttachmentBlock) => void;
  children?: ReactNode;
  /** Whose turn the agent's turn is. Shown once per run of its messages. */
  agentName?: string;
  emptyHint: string;
}): JSX.Element {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live.length, working, partial?.text.length, partial?.thinking.length, Boolean(children)]);

  const writing = partial && !partial.settled && (partial.text !== '' || partial.thinking !== '');

  const shown = messages.filter((message) => (message.blocks ?? []).some(isVisible));

  return (
    <MarkdownAgents.Provider value={agents ?? speakers ?? []}>
    <div className="wb-messages" data-testid="messages">
      {shown.length === 0 && live.length === 0 ? (
        <p className="wb-chat-empty">{emptyHint}</p>
      ) : null}

      {shown.map((message, index) => {
        // In a room the speaker decides the side: the owner's turns are the
        // owner's, everything else is a member speaking, tool results included.
        const speaker = message.speaker ?? null;
        const mine = speakers ? speaker === 'owner' || (speaker === null && message.role === 'user') : message.role === 'user';
        const roomNote = speakers && speaker === 'room';
        const who = speakers && speaker && speaker !== 'owner' && speaker !== 'room' ? speakers.find((a) => a.id === speaker) ?? null : null;
        // The name is a heading for a run of turns, not a stamp on each one.
        const previous = shown[index - 1];
        const opensTurn = index === 0 || (speakers ? (previous?.speaker ?? null) !== speaker : previous!.role !== message.role);
        if (roomNote) {
          return (
            <div key={message.id} className="wb-msg wb-msg-room" data-role="room">
              {(message.blocks ?? []).filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text').map((b, i) => <span key={i}>{b.text}</span>)}
            </div>
          );
        }
        // The coordinator bringing a member in is coordination, not prose:
        // one line saying who asked whom for what, the whole request on click.
        const ask = speakers && who && message.role === 'user' ? askedFor(message) : null;
        if (ask) {
          // The member asked is whoever answers next; the request names only the asker.
          const next = shown.slice(index + 1).find((m) => m.role === 'assistant' && m.speaker && m.speaker !== who!.id);
          const target = next?.speaker ? speakers!.find((a) => a.id === next.speaker) : undefined;
          return (
            <details key={message.id} className="wb-msg wb-msg-room wb-msg-ask" data-role="room">
              <summary>{who!.name} asked {target?.name ?? 'a member'}{ask.request ? `: ${ask.request.length > 120 ? `${ask.request.slice(0, 119)}…` : ask.request}` : ''}</summary>
              {ask.request ? <p>{ask.request}</p> : null}
            </details>
          );
        }
        return (
          <div key={message.id} className="wb-msg" data-role={mine ? 'user' : 'assistant'}>
            {opensTurn && !mine ? (
              <div className="wb-msg-who">
                {who && speakers ? <AgentAvatar agents={speakers} id={who.id} size="sm" /> : null}
                <span>{who ? who.name : (agentName ?? 'Assistant')}</span>
                {who && coordinatorId === who.id ? <span className="wb-msg-role">coordinator</span> : null}
              </div>
            ) : null}
            {/* The files a message carries sit together, before its words: the
                thing you handed over, then what you said about it. */}
            {files(message).length > 0 ? (
              <div className="wb-msg-files" role="list" aria-label="Files sent with this message">
                {files(message).map((block) => (
                  <span role="listitem" key={block.artifactId}>
                    <FileTile
                      name={block.filename ?? 'Untitled file'}
                      mime={block.mime}
                      sizeBytes={block.sizeBytes}
                      thumbnail={isPreviewable(block.mime) ? previewUrl(block.artifactId) : null}
                      {...(onOpenFile ? { onOpen: () => onOpenFile(block) } : {})}
                    />
                  </span>
                ))}
              </div>
            ) : null}
            {(message.blocks ?? []).map((block, blockIndex) => {
              if (block.type === 'thinking') {
                return block.text.trim() === '' ? null : <Thought key={blockIndex} text={block.text} />;
              }
              if (block.type === 'text') {
                // The owner's words stay exactly as typed; the agent's are
                // markdown, because that is how a model writes a list.
                return block.text.trim() === '' ? null : mine ? (
                  <div key={blockIndex} className="wb-bubble">{block.text}</div>
                ) : (
                  <div key={blockIndex} className="wb-bubble" data-rich="true"><Markdown text={block.text} /></div>
                );
              }
              if (block.type === 'attachment') return null;
              if (block.type === 'tool_use') {
                const result = findResult(messages, block.id);
                return (
                  <ToolRow
                    key={blockIndex}
                    label={labelFor(block.name)}
                    tool={block.name}
                    ok={result?.ok ?? null}
                    running={result === null}
                    status={result && approvalIdOf(result) ? 'Awaiting approval' : result?.approval?.state}
                    opens
                    onOpen={() => onOpen(block.id)}
                  />
                );
              }
              return null;
            })}
          </div>
        );
      })}

      {writing ? (
        <div className="wb-msg" data-role="assistant" data-testid="live-turn">
          {shown.at(-1)?.role !== 'assistant' || workingAs ? <div className="wb-msg-who">{workingAs ?? agentName ?? 'Assistant'}</div> : null}
          {partial.thinking !== '' ? (
            <Thought
              text={partial.thinking}
              live={partial.text === ''}
              seconds={secondsBetween(partial.thinkingStartedAt, partial.textStartedAt ?? now)}
            />
          ) : null}
          {partial.text !== '' ? <div className="wb-bubble" data-live="true" data-rich="true"><Markdown text={partial.text} /><span className="wb-caret" aria-hidden="true" /></div> : null}
        </div>
      ) : null}

      {working && live.length === 0 && !writing ? (
        <div className="wb-msg" data-role="assistant" data-testid="working">
          {shown.at(-1)?.role !== 'assistant' || workingAs ? <div className="wb-msg-who">{workingAs ?? agentName ?? 'Assistant'}</div> : null}
          <span className="wb-working" role="status" aria-live="polite">
            {workingAs ?? agentName ?? 'The agent'} is working<span className="wb-dots" aria-hidden="true"><i /><i /><i /></span>
          </span>
        </div>
      ) : null}

      {live.map((call) => (
        <div key={call.toolUseId} className="wb-msg" data-role="assistant">
          <ToolRow
            label={labelFor(call.name)}
            tool={call.name}
            ok={null}
            running
            elapsed={Math.max(0, Math.round((now - call.startedAt) / 1000))}
            opens={false}
            onOpen={() => onOpen(call.toolUseId)}
          />
        </div>
      ))}
      {children}
      <div ref={bottom} />
    </div>
    </MarkdownAgents.Provider>
  );
}

function secondsBetween(from: number | null, to: number): number | null {
  if (from === null) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

/**
 * What the model thought, folded. Live, it is the line the column shows while
 * there is nothing else to show — "Thinking", with the clock — and it folds
 * the moment the answer starts. After the fact it is a quiet row that opens.
 */
function Thought({ text, live = false, seconds = null }: { text: string; live?: boolean; seconds?: number | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = live
    ? `Thinking${seconds !== null && seconds > 0 ? ` · ${seconds}s` : ''}`
    : seconds !== null && seconds > 0 ? `Thought for ${seconds}s` : 'Thoughts';
  return (
    <div className="wb-thought" data-live={live || undefined} data-open={open || undefined}>
      <button type="button" className="wb-thought-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {live ? <span className="wb-dots" aria-hidden="true"><i /><i /><i /></span> : <ThoughtIcon />}
        <span>{label}</span>
        <ArrowIcon />
      </button>
      {open ? <div className="wb-thought-text"><Markdown text={text} /></div> : null}
    </div>
  );
}

function ThoughtIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 9.6a3.6 3.6 0 1 1 4.6 0v1.2H4.2z" /><path d="M5.2 12.2h2.6" />
    </svg>
  );
}

/**
 * The coordinator's request to a member, as the runtime words it: the member's
 * handle and the request itself, lifted out of the framing around them.
 */
function askedFor(message: ChatMessage): { handle: string; request: string } | null {
  const text = (message.blocks ?? []).find((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')?.text ?? '';
  const match = /You are a member of the group "[^"]*"\. @([\w-]+), the coordinator, asks you now:\n\n([\s\S]*?)(?:\n\nAnswer for the room|$)/.exec(text);
  if (!match) return null;
  return { handle: match[1]!, request: match[2]!.trim() };
}

function files(message: ChatMessage): AttachmentBlock[] {
  return (message.blocks ?? []).filter((block): block is AttachmentBlock => block.type === 'attachment');
}

/** A block worth a line on screen. A bare tool result is not one. */
function isVisible(block: ChatBlock): boolean {
  if (block.type === 'text' || block.type === 'thinking') return block.text.trim() !== '';
  return block.type === 'tool_use' || block.type === 'attachment';
}

function ToolRow({
  label,
  tool,
  ok,
  running,
  elapsed,
  opens,
  onOpen,
  status,
}: {
  label: string;
  tool: string;
  ok: boolean | null;
  running: boolean;
  elapsed?: number;
  /** Whether the canvas has a panel for this call. */
  opens: boolean;
  onOpen: () => void;
  status?: string;
}): JSX.Element {
  const marks = (
    <>
      {running ? (
        <span className="wb-pulse" aria-hidden="true" />
      ) : (
        <span className="wb-tool-mark" data-ok={status === 'Awaiting approval' || status === 'approved' || status === 'executing' ? 'pending' : ok === false ? 'false' : 'true'} aria-hidden="true" />
      )}
      <span className="wb-tool-label">{label}</span>
      {elapsed === undefined ? null : <span className="wb-tool-elapsed">{elapsed}s</span>}
      {status || ok === false ? <span className="wb-tool-elapsed">{status ?? 'failed'}</span> : null}
    </>
  );

  if (!opens) {
    return (
      <span className="wb-tool" data-static="true" data-ok={ok === null ? undefined : ok} data-running={running}>
        {marks}
      </span>
    );
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="wb-tool" data-ok={ok === null ? undefined : ok} data-running={running} onClick={onOpen}>
          {marks}
          <ArrowIcon />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tip" sideOffset={6}>
          <span className="ui-tip-title">Open on the canvas</span>
          <span className="ui-tip-hint mono">{tool}</span>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function ArrowIcon(): JSX.Element {
  return (
    <svg
      className="wb-tool-arrow"
      width="13"
      height="13"
      viewBox="0 0 13 13"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.8 2.6 9 6.5l-4.2 3.9" />
    </svg>
  );
}

function findResult(
  messages: ChatMessage[],
  toolUseId: string,
): Extract<ChatBlock, { type: 'tool_result' }> | null {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_result' && block.toolUseId === toolUseId) return block;
    }
  }
  return null;
}
