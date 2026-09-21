/**
 * The team, and which of them is waiting on the owner.
 *
 * Two pure decisions and one live subscription, kept out of the components so
 * both can be tested without a DOM.
 *
 * **Order is fixed, not felt.** Faces that reshuffle by recency make the owner
 * hunt for the one they want, and a rail whose third face is a different agent
 * every morning is a rail nobody builds muscle memory for.
 *
 * Three zones, top to bottom. The front desk at the head, above a line: it is
 * where you go when you do not yet know who you need, which is the first
 * question of any session. The colleagues who act on the owner's life in the
 * middle, the default one first (it is the one the page opens on) and then by
 * name — stable for the life of the installation, changing only when an agent
 * is added or renamed. And the maker pinned to the foot, where a settings door
 * belongs: reachable, out of the way, not competing for the middle of the rail.
 *
 * The page never learns which agent is which. `anchor` is `'top'`, `'bottom'`
 * or nothing, computed by the server from roles, so an owner who renames their
 * front desk, writes their own, or has none at all gets the right rail — in the
 * last case simply an empty head and no line.
 *
 * **"Waiting" is the server's word.** The page never decides that an agent
 * needs attention; it asks `/api/chat/attention`, whose whole definition lives
 * in one server module. Adding a state here would be adding a second one.
 */
import { useEffect, useState } from 'react';
import { get } from '../api';
import { openChatStream } from '../chat/stream';
import type { ChatAgent } from '../chat/types';

/** One agent's claim on the owner, exactly as the attention endpoint sends it. */
export interface AgentAttention {
  agentId: string;
  approvals: number;
  oldestApprovalAt: string | null;
  question: { at: string; conversationId: string | null } | null;
}

export interface AttentionSnapshot {
  at: string;
  agents: AgentAttention[];
}

/** The SSE endpoint that says "the answer may have changed". */
export const ATTENTION_STREAM = '/api/chat/attention/stream';

/** The rail's three zones. Either end may be empty; usually neither is. */
export interface AgentGroups {
  top: ChatAgent[];
  middle: ChatAgent[];
  bottom: ChatAgent[];
}

/**
 * The three zones, each in its own stable order.
 *
 * `localeCompare` rather than `<` so an accented name sorts where a reader
 * would look for it. Two agents claiming the same end are both pinned there and
 * sort by name — one of them silently winning would be a rail that changes when
 * a file is edited.
 */
export function groupAgents(agents: ChatAgent[], defaultAgentId: string | null): AgentGroups {
  const byName = (a: ChatAgent, b: ChatAgent): number => a.name.localeCompare(b.name);
  const at = (end: 'top' | 'bottom'): ChatAgent[] =>
    agents.filter((agent) => agent.anchor === end).sort(byName);
  const middle = agents
    .filter((agent) => agent.anchor !== 'top' && agent.anchor !== 'bottom')
    .sort((a, b) => {
      if (a.id === defaultAgentId) return b.id === defaultAgentId ? 0 : -1;
      if (b.id === defaultAgentId) return 1;
      return byName(a, b);
    });
  return { top: at('top'), middle, bottom: at('bottom') };
}

/** The same order, flattened — what a caller that does not draw zones wants. */
export function orderAgents(agents: ChatAgent[], defaultAgentId: string | null): ChatAgent[] {
  const groups = groupAgents(agents, defaultAgentId);
  return [...groups.top, ...groups.middle, ...groups.bottom];
}

/**
 * The sentence the badge stands for, or null when nothing is waiting.
 *
 * Written out in full because it is what a screen reader is handed and what the
 * tooltip shows: a red dot the owner has to click to understand is a red dot
 * that trains them to stop clicking.
 */
export function waitingText(attention: AgentAttention | undefined): string | null {
  if (!attention) return null;
  const parts: string[] = [];
  if (attention.approvals > 0) {
    parts.push(
      attention.approvals === 1
        ? 'one approval is waiting for you'
        : `${attention.approvals} approvals are waiting for you`,
    );
  }
  if (attention.question) parts.push('asked you a question and is holding for the answer');
  return parts.length === 0 ? null : parts.join(', and ');
}

/**
 * What the badge draws: a number when there are approvals to count, and a plain
 * dot when the only claim is a question, which is not a quantity.
 */
export function badgeOf(attention: AgentAttention | undefined): { count: number | null } | null {
  if (!attention) return null;
  if (attention.approvals > 0) return { count: attention.approvals };
  if (attention.question) return { count: null };
  return null;
}

export function attentionMap(snapshot: AttentionSnapshot | null): Map<string, AgentAttention> {
  return new Map((snapshot?.agents ?? []).map((entry) => [entry.agentId, entry]));
}

/**
 * The live answer.
 *
 * Fetched once so the page is right at rest, then re-fetched whenever the
 * attention stream says something changed. There is no timer: an approval that
 * arrives while the owner is reading something else lights its face within the
 * quarter-second the log is tailed at, and an approval nobody touches costs
 * nothing at all.
 */
export function useAttention(): Map<string, AgentAttention> {
  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      get<AttentionSnapshot>('/chat/attention')
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => {
          /* No server, or no session yet. The rail simply shows no badges. */
        });
    };
    refresh();
    const handle = openChatStream({ url: ATTENTION_STREAM, onEvent: () => refresh() });
    return () => {
      cancelled = true;
      handle.close();
    };
  }, []);

  return attentionMap(snapshot);
}

/**
 * The role the server gives whoever configures the installation.
 *
 * Named here as a *role* and never as an agent: the page does not know that
 * the shipped maker is called Agent Father, and an owner who writes their own
 * maker gets the same behaviour.
 */
export const ROLE_MAKER = 'maker';

/**
 * Who could be put in a group together.
 *
 * A group is two or more colleagues in one conversation. The maker is not one
 * of them: it is the door to the installation's settings, and a "group" of the
 * agent that makes agents and the one agent you have is not a team, it is the
 * only two faces on the rail. An agent that cannot run is not one either — a
 * room whose member has no account answers nothing.
 */
export function groupableAgents(agents: readonly ChatAgent[]): ChatAgent[] {
  return agents.filter((agent) => agent.available && !agent.roles.includes(ROLE_MAKER));
}

/** Is there anyone to group? Two is the smallest room. */
export function canGroup(agents: readonly ChatAgent[]): boolean {
  return groupableAgents(agents).length >= 2;
}

/** Whoever makes agents here, by role, for a sentence that sends the owner there. */
export function makerName(agents: readonly ChatAgent[]): string {
  return agents.find((agent) => agent.roles.includes(ROLE_MAKER))?.name ?? 'the agent maker';
}

/**
 * The stand-in an agent file may write where the owner's own assistant's name
 * belongs: `Rename {{default}} and change its face`.
 *
 * A shipped example cannot know what the owner called their assistant, and a
 * starter reading "Rename your default agent" is not a sentence anybody types.
 * So the file writes the token and the page — which has the roster in front of
 * it — puts the name in. Nothing is resolved on the server: the roster is what
 * knows which agent is the default here, and it is already on this page.
 */
export const DEFAULT_AGENT_TOKEN = '{{default}}';

/** One starter, as the owner reads it. Unknown default: a plain noun phrase. */
export function resolveStarter(text: string, defaultAgentName: string | null): string {
  return text.split(DEFAULT_AGENT_TOKEN).join(defaultAgentName ?? 'your assistant');
}

/** The starters of an agent, resolved and capped, or an empty list. */
export function startersOf(
  agent: { starters?: string[] } | null,
  defaultAgentName: string | null,
): string[] {
  return (agent?.starters ?? []).slice(0, 3).map((text) => resolveStarter(text, defaultAgentName));
}

/**
 * What an agent says it does, to the owner.
 *
 * `intro` is written for them; `description` is written for other agents to
 * read when they decide whom to hand work to. The second is a decent fallback
 * and a poor first choice.
 */
export function introOf(agent: { intro?: string; description?: string } | null): string {
  const intro = agent?.intro?.trim();
  return intro && intro !== '' ? intro : (agent?.description?.trim() ?? '');
}

/** One or two letters, so an agent is recognisable before it is read. */
export function monogram(name: string | undefined): string {
  const words = (name ?? '·').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Why an agent cannot answer, and where the owner fixes it.
 *
 * One sentence, the server's own words — the page never decides what is
 * missing, exactly as it never decides who is waiting. Everywhere this agent
 * appears greyed says the same thing: the rail's tooltip, its card on the
 * Agents page, its tile on Home, and the composer, which is replaced by it.
 */
export function cannotRunSentence(agent: {
  name?: string;
  unavailableReason?: string;
  heldBack?: { message: string };
}): string {
  /*
   * A held-back agent's sentence is already whole — "Needs the finance
   * plugin." — and it is about the *installation*, not about this agent being
   * broken. Prefixing "Scout cannot run:" onto it would read as a fault in the
   * file the owner wrote, which is exactly what it is not.
   */
  const held = agent.heldBack?.message.trim();
  if (held !== undefined && held !== '') return `${agent.name ?? 'This agent'} is held back. ${held}`;
  const reason = agent.unavailableReason?.trim();
  return reason && reason !== ''
    ? `${agent.name ?? 'This agent'} cannot run: ${reason}`
    : `${agent.name ?? 'This agent'} cannot run: it has no model account yet.`;
}

/** Where that is fixed. The one place an account is added or enabled. */
export const MODEL_ACCOUNTS_LABEL = 'Settings → Model accounts';

/** And where a missing plugin is fixed: the one place a plugin is installed. */
export const PLUGINS_LABEL = 'Install it in Settings → Plugins';

/**
 * Which settings section the greyed agent's link should open: the plugin page
 * when a plugin is what is missing, the accounts page otherwise. One helper so
 * the rail, the Agents page and the composer never disagree about the door.
 */
export function cannotRunFix(agent: { heldBack?: { message: string } } | null | undefined): {
  section: 'plugins' | 'accounts';
  label: string;
} {
  return agent?.heldBack
    ? { section: 'plugins', label: PLUGINS_LABEL }
    : { section: 'accounts', label: MODEL_ACCOUNTS_LABEL };
}
