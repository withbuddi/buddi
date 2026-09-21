/**
 * Groups: the rows, and nothing about running them. (docs/groups.md)
 *
 * A group is a name, a coordinator and members. Its conversations are
 * ordinary conversations tagged with the group; its messages carry a
 * speaker. An owner request is a row with the budget on it, so the counter
 * survives an approval pause and a restart, and a call is reserved on that
 * row before it is dispatched.
 */
/** A stored content block, as the runtime defines it; opaque here. */
type ContentBlock = Record<string, unknown> & { type: string };

/** Anything that runs SQL — a pool, a client, a test double. */
type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export interface GroupRow {
  id: string;
  name: string;
  coordinator: string;
  members: string[];
  contextCapChars: number;
  lastSummary: string | null;
  createdAt: Date;
}

export interface GroupRequestRow {
  id: string;
  groupId: string;
  conversationId: string;
  text: string;
  state: 'running' | 'suspended' | 'done' | 'failed' | 'stopped';
  budgetTotal: number;
  budgetReserved: number;
  maintenanceReserved: number;
  awaitingActionId: string | null;
  awaitingAgentId: string | null;
  note: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** One stored turn of a group conversation, speaker included. */
export interface GroupTurn {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  speaker: string | null;
}

export const DEFAULT_GROUP_BUDGET = 12;
export const DEFAULT_CONTEXT_CAP_CHARS = 40_000;

export async function createGroup(
  pool: Queryable,
  input: { name: string; coordinator: string; members: string[]; contextCapChars?: number },
): Promise<GroupRow> {
  const members = [...new Set([input.coordinator, ...input.members])];
  const { rows } = await pool.query(
    `insert into core.groups (name, coordinator_agent_id, context_cap_chars)
     values ($1, $2, $3) returning id`,
    [input.name, input.coordinator, input.contextCapChars ?? DEFAULT_CONTEXT_CAP_CHARS],
  );
  const id = String(rows[0].id);
  for (const [position, agentId] of members.entries()) {
    await pool.query(
      `insert into core.group_members (group_id, agent_id, position) values ($1::uuid, $2, $3)`,
      [id, agentId, position],
    );
  }
  return (await getGroup(pool, id)) as GroupRow;
}

/**
 * The role a group never contains.
 *
 * The maker is the door to the installation's settings, not a colleague: a
 * "team" of the agent that makes agents and the one agent you have is not a
 * team. The dashboard's roster says the same thing in its own words; this is
 * the copy the server and the tools refuse on, so a group made through a tool
 * cannot hold what a group made through the sheet could not.
 */
export const MAKER_ROLE = 'maker';

/** An installed agent, as a membership check needs to see it. */
export interface GroupCandidate {
  id: string;
  name?: string;
  roles?: readonly string[];
  /** False when this machine cannot run it. Absent means: as far as we know, yes. */
  available?: boolean;
}

/** Who may be put in a room: loaded, runnable, and not the maker. */
export function groupable(agent: GroupCandidate): boolean {
  return agent.available !== false && !(agent.roles ?? []).includes(MAKER_ROLE);
}

/** What a caller asks to change. Anything left out stays exactly as it is. */
export interface GroupChange {
  name?: string;
  coordinator?: string;
  members?: string[];
}

/** The membership a change would leave behind. */
export interface GroupShape {
  name: string;
  coordinator: string;
  members: string[];
}

export type GroupRefusalCode =
  | 'empty-name'
  | 'coordinator-not-a-member'
  | 'not-groupable'
  | 'too-small';

/**
 * A change that cannot be made, said in one sentence.
 *
 * A typed refusal rather than a bare Error so the route can answer 400 with
 * the same words the tool refuses with: one rule, two surfaces.
 */
export class GroupRefusal extends Error {
  constructor(readonly code: GroupRefusalCode, message: string) {
    super(message);
    this.name = 'GroupRefusal';
  }
}

export const MAX_GROUP_NAME = 80;

/**
 * What the group would become, or a refusal. Pure: no database, no catalog.
 *
 * The rules are the ones creation already applies, written once. The
 * coordinator has to be one of the members — an edit that drops it would
 * leave a room whose spokesman is not in it — every member has to be an agent
 * this installation can actually put in a room, and a room needs somebody
 * besides the coordinator to be a room at all.
 */
export function planGroupChange(
  before: Pick<GroupRow, 'name' | 'coordinator' | 'members'>,
  change: GroupChange,
  roster?: readonly GroupCandidate[],
): GroupShape {
  const name = change.name === undefined ? before.name : change.name.trim();
  if (name === '' || name.length > MAX_GROUP_NAME) {
    throw new GroupRefusal('empty-name', `A group needs a name, up to ${MAX_GROUP_NAME} characters.`);
  }
  const coordinator = (change.coordinator ?? before.coordinator).trim();
  const asked = (change.members ?? before.members).map((m) => m.trim()).filter((m) => m !== '');
  const members = [...new Set(asked)];
  if (!members.includes(coordinator)) {
    throw new GroupRefusal('coordinator-not-a-member', 'The coordinator has to be one of the members.');
  }
  if (roster) {
    const known = new Map(roster.map((a) => [a.id, a]));
    const refused = members.filter((id) => {
      const agent = known.get(id);
      return agent === undefined || !groupable(agent);
    });
    if (refused.length > 0) {
      throw new GroupRefusal(
        'not-groupable',
        `Not an agent this installation can put in a room: ${refused.join(', ')}.`,
      );
    }
  }
  if (members.length < 2) {
    throw new GroupRefusal('too-small', 'A group needs at least one member besides the coordinator.');
  }
  return { name, coordinator, members };
}

/**
 * Change a group the owner already has: its name, its coordinator, who is in
 * it. The id never moves, and neither does the transcript — a member taken
 * out of the room keeps every turn it ever spoke there, because the room is
 * what was said, not who is in it today.
 */
export async function updateGroup(
  pool: Queryable,
  id: string,
  change: GroupChange,
  roster?: readonly GroupCandidate[],
): Promise<GroupRow | null> {
  const before = await getGroup(pool, id);
  if (!before) return null;
  const next = planGroupChange(before, change, roster);
  await pool.query(
    `update core.groups set name = $2, coordinator_agent_id = $3 where id = $1::uuid`,
    [id, next.name, next.coordinator],
  );
  await pool.query(
    `delete from core.group_members where group_id = $1::uuid and agent_id <> all($2::text[])`,
    [id, next.members],
  );
  for (const [position, agentId] of next.members.entries()) {
    await pool.query(
      `insert into core.group_members (group_id, agent_id, position) values ($1::uuid, $2, $3)
         on conflict (group_id, agent_id) do update set position = excluded.position`,
      [id, agentId, position],
    );
  }
  return await getGroup(pool, id);
}

/** A real UUID, not any 36 characters of hex and hyphens. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getGroup(pool: Queryable, id: string): Promise<GroupRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(
    `select g.id, g.name, g.coordinator_agent_id, g.context_cap_chars, g.last_summary, g.created_at,
            coalesce(array_agg(m.agent_id order by m.position) filter (where m.agent_id is not null), '{}') as members
       from core.groups g
       left join core.group_members m on m.group_id = g.id
      where g.id = $1::uuid and g.archived_at is null
      group by g.id`,
    [id],
  );
  return rows[0] ? toGroup(rows[0]) : null;
}

export async function listGroups(pool: Queryable): Promise<GroupRow[]> {
  const { rows } = await pool.query(
    `select g.id, g.name, g.coordinator_agent_id, g.context_cap_chars, g.last_summary, g.created_at,
            coalesce(array_agg(m.agent_id order by m.position) filter (where m.agent_id is not null), '{}') as members
       from core.groups g
       left join core.group_members m on m.group_id = g.id
      where g.archived_at is null
      group by g.id
      order by g.created_at asc`,
  );
  return rows.map(toGroup);
}

export async function archiveGroup(pool: Queryable, id: string, at: Date = new Date()): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.groups set archived_at = $2 where id = $1::uuid and archived_at is null returning id`,
    [id, at],
  );
  return rows.length > 0;
}

/** A new conversation for the group. The row's agent is the coordinator. */
export async function createGroupConversation(pool: Queryable, group: GroupRow): Promise<string> {
  const { rows } = await pool.query(
    `insert into core.conversations (agent_id, group_id) values ($1, $2::uuid) returning id`,
    [group.coordinator, group.id],
  );
  return String(rows[0].id);
}

/** Which group a conversation belongs to, or null for a single-agent one. */
export async function conversationGroup(pool: Queryable, conversationId: string): Promise<string | null> {
  if (!UUID.test(conversationId)) return null;
  const { rows } = await pool.query(
    `select group_id from core.conversations where id = $1::uuid`,
    [conversationId],
  );
  return rows[0]?.group_id ? String(rows[0].group_id) : null;
}

export async function latestGroupConversation(pool: Queryable, groupId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `select id from core.conversations where group_id = $1::uuid order by created_at desc limit 1`,
    [groupId],
  );
  return rows[0] ? String(rows[0].id) : null;
}

export async function listGroupConversations(
  pool: Queryable,
  groupId: string,
  limit = 30,
): Promise<Array<{ id: string; createdAt: Date; lastAt: Date | null; messages: number; first: string | null }>> {
  const { rows } = await pool.query(
    `select c.id, c.created_at,
            max(m.created_at) as last_at,
            count(m.id)::int as messages,
            (select left(r.text, 160) from core.group_requests r where r.conversation_id = c.id order by r.created_at asc limit 1) as first
       from core.conversations c
       left join core.messages m on m.conversation_id = c.id
      where c.group_id = $1::uuid
      group by c.id
      order by coalesce(max(m.created_at), c.created_at) desc
      limit $2`,
    [groupId, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: new Date(r.created_at),
    lastAt: r.last_at ? new Date(r.last_at) : null,
    messages: Number(r.messages ?? 0),
    first: r.first ?? null,
  }));
}

/** The stored turns of one conversation, speakers included, oldest first. */
export async function readGroupTurns(pool: Queryable, conversationId: string): Promise<GroupTurn[]> {
  const { rows } = await pool.query(
    `select role, content, speaker from core.messages
      where conversation_id = $1::uuid
      order by created_at asc, id asc`,
    [conversationId],
  );
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: Array.isArray(r.content) ? (r.content as ContentBlock[]) : [],
    speaker: r.speaker ?? null,
  }));
}

/** How big the room is, in the characters every speaker is re-sent. */
export async function roomChars(pool: Queryable, conversationId: string): Promise<number> {
  const { rows } = await pool.query(
    `select coalesce(sum(length(content::text)), 0)::bigint as chars from core.messages where conversation_id = $1::uuid`,
    [conversationId],
  );
  return Number(rows[0]?.chars ?? 0);
}

/** Write a note the room itself says — "Ledger has finished" — as a user turn. */
export async function appendRoomNote(pool: Queryable, conversationId: string, text: string): Promise<void> {
  await pool.query(
    `insert into core.messages (conversation_id, role, content, speaker) values ($1::uuid, 'user', $2::jsonb, 'room')`,
    [conversationId, JSON.stringify([{ type: 'text', text }])],
  );
}

export async function setGroupSummary(pool: Queryable, groupId: string, summary: string | null): Promise<void> {
  await pool.query(`update core.groups set last_summary = $2 where id = $1::uuid`, [groupId, summary]);
}

/* ------------------------------------------------------------------ *
 * Requests and the budget
 * ------------------------------------------------------------------ */

export async function createGroupRequest(
  pool: Queryable,
  input: { groupId: string; conversationId: string; text: string; budgetTotal?: number },
): Promise<GroupRequestRow> {
  const { rows } = await pool.query(
    `insert into core.group_requests (group_id, conversation_id, text, state, budget_total)
     values ($1::uuid, $2::uuid, $3, 'running', $4)
     returning *`,
    [input.groupId, input.conversationId, input.text, input.budgetTotal ?? DEFAULT_GROUP_BUDGET],
  );
  return toRequest(rows[0]);
}

export async function getGroupRequest(pool: Queryable, id: string): Promise<GroupRequestRow | null> {
  const { rows } = await pool.query(`select * from core.group_requests where id = $1::uuid`, [id]);
  return rows[0] ? toRequest(rows[0]) : null;
}

/** The request a conversation is in the middle of, if any. */
export async function openGroupRequest(pool: Queryable, conversationId: string): Promise<GroupRequestRow | null> {
  const { rows } = await pool.query(
    `select * from core.group_requests
      where conversation_id = $1::uuid and state in ('running', 'suspended')
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0] ? toRequest(rows[0]) : null;
}

/** The request this group is in the middle of, in any of its conversations. */
export async function openGroupRequestForGroup(pool: Queryable, groupId: string): Promise<GroupRequestRow | null> {
  const { rows } = await pool.query(
    `select * from core.group_requests
      where group_id = $1::uuid and state in ('running', 'suspended')
      order by created_at desc limit 1`,
    [groupId],
  );
  return rows[0] ? toRequest(rows[0]) : null;
}

export async function countGroupRequests(pool: Queryable, conversationId: string): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from core.group_requests where conversation_id = $1::uuid`,
    [conversationId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Reserve one call, atomically, before it is dispatched. Answers `work` for
 * an ordinary call, `synthesis` for the last one, `spent` when none is left.
 */
export async function reserveGroupCall(pool: Queryable, requestId: string): Promise<'work' | 'synthesis' | 'spent'> {
  const { rows } = await pool.query(
    `update core.group_requests
        set budget_reserved = budget_reserved + 1
      where id = $1::uuid and budget_reserved < budget_total and state = 'running'
      returning budget_reserved, budget_total`,
    [requestId],
  );
  const row = rows[0];
  if (!row) return 'spent';
  return Number(row.budget_reserved) >= Number(row.budget_total) ? 'synthesis' : 'work';
}

/** Give one back: the provider refused it before doing any work. */
export async function releaseGroupCall(pool: Queryable, requestId: string): Promise<void> {
  await pool.query(
    `update core.group_requests set budget_reserved = greatest(0, budget_reserved - 1) where id = $1::uuid`,
    [requestId],
  );
}

/** The one maintenance call a rollover summary may make. */
export async function reserveMaintenanceCall(pool: Queryable, requestId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.group_requests set maintenance_reserved = maintenance_reserved + 1
      where id = $1::uuid and maintenance_reserved < 1 returning id`,
    [requestId],
  );
  return rows.length > 0;
}

/**
 * Move a request between states, only from the states named in `from`.
 * Returns whether the row moved: a stop that landed first stays a stop, and
 * a continuation that lost that race learns it here and goes no further.
 */
export async function setGroupRequestState(
  pool: Queryable,
  id: string,
  change: {
    state: GroupRequestRow['state'];
    from: readonly GroupRequestRow['state'][];
    awaitingActionId?: string | null;
    awaitingAgentId?: string | null;
    note?: string | null;
    finishedAt?: Date | null;
  },
): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.group_requests
        set state = $2,
            awaiting_action_id = case when $3::boolean then $4 else awaiting_action_id end,
            awaiting_agent_id  = case when $5::boolean then $6 else awaiting_agent_id end,
            note               = case when $7::boolean then $8 else note end,
            finished_at        = case when $9::boolean then $10 else finished_at end
      where id = $1::uuid and state = any($11::text[])
      returning id`,
    [
      id, change.state,
      change.awaitingActionId !== undefined, change.awaitingActionId ?? null,
      change.awaitingAgentId !== undefined, change.awaitingAgentId ?? null,
      change.note !== undefined, change.note ?? null,
      change.finishedAt !== undefined, change.finishedAt ?? null,
      change.from,
    ],
  );
  return rows.length > 0;
}

/** The request waiting on exactly this action, by this agent, or null. */
export async function suspendedGroupRequest(
  pool: Queryable,
  conversationId: string,
  actionId: string,
  agentId: string,
): Promise<GroupRequestRow | null> {
  const { rows } = await pool.query(
    `select * from core.group_requests
      where conversation_id = $1::uuid and state = 'suspended'
        and awaiting_action_id = $2 and awaiting_agent_id = $3
      limit 1`,
    [conversationId, actionId, agentId],
  );
  return rows[0] ? toRequest(rows[0]) : null;
}

function toGroup(row: any): GroupRow {
  return {
    id: String(row.id),
    name: String(row.name),
    coordinator: String(row.coordinator_agent_id),
    members: Array.isArray(row.members) ? row.members.map(String) : [],
    contextCapChars: Number(row.context_cap_chars ?? DEFAULT_CONTEXT_CAP_CHARS),
    lastSummary: row.last_summary ?? null,
    createdAt: new Date(row.created_at),
  };
}

function toRequest(row: any): GroupRequestRow {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    conversationId: String(row.conversation_id),
    text: String(row.text),
    state: row.state,
    budgetTotal: Number(row.budget_total),
    budgetReserved: Number(row.budget_reserved),
    maintenanceReserved: Number(row.maintenance_reserved ?? 0),
    awaitingActionId: row.awaiting_action_id ?? null,
    awaitingAgentId: row.awaiting_agent_id ?? null,
    note: row.note ?? null,
    createdAt: new Date(row.created_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
  };
}
