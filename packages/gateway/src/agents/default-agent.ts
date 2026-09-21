/**
 * Which agent is the default: an installation record, not a file flag.
 *
 * "The agent a chat that names nobody lands on" is a choice the owner makes
 * about *this machine*. It used to live as `default: true` in one agent file,
 * which made it a property of a persona — and a fragile one: two files could
 * claim it and the installation refused to boot, none could and it refused to
 * boot, and moving it meant rewriting two files in one atomic write.
 *
 * So it lives in `core.web_settings` under the `agents` key, beside the other
 * small dashboard facts (migration 030). The database rather than a file
 * beside `plugins.json` for one reason: the dashboard and the Telegram surface
 * are different processes, and a row is a fact both of them read. A file would
 * have made "the owner changed the default" mean "restart the other process".
 *
 * The catalog loader is synchronous and core never touches SQL, so the record
 * is read once and *held* here, and `loadGatewayCatalog` hands the held value
 * to core on every load. Writing it updates the held value in the same call,
 * which is what makes a change visible to the very next `catalog.reload()`.
 */
import { readWebSetting, writeWebSetting } from '@buddi/core';

/** The `core.web_settings` key. One key for agent-wide dashboard facts. */
export const AGENTS_SETTING_KEY = 'agents';

/** The shape stored under it. Room for more agent-wide facts later. */
export interface AgentsSetting {
  /** The catalog id of the agent every chat with no agent named lands on. */
  defaultAgent?: string;
}

/** The slice of `pg.Pool` this needs. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * The process's held copy of the record.
 *
 * Deliberately module state: the catalog loader is called from surfaces that
 * have no pool in hand (the CLI's doctor, a mission runner), and the honest
 * answer for a process that never read the database is "no record", which
 * falls back to the file flag exactly as it always did.
 */
let held: string | undefined;

/** The recorded default as this process last saw it. */
export function recordedDefaultAgent(): string | undefined {
  return held;
}

/** Replace the held copy. Pass `undefined` to forget it (tests). */
export function setRecordedDefaultAgent(agentId: string | undefined): void {
  held = agentId === undefined || agentId.trim() === '' ? undefined : agentId.trim();
}

/**
 * Read the record and hold it. Returns what was found, or nothing.
 *
 * A malformed value is nothing: the file flag then decides, which is a working
 * installation rather than one that will not start because a row is wrong.
 */
export async function loadDefaultAgentRecord(db: Queryable): Promise<string | undefined> {
  let value: AgentsSetting | null = null;
  try {
    value = await readWebSetting<AgentsSetting>(db as never, AGENTS_SETTING_KEY);
  } catch {
    return undefined;
  }
  const id = typeof value?.defaultAgent === 'string' ? value.defaultAgent.trim() : '';
  setRecordedDefaultAgent(id === '' ? undefined : id);
  return recordedDefaultAgent();
}

/**
 * Record a default agent, and hold it, in that order.
 *
 * The write comes first so that a failure leaves the process agreeing with the
 * database rather than with an intention.
 */
export async function writeDefaultAgentRecord(db: Queryable, agentId: string): Promise<void> {
  const id = agentId.trim();
  if (id === '') throw new Error('a default agent is named by its id');
  const current = ((await readWebSetting<AgentsSetting>(db as never, AGENTS_SETTING_KEY)) ?? {}) as AgentsSetting;
  await writeWebSetting(db as never, AGENTS_SETTING_KEY, { ...current, defaultAgent: id });
  setRecordedDefaultAgent(id);
}
