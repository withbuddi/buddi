/**
 * The platform's own tools, by name — the one place the page knows them.
 *
 * `canvas/renderables.ts` knows the name of no tool; the page hands it these
 * two lists as data, the way `chat/sources.ts` hands it the web reader's.
 * Every name here is a core tool every install has (the owner's profile,
 * memory, the team, the time, reminders, goals and schedules), never a
 * plugin's.
 */

/**
 * Tools an agent calls to know its owner and itself, not to show them
 * anything: reading the profile and the first run's state, a memory lookup,
 * who else is on the team.
 *
 * Their results are context for the agent. Drawn as a Canvas tab each, they
 * take the screen from the work with the owner's own details read back to
 * them, so the canvas leaves them out (`renderablesFrom`'s `quiet`). The step
 * row in the conversation still opens one on the Canvas when the owner
 * expands it, and a failure still keeps its tab — nothing that went wrong is
 * hidden.
 *
 * Reads only. A write (setting the profile, a rename, finishing the first run,
 * a note or a preference kept) changed something the owner should see, so it
 * keeps its tab like any other effect.
 */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  'owner.get_profile',
  'memory.recall',
  'memory.get_preferences',
  'memory.people',
  'memory.person',
  'platform.list_agents',
  'platform.read_agent',
  'platform.installed_tools',
  'platform.list_skills',
  'platform.list_accounts',
  'platform.list_groups',
  'system.time',
]);

/**
 * What a platform tool's result is called on the owner's screen. A plugin's
 * tool says what it is through its view descriptor's title; these have no
 * descriptor, and their names are written for the model.
 */
export const OWN_TOOL_TITLES: ReadonlyMap<string, string> = new Map([
  ['owner.get_profile', 'Your profile'],
  ['owner.set_profile', 'Your profile, updated'],
  ['owner.rename_me', 'A new name'],
  ['owner.finish_onboarding', 'First run finished'],
  ['memory.recall', 'From memory'],
  ['memory.note', 'Noted'],
  ['memory.get_preferences', 'Your preferences'],
  ['memory.remember_preference', 'A preference, kept'],
  ['memory.people', 'People you know'],
  ['memory.person', 'Someone you know'],
  ['platform.list_agents', 'Your team'],
  ['platform.read_agent', 'An agent, in detail'],
  ['platform.installed_tools', 'Installed tools'],
  ['platform.list_skills', 'Skills'],
  ['platform.list_accounts', 'Accounts'],
  ['platform.list_groups', 'Groups'],
  ['platform.catalogue', 'Agents you can add'],
  ['system.time', 'The time'],
  ['system.info', 'This Mac'],
  ['reminder.list', 'Reminders'],
  ['schedule.list_mine', 'Scheduled runs'],
  ['goal.list', 'Goals'],
  ['goal.status', 'How a goal is going'],
]);
