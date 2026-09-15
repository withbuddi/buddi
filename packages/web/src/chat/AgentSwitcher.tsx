/**
 * The agent switcher, at the head of the conversation column.
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
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="wb-agent-btn" aria-label="Switch agent">
          <span className="wb-swatch" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="wb-agent-name block">{current?.name ?? 'No agent'}</span>
            <span className="wb-agent-handle">{current ? `@${current.handle} · ${current.model}` : '—'}</span>
          </span>
          <span aria-hidden="true" className="text-muted">
            ▾
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="wb-menu" align="start" sideOffset={6}>
          <DropdownMenu.Label className="wb-menu-label">Agents</DropdownMenu.Label>
          {agents.map((agent) => (
            <DropdownMenu.Item
              key={agent.id}
              className="wb-menu-item"
              disabled={!agent.available}
              onSelect={() => agent.available && onSelect(agent.id)}
            >
              <span className="min-w-0">
                <span className="block font-semibold">{agent.name}</span>
                <span className="wb-menu-note">
                  {agent.available ? `@${agent.handle} · ${agent.model}` : agent.unavailableReason ?? 'unavailable'}
                </span>
              </span>
              {agent.id === current?.id ? <span aria-hidden="true">✓</span> : null}
            </DropdownMenu.Item>
          ))}
          {agents.length === 0 ? <div className="wb-menu-note px-2 py-1.5">No agents are configured.</div> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
