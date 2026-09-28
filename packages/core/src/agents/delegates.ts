/**
 * Who an agent may ask with `agent.delegate`, as a rule rather than a file.
 *
 * The installation keeps each agent's allowlist in `agents/<id>/delegates.json`
 * (the gateway reads it; core never touches the disk for it). This module says
 * what a stored list *means*:
 *
 *  - `"*"` in the list means everyone: every other agent in the catalog, new
 *    ones included, without the list ever being edited again;
 *  - an agent that answers for the **front desk** or the **maker** role and has
 *    no list at all asks everyone — the default is computed from the role, not
 *    written into a file. The front desk exists to hand work to whoever owns
 *    it, and the maker to wire up what it just made; an explicit list on either
 *    still narrows it, so the owner can restrict them;
 *  - every other agent asks exactly the ids its list names, and nobody when it
 *    has no list (fail closed).
 *
 * "Everyone" is resolved against the ids the caller passes. The host removes
 * any agent that may not be reached by delegation at all (an agent that can
 * write the installation) before it passes them: that rule outranks this one.
 */

/** The allowlist entry that means "every other agent". */
export const DELEGATE_EVERYONE = '*';

/** The roles that may ask anyone by default. */
export const OPEN_DELEGATION_ROLES = ['front-desk', 'maker'] as const;
export type OpenDelegationRole = (typeof OPEN_DELEGATION_ROLES)[number];

/** The role that opens this agent's delegation by default, if it holds one. */
export function openDelegationRole(roles: readonly string[]): OpenDelegationRole | undefined {
  return OPEN_DELEGATION_ROLES.find((role) => roles.includes(role));
}

/**
 * What an agent's allowlist amounts to.
 *
 * `everyone` says why: the role that opened it by default, or `'list'` when the
 * stored list itself holds `"*"`. `stored` is the file as read, `undefined`
 * when there is no file.
 */
export type DelegateScope =
  | { kind: 'everyone'; because: OpenDelegationRole | 'list' }
  | { kind: 'list'; ids: string[] };

export function delegateScope(
  agent: { roles: readonly string[] },
  stored: readonly string[] | undefined,
): DelegateScope {
  if (stored?.includes(DELEGATE_EVERYONE)) {
    return { kind: 'everyone', because: openDelegationRole(agent.roles) ?? 'list' };
  }
  if (stored === undefined) {
    const role = openDelegationRole(agent.roles);
    if (role !== undefined) return { kind: 'everyone', because: role };
  }
  return { kind: 'list', ids: [...new Set(stored ?? [])] };
}

/**
 * The ids this agent may ask. `everyone` is the catalog's ids the host allows
 * as targets at all; the agent itself is never among the result.
 */
export function resolveDelegates(
  agent: { id: string; roles: readonly string[] },
  stored: readonly string[] | undefined,
  everyone: readonly string[],
): string[] {
  const scope = delegateScope(agent, stored);
  if (scope.kind === 'list') return scope.ids;
  return [...new Set(everyone)].filter((id) => id !== agent.id);
}
