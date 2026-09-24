/**
 * A colleague's run, beside the conversation that asked for it.
 *
 * When one agent delegates, the caller's thread shows a single tool row and,
 * a minute later, a paragraph of somebody else's words. Everything in between
 * — which tools the colleague reached for, what it was thinking, whether it is
 * still going at all — happened in a conversation the owner never opened. This
 * panel is that conversation, read by id while it is alive.
 *
 * It is a *platform* panel, not a renderer: the ids come from the recorded
 * call (the server writes them the moment the colleague's conversation
 * exists), the contents come from the transcript route, and no tool result is
 * ever trusted to say what is drawn here.
 *
 * Polling stops when the work does. A finished delegation is history, and
 * history does not need a request every two seconds.
 */
import { useEffect, useState } from 'react';
import { chatApi } from '../../api';
import { Markdown } from '../../chat/markdown';
import { gistFor } from '../../chat/gist';
import { ToolRow, Thought } from '../../chat/MessageList';
import type { ChatAgent, ChatBlock, ChatConversation, ChatMessage } from '../../chat/types';
import { chatRoute } from '../../routes';
import { AgentAvatar, Button, useAsync } from '../../ui';
import { focusApprovalDock } from '../../chat/ApprovalDock';
import { labelFor } from '../renderables';

/** How often the colleague's transcript is re-read while its run is open. */
export const DELEGATE_POLL_MS = 2000;

export interface DelegateViewProps {
  conversationId: string;
  agentId: string;
  runId?: string | null;
  /** The delegation's own result, once the call has come back. */
  result?: { ok: boolean; text: string | null } | null;
  /**
   * The call has not come back because the colleague is paused on the owner,
   * or carrying on after they decided. `approvalId` is the approval up now.
   */
  waiting?: { approvalId: string | null } | null;
  /** The roster, for the colleague's name and face. */
  agents?: readonly ChatAgent[];
}

type Status = 'working' | 'waiting' | 'done' | 'failed';

export function DelegateView({ conversationId, agentId, runId = null, result = null, waiting = null, agents = [] }: DelegateViewProps): JSX.Element {
  // The call has come back: whatever the colleague did is done, and the
  // transcript is read once more rather than watched.
  const settled = result !== null;
  /*
   * Watched, or history. `done` is *state* rather than a derived flag so that
   * the moment the work settles it changes the read's dependencies: the
   * transcript is fetched one last time, so the final tool row and the
   * colleague's last words are on the panel rather than one poll short of it,
   * and only then does the asking stop.
   */
  const [done, setDone] = useState(settled);
  // A delegation paused on the owner is not over, whatever its first run
  // says: the colleague carries on the moment they decide.
  const watching = !done || waiting !== null;
  const { data, error } = useAsync<ChatConversation | undefined>(
    () => chatApi.conversation(conversationId),
    [conversationId, done, waiting?.approvalId ?? null],
    watching ? DELEGATE_POLL_MS : undefined,
  );

  /*
   * Is *this* delegation's run over?
   *
   * By its id, not by position: a colleague's conversation can hold several
   * runs — one of its own delegations, a resumed turn — so "some run is still
   * open" would spin after this work finished, and "no run is open" would
   * call it done the moment another one closed. The id comes from the
   * recorded call, which the server wrote. An older call carries none, and
   * falls back to the shape of the whole conversation.
   */
  const runs = data?.runs ?? [];
  const own = runId === null ? null : runs.find((run) => run.runId === runId) ?? null;
  const over = settled || (waiting === null && (runId !== null
    ? own !== null && own.finishedAt !== null
    : runs.length > 0 && runs.every((run) => run.finishedAt !== null)));
  useEffect(() => {
    if (over) setDone(true);
  }, [over]);

  const status: Status = result
    ? (result.ok ? 'done' : 'failed')
    : waiting?.approvalId ? 'waiting' : over ? 'done' : 'working';

  const colleague = agents.find((agent) => agent.id === agentId) ?? null;
  const name = colleague?.name ?? data?.agentId ?? agentId;
  const messages = data?.messages ?? [];
  const answer = result?.text ?? lastSaid(messages);

  return (
    <div className="wb-delegate" data-testid="delegate-view" data-status={status}>
      <header className="wb-delegate-head">
        <AgentAvatar agents={agents} id={agentId} />
        <div className="wb-delegate-who">
          <strong>{name}</strong>
          <span className="wb-delegate-status" data-status={status} role="status">
            {status === 'working' ? (
              <>
                Working
                <span className="wb-dots" aria-hidden="true"><i /><i /><i /></span>
              </>
            ) : status === 'waiting' ? 'Waiting for your approval' : status === 'failed' ? 'Failed' : 'Done'}
          </span>
        </div>
      </header>

      {error ? <p className="muted">{error}</p> : null}

      <div className="wb-delegate-work">
        {messages.map((message, index) => (
          <div key={message.id ?? index} className="wb-delegate-turn">
            {(message.blocks ?? []).map((block, blockIndex) => {
              if (block.type === 'thinking') {
                return block.text.trim() === '' ? null : <Thought key={blockIndex} text={block.text} />;
              }
              if (block.type === 'tool_use') {
                const step = stepOf(resultOf(messages, block.id));
                return (
                  <ToolRow
                    key={blockIndex}
                    label={labelFor(block.name)}
                    tool={block.name}
                    ok={step.ok}
                    running={step.running}
                    waiting={step.waiting}
                    status={step.status}
                    gist={gistFor(block.name, block.input)}
                    opens={false}
                    onOpen={() => {}}
                  />
                );
              }
              return null;
            })}
          </div>
        ))}
      </div>

      {answer ? (
        <div className="wb-delegate-answer" data-testid="delegate-answer">
          <Markdown text={answer} />
        </div>
      ) : status === 'working' || status === 'waiting' ? (
        <p className="muted">{name} has not answered yet.</p>
      ) : null}

      {/* The way out of the summary and into the thread itself. On the right,
          where every action on this dashboard is. */}
      <div className="wb-delegate-actions">
        {/* The decision is the dock's: the same card, the same row, whether
            it is decided here or in the colleague's own thread. */}
        {status === 'waiting' ? (
          <Button variant="accent" onClick={() => focusApprovalDock()} data-testid="delegate-to-approval">Go to the approval</Button>
        ) : null}
        {/* The call may carry no colleague id — an older row, a call whose
            event named only the conversation — and a link to `/chat//<id>`
            goes nowhere. The transcript knows whose thread it is. */}
        <a className="ui-btn" href={chatRoute(agentId || data?.agentId || '', conversationId)}>Open this conversation</a>
      </div>
    </div>
  );
}

/** The last thing the colleague said in its own thread. */
function lastSaid(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const said = (message.blocks ?? [])
      .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text.trim())
      .filter((text) => text !== '')
      .join('\n\n');
    if (said !== '') return said;
  }
  return null;
}

function resultOf(messages: readonly ChatMessage[], toolUseId: string): Extract<ChatBlock, { type: 'tool_result' }> | null {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_result' && block.toolUseId === toolUseId) return block;
    }
  }
  return null;
}

/**
 * What one of the colleague's calls is doing now, from its result row.
 *
 * A gated call's result is the gate's text until the owner decides, so a
 * result being there says nothing about success: the approval's state does.
 * Pending is still to decide; approved or executing is running; succeeded is
 * done; anything else is a failure, named.
 */
export function stepOf(outcome: Extract<ChatBlock, { type: 'tool_result' }> | null): {
  running: boolean;
  ok: boolean | null;
  waiting: boolean;
  status: string | undefined;
} {
  if (outcome === null) return { running: true, ok: null, waiting: false, status: undefined };
  const state = outcome.approval?.state;
  if (state === 'pending') return { running: false, ok: null, waiting: true, status: 'waiting approval' };
  if (state === 'approved' || state === 'executing') return { running: true, ok: null, waiting: false, status: 'running' };
  if (state === 'succeeded') return { running: false, ok: true, waiting: false, status: undefined };
  if (state) return { running: false, ok: false, waiting: false, status: state };
  return { running: false, ok: outcome.ok, waiting: false, status: undefined };
}
