/**
 * The agent switcher, at the head of the conversation column.
 *
 * One control, not a box holding a box: a monogram, the agent's name with its
 * handle and model on the same line, and a chevron that says the thing opens.
 * It is quiet until you point at it, because the head of a column is not where
 * the attention should be.
 *
 * An agent that cannot run — no credential, a model this machine cannot
 * reach — is listed and disabled with the reason attached, rather than hidden.
 * Hiding it turns a fixable configuration problem into a mystery.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ChatAgent } from './types';

export function AgentSwitcher({
  agents,
  current,
  onSelect,
}: {
  agents: ChatAgent[];
  current: ChatAgent | null;
  onSelect: (agentId: string) => void;
}): JSX.Element {
  const others = agents.length > 1;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="wb-agent-btn" aria-label="Switch agent">
          <span className="wb-agent-mark" aria-hidden="true">
            {monogram(current?.name)}
          </span>
          <span className="wb-agent-text">
            <span className="wb-agent-name">{current?.name ?? 'No agent'}</span>
            <span className="wb-agent-meta">
              {current ? `@${current.handle} · ${current.model}` : 'None configured'}
            </span>
          </span>
          <ChevronIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="wb-menu wb-menu-wide" align="start" sideOffset={6}>
          <DropdownMenu.Label className="wb-menu-label">
            {others ? 'Switch agent' : 'Agent'}
          </DropdownMenu.Label>
          {agents.map((agent) => (
            <DropdownMenu.Item
              key={agent.id}
              className="wb-menu-item wb-agent-item"
              disabled={!agent.available}
              data-unavailable={agent.available ? undefined : 'true'}
              onSelect={() => agent.available && onSelect(agent.id)}
            >
              <span className="wb-agent-mark" aria-hidden="true">
                {monogram(agent.name)}
              </span>
              <span className="wb-agent-text">
                <span className="wb-agent-name">{agent.name}</span>
                <span className="wb-agent-meta">
                  {agent.available
                    ? `@${agent.handle} · ${agent.model}`
                    : agent.unavailableReason ?? 'Unavailable'}
                </span>
              </span>
              {agent.id === current?.id ? <CheckIcon /> : null}
              {agent.available ? null : <span className="wb-tag">Unavailable</span>}
            </DropdownMenu.Item>
          ))}
          {agents.length === 0 ? (
            <p className="wb-menu-empty">No agents are configured yet.</p>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One or two letters, so an agent is recognisable before it is read. */
function monogram(name: string | undefined): string {
  const words = (name ?? '·').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="wb-agent-chevron"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 5.5 7 8.5l3-3" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.8 7.4 5.6 10.2l5.6-6.4" />
    </svg>
  );
}
