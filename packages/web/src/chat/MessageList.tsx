/**
 * The conversation itself.
 *
 * Tool calls appear inline as they happen — the tool's human label and the
 * seconds it has been running — because a column that goes quiet for forty
 * seconds looks broken, and a spinner does not say what is taking the time.
 * Clicking one moves the canvas to what it produced.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef } from 'react';
import { labelFor } from '../canvas/renderables';
import type { ChatMessage } from './types';

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
  emptyHint,
}: {
  messages: ChatMessage[];
  live: LiveCall[];
  /** Passed in so the elapsed counter ticks without this component owning a clock. */
  now: number;
  onOpen: (toolUseId: string) => void;
  emptyHint: string;
}): JSX.Element {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live.length]);

  return (
    <div className="wb-messages" data-testid="messages">
      {messages.length === 0 && live.length === 0 ? <p className="wb-empty">{emptyHint}</p> : null}

      {messages.map((message) => (
        <div key={message.id} className="wb-msg" data-role={message.role}>
          <div className="wb-msg-role">{message.role}</div>
          {(message.blocks ?? []).map((block, index) => {
            if (block.type === 'text') {
              return block.text.trim() === '' ? null : (
                <div key={index} className="wb-bubble">
                  {block.text}
                </div>
              );
            }
            if (block.type === 'attachment') {
              return (
                <span key={index} className="wb-chip">
                  {block.filename}
                  <span className="wb-menu-note pr-2">{block.kind}</span>
                </span>
              );
            }
            if (block.type === 'tool_use') {
              const result = findResult(messages, block.id);
              return (
                <ToolRow
                  key={index}
                  label={labelFor(block.name)}
                  tool={block.name}
                  ok={result?.ok ?? null}
                  running={result === null}
                  onOpen={() => onOpen(block.id)}
                />
              );
            }
            return null;
          })}
        </div>
      ))}

      {live.map((call) => (
        <ToolRow
          key={call.toolUseId}
          label={labelFor(call.name)}
          tool={call.name}
          ok={null}
          running
          elapsed={Math.max(0, Math.round((now - call.startedAt) / 1000))}
          onOpen={() => onOpen(call.toolUseId)}
        />
      ))}
      <div ref={bottom} />
    </div>
  );
}

function ToolRow({
  label,
  tool,
  ok,
  running,
  elapsed,
  onOpen,
}: {
  label: string;
  tool: string;
  ok: boolean | null;
  running: boolean;
  elapsed?: number;
  onOpen: () => void;
}): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="wb-tool" data-ok={ok === null ? undefined : ok} data-running={running} onClick={onOpen}>
          {running ? <span className="wb-pulse" aria-hidden="true" /> : null}
          <span className="wb-tool-label">{label}</span>
          {elapsed === undefined ? null : <span className="wb-tool-elapsed">{elapsed}s</span>}
          {ok === false ? <span className="wb-tool-elapsed">failed</span> : null}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="wb-tip" sideOffset={5}>
          {tool}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function findResult(
  messages: ChatMessage[],
  toolUseId: string,
): { ok: boolean } | null {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_result' && block.toolUseId === toolUseId) return { ok: block.ok };
    }
  }
  return null;
}
