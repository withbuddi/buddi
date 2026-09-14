/**
 * The roles the *surfaces* ask for.
 *
 * Core validates the shape of a `roles:` entry and nothing else — it ships no
 * vocabulary, because an installation with different agents invents its own.
 * What is written down here is only what buddi's own surfaces look up: the two
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

export const SURFACE_ROLES = [ROLE_OVERVIEW, ROLE_RECAP] as const;
