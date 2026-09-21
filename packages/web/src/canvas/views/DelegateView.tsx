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
import { chatApi } from '../../api';
import { Markdown } from '../../chat/markdown';
import { ToolRow, Thought } from '../../chat/MessageList';
import type { ChatAgent, ChatBlock, ChatConversation, ChatMessage } from '../../chat/types';
import { chatRoute } from '../../routes';
import { AgentAvatar, useAsync } from '../../ui';
import { labelFor } from '../renderables';

/** How often the colleague's transcript is re-read while its run is open. */
export const DELEGATE_POLL_MS = 2000;

export interface DelegateViewProps {
  conversationId: string;
  agentId: string;
  runId?: string | null;
  /** The delegation's own result, once the call has come back. */
  result?: { ok: boolean; text: string | null } | null;
  /** The roster, for the colleague's name and face. */
  agents?: readonly ChatAgent[];
}

type Status = 'working' | 'done' | 'failed';

export function DelegateView({ conversationId, agentId, result = null, agents = [] }: DelegateViewProps): JSX.Element {
  // The call has come back: whatever the colleague did is done, and the
  // transcript is read once more rather than watched.
  const settled = result !== null;
  const { data, error } = useAsync<ChatConversation | undefined>(
    () => chatApi.conversation(conversationId),
    [conversationId],
    settled ? undefined : DELEGATE_POLL_MS,
  );

  const runs = data?.runs ?? [];
  const alive = !settled && (runs.length === 0 || runs.some((run) => run.finishedAt === null));
  const status: Status = result ? (result.ok ? 'done' : 'failed') : alive ? 'working' : 'done';

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
            ) : status === 'failed' ? 'Failed' : 'Done'}
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
                const outcome = resultOf(messages, block.id);
                return (
                  <ToolRow
                    key={blockIndex}
                    label={labelFor(block.name)}
                    tool={block.name}
                    ok={outcome?.ok ?? null}
                    running={outcome === null}
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
      ) : status === 'working' ? (
        <p className="muted">{name} has not answered yet.</p>
      ) : null}

      {/* The way out of the summary and into the thread itself. On the right,
          where every action on this dashboard is. */}
      <div className="wb-delegate-actions">
        <a className="ui-btn" href={chatRoute(agentId, conversationId)}>Open this conversation</a>
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
