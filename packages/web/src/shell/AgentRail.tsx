/**
 * The second rail: the team, one face each.
 *
 * This replaces a dropdown at the head of the conversation, and the saved click
 * is the least of it. A dropdown can only ever show the state of the agent you
 * already chose; the others are behind a chevron, which means "someone is
 * waiting for you" had nowhere to live in this window. A rail gives it a home —
 * and it changes what the product reads as, from one assistant with a mode
 * switch to the team the owner actually built.
 *
 * Four rules, each of which is a way this could go wrong:
 *
 *  - **A badge means "waiting on you", and nothing else.** A pending approval,
 *    or a question the agent is holding for an answer. Not activity: a face
 *    that is always dotted is a face the owner stops reading, and this is the
 *    worst possible place to teach that lesson. There are no unread counts.
 *  - **An agent that cannot run says so.** Scout has no credential some days. A
 *    greyed, undimmable face with the reason on hover is a fixable
 *    configuration problem; a face that fails when clicked is a mystery.
 *  - **The order never moves, and it says something.** The front desk at the
 *    head above a short line — it is where you go when you do not know who you
 *    need. The colleagues who act on the owner's life in the middle, the
 *    default one first and then by name. The maker that configures the
 *    installation pinned to the foot, where a settings door belongs. Which
 *    agent is which comes from the server as `'top'` / `'bottom'`, derived from
 *    roles, so this file never learns anybody's name; an end nobody claims is
 *    simply empty, and the line is drawn only where it divides something.
 *  - **The name is what is announced.** The chip draws initials, which are a
 *    mnemonic and not a word; `aria-label` carries the name, the availability
 *    and the reason anyone is waiting.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ChatAgent } from '../chat/types';
import { badgeOf, monogram, waitingText, type AgentAttention, type AgentGroups } from './roster';

export interface AgentRailProps {
  /** Already grouped and ordered — `groupAgents` decides, in one place. */
  agents: AgentGroups;
  currentId: string | null;
  attention: Map<string, AgentAttention>;
  onSelect: (agentId: string) => void;
  /** Horizontal, for the narrow layout where a second column does not fit. */
  orientation?: 'vertical' | 'horizontal';
}

export function AgentRail({
  agents,
  currentId,
  attention,
  onSelect,
  orientation = 'vertical',
}: AgentRailProps): JSX.Element {
  const side = orientation === 'vertical' ? 'right' : 'bottom';
  const face = (agent: ChatAgent): JSX.Element => (
    <AgentFace
      key={agent.id}
      agent={agent}
      active={agent.id === currentId}
      attention={attention.get(agent.id)}
      side={side}
      onSelect={onSelect}
    />
  );

  return (
    <nav
      className={orientation === 'vertical' ? 'wb-agent-rail' : 'wb-agent-strip'}
      aria-label="Agents"
      data-testid="agent-rail"
    >
      {agents.top.map(face)}

      {/*
        The line divides the desk from the work, so it is drawn only when there
        is work below it. With nothing in the middle — a fresh clone has exactly
        a front desk and a maker — a line under the first face would be a border
        rather than a grouping, and the two ends of the rail already read as two
        ends. Decorative either way, so it is hidden from the reading order.
      */}
      {agents.top.length > 0 && agents.middle.length > 0 ? (
        <span className="wb-agent-sep" data-testid="agent-rail-sep" aria-hidden="true" />
      ) : null}

      {/*
        The middle is the part that scrolls. That is what keeps both ends
        *pinned* rather than merely first and last: a rail of twenty agents
        scrolls between the front desk and the maker, and neither of them ever
        leaves the screen.
      */}
      <div className="wb-agent-scroll">{agents.middle.map(face)}</div>

      {/*
        No second line at the foot. One line says "the desk, then the work"; two
        would make the rail read as three equal sections and give the workshop
        the same weight as the front desk. The gap and the foot position say it
        already — the same way the theme control sits at the bottom of the rail
        beside this one.
      */}
      {agents.bottom.map(face)}
    </nav>
  );
}

export function AgentFace({
  agent,
  active,
  attention,
  side,
  onSelect,
}: {
  agent: ChatAgent;
  active: boolean;
  attention: AgentAttention | undefined;
  side: 'right' | 'bottom';
  onSelect: (agentId: string) => void;
}): JSX.Element {
  const waiting = waitingText(attention);
  const badge = badgeOf(attention);
  const reason = agent.unavailableReason ?? 'This agent cannot run on this machine right now.';

  // One sentence, in the order it matters: who, whether they can work, and
  // whether they want something. This is the whole of what a screen reader
  // gets, because the chip itself says only "AB".
  const label = [
    agent.name,
    agent.available ? null : 'unavailable',
    waiting,
    active ? 'current' : null,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' — ');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          className="wb-face"
          data-tint={tintOf(agent.id)}
          data-active={active ? 'true' : undefined}
          data-unavailable={agent.available ? undefined : 'true'}
          data-testid={`agent-face-${agent.id}`}
          aria-label={label}
          aria-current={active ? 'true' : undefined}
          disabled={!agent.available}
          onClick={() => agent.available && onSelect(agent.id)}
        >
          <span className="wb-face-mark" aria-hidden="true">
            {monogram(agent.name)}
          </span>
          {badge ? (
            <span
              className="wb-face-badge"
              data-kind={badge.count === null ? 'dot' : 'count'}
              data-testid={`agent-badge-${agent.id}`}
              aria-hidden="true"
            >
              {badge.count === null ? '' : badge.count}
            </span>
          ) : null}
          {agent.available ? null : (
            <span className="wb-face-out" aria-hidden="true">
              <OutIcon />
            </span>
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="wb-tip" side={side} sideOffset={8}>
          <span className="wb-tip-title">{agent.name}</span>
          <span className="wb-tip-hint">
            {agent.available ? `@${agent.handle} · ${agent.model}` : reason}
          </span>
          {waiting ? <span className="wb-tip-alert">{sentence(waiting)}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** "one approval is waiting for you" → "One approval is waiting for you." */
function sentence(text: string): string {
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}.`;
}

/**
 * A stable tint per agent, so six faces are six things rather than six of the
 * same thing. Derived from the id, which does not change, and resolved to one
 * of a small set of tokens — the palette still lives in `tokens.css`.
 */
export function tintOf(agentId: string): number {
  let hash = 0;
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return (hash % 6) + 1;
}

/** A struck-through circle: out of service, not merely quiet. */
function OutIcon(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <circle cx="6" cy="6" r="4.4" />
      <path d="M3.4 8.6 8.6 3.4" />
    </svg>
  );
}
