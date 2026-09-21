/**
 * The names of the `platform.*` tools, and the one rule that has to hold in
 * more than one place.
 *
 * Confining the write tools to a single agent is only worth something if the
 * confinement cannot be undone from inside the system. Two doors have to stay
 * shut, and both of them are checked somewhere other than this file:
 *
 *  - an approved `platform.create_agent` must not be able to hand the write
 *    tools to a *second* agent (a grant the owner approves once, and a new
 *    writer forever after);
 *  - a `delegates.json` must not be able to name a writer, because delegation
 *    would then be a corridor from any agent straight to the write tools —
 *    including from the agent that reads untrusted email.
 *
 * The names live here, in a module that imports nothing, so the catalog loader,
 * the delegation wiring and the tools themselves can all state the same rule
 * without importing each other.
 */

/** The tools that change the installation. Grantable only by hand. */
export const PLATFORM_WRITE_TOOLS: readonly string[] = [
  'platform.create_group',
  'platform.update_group',
  'platform.archive_group',
  'platform.create_agent',
  'platform.update_agent',
  'platform.write_skill',
  'platform.delete_agent',
  // Accepting a plugin's proposal creates a principal and writes a skill into
  // the prompt of every agent. They are the same kind of act as the four above
  // and are confined the same way: grantable only by the owner, by hand, and
  // never reachable through a delegation corridor.
  'platform.accept_plugin_agent',
  'platform.accept_plugin_skill',
];

/** The tools that only look. Safe to grant to anybody. */
export const PLATFORM_READ_TOOLS: readonly string[] = [
  'platform.list_accounts',
  'platform.list_agents',
  'platform.installed_tools',
  'platform.read_agent',
  'platform.list_skills',
  'platform.plugin_agents',
];

/** Does this grant include any tool that can write the installation? */
export function writeToolsIn(tools: readonly string[]): string[] {
  return tools.filter((name) => PLATFORM_WRITE_TOOLS.includes(name));
}

/** The sentence a refused delegation to a writer prints, wherever it is caught. */
export function delegateToWriterRefusal(caller: string, target: string, held: readonly string[]): string {
  return (
    `${caller} may not delegate to ${target}: ${target} holds ${held.join(', ')}, and delegation would ` +
    `let anything that can reach ${caller} reach those tools through it. Creating and changing agents ` +
    'stays with the one agent the owner switches to deliberately — remove it from the allowlist.'
  );
}
