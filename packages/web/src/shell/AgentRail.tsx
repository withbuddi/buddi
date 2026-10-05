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
 *  - **The dot on a face is state, never activity.** The Home badge's colour
 *    means "waiting on you": a pending approval, or a question the agent is
 *    holding for an answer. The accent means "working right now", and goes
 *    when the run does. Nothing accumulates: a face that is always dotted is a
 *    face the owner stops reading. There are no unread counts.
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
import React, { useEffect, useState } from 'react';
import type { ChatAgent } from '../chat/types';
import { fmtAgo } from '../format';
import { canGroup, faceState, waitingShort, waitingText, type AgentAttention, type AgentGroups, type FaceState } from './roster';
import type { GroupView } from '../chat/types';
import { FaceMark } from '../views/parts/Avatar';
import { Icon } from '../ui/Icon';
import { accentAttrs, accentOf } from './accent';
import { AGENTS_ROUTE } from '../routes';

export interface AgentRailProps {
  /** Already grouped and ordered — `groupAgents` decides, in one place. */
  agents: AgentGroups;
  currentId: string | null;
  attention: Map<string, AgentAttention>;
  onSelect: (agentId: string) => void;
  /** Horizontal, for the narrow layout where a second column does not fit. */
  orientation?: 'vertical' | 'horizontal';
  /** When each agent last spoke, by id, for the quiet line under the name. */
  lastActivity?: Map<string, string>;
  /** Who is working right now, by id: the accent dot on their face. */
  working?: ReadonlySet<string>;
  /** The owner's groups, drawn under the agents with stacked faces. */
  groups?: GroupView[];
  currentGroupId?: string | null;
  onSelectGroup?: (groupId: string) => void;
  onNewGroup?: () => void;
}

/* A new key: the old one meant "faces only", and an owner who had chosen that
   should not open the chat to find the whole list gone. */
const COLLAPSED_KEY = 'buddi.rosterHidden';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHORTCUT_LABEL = MAC ? '⌘\\' : 'Ctrl+\\';
const SHORTCUT_ARIA = MAC ? 'Meta+\\' : 'Control+\\';

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}
function storeCollapsed(value: boolean): void {
  try { window.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0'); } catch { /* a private window forgets */ }
}

export function AgentRail({
  agents,
  currentId,
  attention,
  onSelect,
  orientation = 'vertical',
  lastActivity,
  working,
  groups = [],
  currentGroupId = null,
  onSelectGroup,
  onNewGroup,
}: AgentRailProps): JSX.Element {
  const everyone = [...agents.top, ...agents.middle, ...agents.bottom];
  const side = orientation === 'vertical' ? 'right' : 'bottom';
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const face = (agent: ChatAgent): JSX.Element => (
    <AgentFace
      key={agent.id}
      agent={agent}
      active={agent.id === currentId}
      attention={attention.get(agent.id)}
      side={side}
      onSelect={onSelect}
      lastAt={lastActivity?.get(agent.id) ?? null}
      working={working?.has(agent.id) ?? false}
    />
  );

  const toggle = (): void => setCollapsed((value) => { storeCollapsed(!value); return !value; });

  // ⌘\ (Ctrl+\ off a Mac) hides and shows the list from anywhere on the chat.
  useEffect(() => {
    if (orientation !== 'vertical') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setCollapsed((value) => { storeCollapsed(!value); return !value; });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orientation]);

  /*
   * Hidden, the list is a thin tab on the chat's left edge: the one control
   * that brings it back. It wears the waiting dot when somebody needs the
   * owner, so putting the team away never puts that away.
   */
  if (orientation === 'vertical' && collapsed) {
    const waiting = everyone.some((agent) => waitingText(attention.get(agent.id)) !== null);
    return (
      <button
        type="button"
        className="wb-roster-tab"
        data-testid="agent-rail-tab"
        aria-label={waiting ? 'Show the list — someone is waiting for you' : 'Show the list'}
        aria-keyshortcuts={SHORTCUT_ARIA}
        title={`Show the list (${SHORTCUT_LABEL})`}
        onClick={toggle}
      >
        <Icon name="chevron-right" />
        {waiting ? <span className="wb-roster-tab-dot" aria-hidden="true" /> : null}
      </button>
    );
  }

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
      {/* The kit's heading over the colleagues, with the way to put the list
          away at its right end: the control sits on the line it acts on. */}
      {orientation === 'vertical' ? (
        <div className="wb-roster-head">
          <span className="wb-roster-label">Your team</span>
          <button
            type="button"
            className="ui-icon-btn wb-roster-toggle"
            data-size="sm"
            aria-label="Hide the list"
            aria-keyshortcuts={SHORTCUT_ARIA}
            title={`Hide the list (${SHORTCUT_LABEL})`}
            onClick={toggle}
          >
            <Icon name="chevron-left" />
          </button>
        </div>
      ) : null}

      {/*
        The middle is the part that scrolls. That is what keeps both ends
        *pinned* rather than merely first and last: a rail of twenty agents
        scrolls between the front desk and the maker, and neither of them ever
        leaves the screen.
      */}
      <div className="wb-agent-scroll">
        {agents.middle.map(face)}
        {/*
          Groups need somebody to group.

          On a fresh installation the rail holds one assistant and the agent
          that makes agents — and the second of those is a settings door, not a
          colleague. A + button there offers a room the owner cannot fill, and
          the sheet behind it would refuse them. So until two agents who could
          share a room exist, the heading stays without its + and says what it
          needs, with the way to get there: a hidden section teaches nothing.
        */}
        {onSelectGroup && canGroup(everyone) ? (
          <div className="wb-groups" data-testid="group-rail">
            <span className="wb-agent-sep" aria-hidden="true" />
            <div className="wb-groups-head">
              <span className="wb-groups-label">Groups</span>
              {onNewGroup ? (
                <button type="button" className="ui-icon-btn" data-size="sm" aria-label="New group" title="A team of agents in one conversation" onClick={onNewGroup}>
                  <Icon name="plus" />
                </button>
              ) : null}
            </div>
            {groups.map((group) => (
              <button
                type="button"
                key={group.id}
                className="wb-face wb-group-face"
                data-active={group.id === currentGroupId ? 'true' : undefined}
                aria-current={group.id === currentGroupId ? 'true' : undefined}
                aria-label={`${group.name}, ${group.members.length} agents`}
                onClick={() => onSelectGroup(group.id)}
              >
                {/* The first two faces, crossed on the diagonal inside the
                    same square as an agent's face; the line below names everyone. */}
                <span className="wb-group-stack" aria-hidden="true">
                  {group.members.slice(0, 2).map((id) => {
                    const agent = everyone.find((a) => a.id === id);
                    return <FaceMark key={id} className="wb-group-chip" id={id} name={agent?.name ?? '?'} face={agent} initials={1} />;
                  })}
                </span>
                <span className="wb-face-text">
                  <span className="wb-face-name">{group.name}</span>
                  <span className="wb-face-status">{group.members.map((id) => everyone.find((a) => a.id === id)?.name ?? id).join(', ')}</span>
                </span>
              </button>
            ))}
          </div>
        ) : onSelectGroup ? (
          <div className="wb-groups" data-testid="group-rail-hint">
            <span className="wb-agent-sep" aria-hidden="true" />
            <div className="wb-groups-head">
              <span className="wb-groups-label">Groups</span>
            </div>
            <p className="wb-groups-hint">
              A group needs two agents; <a href={AGENTS_ROUTE}>add a teammate</a>.
            </p>
          </div>
        ) : null}
      </div>

      {/*
        No second line at the foot. One line says "the desk, then the work"; two
        would make the rail read as three equal sections and give the workshop
        the same weight as the front desk. The gap and the foot position say it
        already — the same way the theme control sits at the bottom of the rail
        beside this one.
      */}
      {/* The maker is the last thing in the column: no row under it. */}
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
  lastAt = null,
  working = false,
}: {
  agent: ChatAgent;
  active: boolean;
  attention: AgentAttention | undefined;
  side: 'right' | 'bottom';
  onSelect: (agentId: string) => void;
  lastAt?: string | null;
  /** A run of this agent's is going right now. */
  working?: boolean;
}): JSX.Element {
  const waiting = waitingText(attention);
  // Short and quiet: the claim on the owner, why it cannot run, how long ago
  // it spoke, or — never having spoken — what it does, on one line.
  const status = waitingShort(attention)
    ?? (!agent.available
      ? (agent.unavailableReason ?? 'Cannot run right now')
      : lastAt
        ? fmtAgo(lastAt)
        : agent.description);
  const state: FaceState | null = faceState(attention, working && agent.available);
  const reason = agent.unavailableReason ?? 'This agent cannot run on this machine right now.';

  // One sentence, in the order it matters: who, whether they can work, and
  // whether they want something. This is the whole of what a screen reader
  // gets, because the chip itself says only "AB". The handle is not drawn in
  // the row any more, so it is said here, beside the name it belongs to.
  const label = [
    `${agent.name} @${agent.handle}`,
    agent.available ? null : 'unavailable',
    waiting,
    state === 'working' ? 'working now' : null,
    active ? 'current' : null,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' — ');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          className="wb-face"
          {...accentAttrs(accentOf(agent))}
          data-active={active ? 'true' : undefined}
          data-unavailable={agent.available ? undefined : 'true'}
          data-testid={`agent-face-${agent.id}`}
          aria-label={label}
          aria-current={active ? 'true' : undefined}
          disabled={!agent.available}
          onClick={() => agent.available && onSelect(agent.id)}
        >
          <span className="wb-face-frame">
            <FaceMark className="wb-face-mark" id={agent.id} name={agent.name} face={agent} />
            {state ? (
              <span className="wb-face-dot" data-state={state} data-testid={`agent-dot-${agent.id}`} aria-hidden="true" />
            ) : null}
          </span>
          {/* The name alone on the title line: the handle lives in the chat
              header, the @-picker, the tooltip and this row's accessible name. */}
          <span className="wb-face-text" aria-hidden="true">
            <span className="wb-face-name">{agent.name}</span>
            <span className="wb-face-status" data-tone={waiting ? 'critical' : undefined}>{status}</span>
          </span>
          {agent.available ? null : (
            <span className="wb-face-out" aria-hidden="true">
              <Icon name="out" />
            </span>
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tip" side={side} sideOffset={8}>
          <span className="ui-tip-title">{agent.name}</span>
          <span className="ui-tip-hint">
            {agent.available ? `@${agent.handle} · ${agent.model}` : reason}
          </span>
          {waiting ? <span className="ui-tip-alert">{sentence(waiting)}</span> : null}
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



