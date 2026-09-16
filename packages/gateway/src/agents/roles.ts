/**
 * The roles the *surfaces* ask for.
 *
 * Core validates the shape of a `roles:` entry and nothing else — it ships no
 * vocabulary, because an installation with different agents invents its own.
 * What is written down here is only what buddi's own surfaces look up: the
 * commands every surface offers, and the fallback speaker for an infrastructure
 * mission. A plugin's suggested missions name roles too, by the same strings.
 *
 * Nothing here names an agent. `/status` runs whoever claims `overview`; if
 * nobody does, the command says so and how to claim it.
 */

/** `/status`: the agent that can say where the owner stands right now. */
export const ROLE_OVERVIEW = 'overview';

/** `/recap`: the agent whose recap mission `/recap` runs on demand. */
export const ROLE_RECAP = 'recap';

/**
 * `/new`: the agent that makes other agents. Shipped `agent-father` claims it,
 * but the command is keyed to the role and not to that file — an installation
 * that writes its own maker keeps the command by claiming `maker`, and one with
 * no maker at all has no menu entry for it rather than a dead one.
 */
export const ROLE_MAKER = 'maker';

/**
 * The front desk: the agent that explains the installation and hands work to
 * whoever owns it. Claimed by the shipped `concierge`, and by the owner's if
 * they wrote their own.
 *
 * It is a role and not an id for the same reason every other one here is: the
 * owner may rename their front desk, replace it with their own, or have none at
 * all, and the dashboard's agent rail — which anchors this agent above a
 * separator, because it is the one you go to when you do not know who to go to
 * — must survive all three without knowing any agent's name.
 */
export const ROLE_FRONT_DESK = 'front-desk';

export const SURFACE_ROLES = [ROLE_OVERVIEW, ROLE_RECAP, ROLE_MAKER, ROLE_FRONT_DESK] as const;
