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
import { useEffect, useRef, type ReactNode } from 'react';
import { approvalIdOf, labelFor } from '../canvas/renderables';
import { isPreviewable, previewUrl, type AttachmentBlock } from './attachments';
import { FileTile } from './FileTile';
import type { ChatBlock, ChatMessage } from '../chat/types';

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
  }, [messages.length, live.length, Boolean(children)]);

  const shown = messages.filter((message) => (message.blocks ?? []).some(isVisible));

  return (
    <div className="wb-messages" data-testid="messages">
      {shown.length === 0 && live.length === 0 ? (
        <p className="wb-chat-empty">{emptyHint}</p>
      ) : null}

      {shown.map((message, index) => {
        const mine = message.role === 'user';
        // The name is a heading for a run of turns, not a stamp on each one.
        const opensTurn = index === 0 || shown[index - 1]!.role !== message.role;
        return (
          <div key={message.id} className="wb-msg" data-role={mine ? 'user' : 'assistant'}>
            {opensTurn && !mine ? (
              <div className="wb-msg-who">{agentName ?? 'Assistant'}</div>
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
              if (block.type === 'text') {
                return block.text.trim() === '' ? null : (
                  <div key={blockIndex} className="wb-bubble">
                    {block.text}
                  </div>
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
  );
}

function files(message: ChatMessage): AttachmentBlock[] {
  return (message.blocks ?? []).filter((block): block is AttachmentBlock => block.type === 'attachment');
}

/** A block worth a line on screen. A bare tool result is not one. */
function isVisible(block: ChatBlock): boolean {
  if (block.type === 'text') return block.text.trim() !== '';
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
