/**
 * The strip a new agent's chat opens with, once (docs/agents.md, "Delegation").
 *
 * An agent the maker creates joins the team asking everyone (`["*"]`, see
 * `defaultDelegatesFor`). The owner hears it on the approval card and again,
 * the first time they open its chat, as one dismissible line: who it may ask,
 * who may ask it, and a link to Setup. Which agents still owe that line is a
 * short list in `core.web_settings` under `agent-intro`: an id goes in when
 * `platform.create_agent` writes the agent, and out when the owner closes the
 * strip. Agents that existed before this never enter it.
 */
import path from 'node:path';
import { delegateScope, readWebSetting, type AgentCatalog, type Queryable } from '@buddi/core';
import { readDelegatesFile, resolveAllowlist } from './delegation.js';

/** The `core.web_settings` key. */
export const AGENT_INTRO_KEY = 'agent-intro';

interface AgentIntroSetting {
  /** Agent ids whose first-open strip is still due. */
  pending?: string[];
}

/** One agent as the strip names it. */
export interface IntroAgent {
  id: string;
  handle: string;
  name: string;
  /** The front desk: named as "the front desk" rather than by handle. */
  frontDesk?: true;
}

export type AgentIntroView =
  | { show: false }
  | { show: true; id: string; handle: string; asks: 'everyone' | IntroAgent[]; askedBy: IntroAgent[] };

async function readPending(db: Queryable): Promise<string[]> {
  try {
    const value = await readWebSetting<AgentIntroSetting>(db, AGENT_INTRO_KEY);
    return Array.isArray(value?.pending) ? value!.pending.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/*
 * Both writes change one id in one statement, never read-modify-write the
 * whole list: a creation and a dismissal landing together (or two of either)
 * must not resurrect a closed strip or drop another agent's pending one. The
 * upsert's row lock serialises them, and each sees the other's result.
 */
const PENDING_ARRAY = `case when jsonb_typeof(core.web_settings.value -> 'pending') = 'array'
  then core.web_settings.value -> 'pending' else '[]'::jsonb end`;

/** Owe this agent its first-open strip. Best effort: a failed write costs a line, never the agent. */
export async function markAgentIntro(db: Queryable | null | undefined, agentId: string): Promise<void> {
  if (!db || typeof (db as { query?: unknown }).query !== 'function') return;
  try {
    await db.query(
      `insert into core.web_settings (key, value, updated_at)
       values ($1, jsonb_build_object('pending', jsonb_build_array($2::text)), now())
       on conflict (key) do update set
         value = jsonb_set(
           case when jsonb_typeof(core.web_settings.value) = 'object' then core.web_settings.value else '{}'::jsonb end,
           '{pending}',
           (select coalesce(jsonb_agg(distinct id order by id), '[]'::jsonb)
              from (select jsonb_array_elements_text(${PENDING_ARRAY}) as id union select $2::text) ids)),
         updated_at = now()`,
      [AGENT_INTRO_KEY, agentId],
    );
  } catch {
    /* the agent exists either way; it just opens without the strip */
  }
}

/** The owner closed the strip (or followed "Adjust"): it does not come back. */
export async function dismissAgentIntro(db: Queryable, agentId: string): Promise<void> {
  await db.query(
    `update core.web_settings
        set value = jsonb_set(value, '{pending}', (value -> 'pending') - $2::text), updated_at = now()
      where key = $1 and jsonb_typeof(value -> 'pending') = 'array' and (value -> 'pending') ? $2::text`,
    [AGENT_INTRO_KEY, agentId],
  );
}

function introAgent(catalog: AgentCatalog, id: string): IntroAgent | null {
  const agent = catalog.get(id);
  if (!agent) return null;
  return {
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    ...(agent.roles.includes('front-desk') ? { frontDesk: true as const } : {}),
  };
}

function dirOf(file: string): string {
  return path.dirname(path.dirname(file));
}

/** The allowlist delegation applies for one agent; an unreadable one is nobody. */
function allowlistOf(catalog: AgentCatalog, id: string, file: string): string[] {
  try {
    return resolveAllowlist(id, catalog, readDelegatesFile(id, dirOf(file)));
  } catch {
    return [];
  }
}

/**
 * Whether the strip is due for this agent and, when it is, both directions as
 * delegation applies them right now: whom it may ask ("everyone" when its list
 * is open) and every colleague whose list reaches it.
 */
export async function readAgentIntro(db: Queryable, catalog: AgentCatalog, agentId: string): Promise<AgentIntroView | null> {
  const agent = catalog.get(agentId);
  if (!agent) return null;
  if (!(await readPending(db)).includes(agent.id)) return { show: false };
  let stored: string[] | undefined;
  try {
    stored = readDelegatesFile(agent.id, dirOf(agent.file));
  } catch {
    stored = [];
  }
  const asks =
    delegateScope(agent, stored).kind === 'everyone'
      ? ('everyone' as const)
      : allowlistOf(catalog, agent.id, agent.file).flatMap((id) => introAgent(catalog, id) ?? []);
  const askedBy = catalog
    .list()
    .filter((other) => other.id !== agent.id)
    .flatMap((other) => {
      const full = catalog.get(other.id);
      if (!full || !full.tools.includes('agent.delegate')) return [];
      return allowlistOf(catalog, full.id, full.file).includes(agent.id) ? (introAgent(catalog, full.id) ?? []) : [];
    })
    // The front desk first: the line reads "the front desk, @art, …".
    .sort((a, b) => Number(Boolean(b.frontDesk)) - Number(Boolean(a.frontDesk)));
  return { show: true, id: agent.id, handle: agent.handle, asks, askedBy };
}
