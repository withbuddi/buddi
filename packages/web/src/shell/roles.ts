/**
 * The roles buddi's own surfaces look an agent up by.
 *
 * A role is not a capability: it is how `/status`, `/recap`, `/new` and the
 * rail find an agent without naming one. The gateway keeps the same four in
 * `packages/gateway/src/agents/roles.ts`; the page keeps its own copy, with the
 * words the owner reads, rather than import from the server. Any other role an
 * agent declares is only read by a plugin that asks for it by name.
 *
 * The order is the order the Setup tab shows them and saves them in.
 */
export interface KnownRole {
  id: string;
  label: string;
  /** What holding it means, in one line. */
  meaning: string;
}

export const FRONT_DESK_ROLE = 'front-desk';

export const KNOWN_ROLES: readonly KnownRole[] = [
  { id: FRONT_DESK_ROLE, label: 'Front desk', meaning: 'Where things go when you do not say who.' },
  { id: 'overview', label: 'Overview', meaning: 'Answers /status and speaks for the watchers.' },
  { id: 'recap', label: 'Recap', meaning: 'Runs /recap.' },
  { id: 'maker', label: 'Maker', meaning: '/new opens its interview.' },
];

const KNOWN_IDS = new Set(KNOWN_ROLES.map((role) => role.id));

export const isKnownRole = (role: string): boolean => KNOWN_IDS.has(role);

/** The saved order: the known roles first, in the order above, then the others as written. */
export function orderRoles(known: ReadonlySet<string>, others: readonly string[]): string[] {
  const rest = others.filter((role) => !KNOWN_IDS.has(role));
  return [...KNOWN_ROLES.filter((role) => known.has(role.id)).map((role) => role.id), ...rest.filter((role, i) => rest.indexOf(role) === i)];
}

/**
 * Who holds a role among the agents as the catalog lists them: the first to
 * claim it, which is the one the surfaces pick.
 */
export function holderOf<A extends { id: string; roles?: readonly string[] }>(agents: readonly A[], role: string): A | undefined {
  return agents.find((agent) => (agent.roles ?? []).includes(role));
}
