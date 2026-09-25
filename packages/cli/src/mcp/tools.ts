/**
 * The tools `buddi mcp` publishes (docs/specs/mcp.md §4).
 *
 * Each is a thin client over the dashboard's own routes: reads return what the
 * dashboard would show, writes go through `POST /api/mcp/request` and wait for
 * the owner's decision on the approval they raise, and `buddi.ask` is a chat
 * turn sent exactly as the dashboard's composer sends one.
 */
import { GatewayError, type Gateway } from './gateway-client.js';

/** How long a write or an ask waits for the owner before handing back an id. */
export const DECISION_WAIT_MS = 10 * 60 * 1000;
/** How often the gateway is asked again while waiting. */
export const POLL_MS = 1500;

export interface ToolRuntime {
  gateway: Gateway;
  /** The client's name from the MCP handshake, recorded on every write. */
  client: () => string;
  /** Tell the client what is happening while a call waits. */
  progress: (message: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs: number;
  pollMs: number;
  signal?: AbortSignal | undefined;
}

type JsonSchema = Record<string, unknown>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True for a tool whose result is decided by the owner. */
  write?: boolean;
  run(args: Record<string, unknown>, rt: ToolRuntime): Promise<unknown>;
}

/** A refusal the client should read as an error, in buddi's own words. */
export class ToolRefusal extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

/* ------------------------------------------------------------------ *
 * Argument helpers
 * ------------------------------------------------------------------ */

const str = (description: string): JsonSchema => ({ type: 'string', description });
const strings = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

function need(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ToolRefusal(`\`${key}\` is required.`);
  return value.trim();
}

function opt(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolRefusal(`\`${key}\` must be a string.`);
  return value.trim() === '' ? undefined : value.trim();
}

const enc = encodeURIComponent;

/** `@dev` and `dev` are the same agent. */
const agentRef = (value: string): string => value.replace(/^@/, '');

/* ------------------------------------------------------------------ *
 * Waiting on the owner
 * ------------------------------------------------------------------ */

interface ApprovalView {
  id: string;
  tool: string;
  preview: string;
  state: string;
  decidedVia: string | null;
  outcome: unknown;
}

const SETTLED = new Set(['succeeded', 'failed', 'rejected', 'expired', 'refused', 'unknown']);

/**
 * Wait for the owner's decision on one action: its result when it ran, the
 * refusal when it did not, `{ pending }` when ten minutes passed first. The
 * card stays open either way; nothing here decides anything.
 */
export async function awaitDecision(rt: ToolRuntime, actionId: string, preview: string): Promise<unknown> {
  const deadline = rt.now() + rt.waitMs;
  await rt.progress(`Waiting for your approval on the dashboard or Telegram (action ${actionId}).`);
  for (;;) {
    const { action } = await rt.gateway.get<{ action: ApprovalView }>(`/api/approvals/${enc(actionId)}`);
    if (SETTLED.has(action.state)) return settled(action);
    if (rt.now() >= deadline) {
      return {
        pending: actionId,
        state: action.state,
        preview,
        note: 'Nobody has decided yet. The card stays open on the dashboard and Telegram; ask again with buddi.activity or look at the approvals.',
      };
    }
    if (rt.signal?.aborted) throw new ToolRefusal('Cancelled while waiting. The approval card stays open.');
    await rt.sleep(rt.pollMs);
    await rt.progress(action.state === 'pending' ? `Still waiting for your approval (action ${actionId}).` : `Approved; ${action.state}.`);
  }
}

function settled(action: ApprovalView): unknown {
  const outcome = (action.outcome ?? {}) as { result?: unknown; message?: unknown };
  if (action.state === 'succeeded') {
    return { state: 'succeeded', actionId: action.id, decidedVia: action.decidedVia, result: outcome.result ?? null };
  }
  if (action.state === 'rejected') {
    return { state: 'rejected', actionId: action.id, decidedVia: action.decidedVia, note: 'The owner said no. Nothing was changed.' };
  }
  throw new ToolRefusal(
    `The approval ended ${action.state}: ${typeof outcome.message === 'string' ? outcome.message : 'nothing was changed'}.`,
    { actionId: action.id, state: action.state },
  );
}

/** Raise the card for one write and wait on it. */
async function request(rt: ToolRuntime, kind: string, input: Record<string, unknown>): Promise<unknown> {
  let answered: { status: number; body: { actionId?: string; preview?: string } };
  try {
    answered = await rt.gateway.post('/api/mcp/request', { kind, input, client: rt.client() });
  } catch (err) {
    // The route's own refusal — a hand-only tool, a taken handle — verbatim.
    if (err instanceof GatewayError && err.status < 500) throw new ToolRefusal(err.message);
    throw err;
  }
  const { actionId, preview } = answered.body;
  if (!actionId) throw new ToolRefusal('buddi did not raise an approval for that change.');
  return awaitDecision(rt, actionId, preview ?? '');
}

/* ------------------------------------------------------------------ *
 * Shapes the reads return
 * ------------------------------------------------------------------ */

interface AgentsRoute {
  agents: Array<Record<string, unknown> & { id: string }>;
  engines?: unknown;
  default?: { defaultAgentId?: string | null };
  providerAccounts?: {
    accounts?: Array<{ id: string; label: string; kind: string; enabled?: boolean; configured?: boolean; defaultModel?: string; assignedAgents?: string[] }>;
    bindings?: Array<{ agentId: string; accountId: string; model: string }>;
  };
}

function accountsOf(route: AgentsRoute) {
  const accounts = route.providerAccounts?.accounts ?? [];
  const bindings = route.providerAccounts?.bindings ?? [];
  const bindingOf = (agentId: string) => {
    const b = bindings.find((x) => x.agentId === agentId);
    if (!b) return null;
    const account = accounts.find((a) => a.id === b.accountId);
    return { account: account?.label ?? b.accountId, accountId: b.accountId, kind: account?.kind ?? null, model: b.model };
  };
  return { accounts, bindingOf };
}

interface PickerRoute {
  id: string;
  groups: Array<{ plugin: string; glob?: string; tools: Array<{ name: string; description: string; tier: string; gated: boolean; grantable: boolean; core: boolean }> }>;
  granted: string[];
  suggested?: { plugin: string; label: string; tools: Array<{ name: string; description: string }> };
}

/* ------------------------------------------------------------------ *
 * Shaping reads for a model
 * ------------------------------------------------------------------ */

/** What stands in for a sensitive Home block when it is left out. */
export const SENSITIVE_OMITTED = 'ask with includeSensitive';

/**
 * The overview with every Home block a plugin marks `sensitive` replaced by
 * its name. The dashboard masks those until the owner asks; this is the same
 * rule for a client that has no mask, only a transcript.
 */
export function withoutSensitive(overview: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(overview.home)) return overview;
  return {
    ...overview,
    home: overview.home.map((block: unknown) => {
      const b = block as { id?: unknown; title?: unknown; sensitive?: unknown } | null;
      return b && b.sensitive === true ? { id: b.id, title: b.title, sensitive: true, omitted: SENSITIVE_OMITTED } : block;
    }),
  };
}

interface PagesRoute {
  pages: Array<{ plugin: string; id: string; title: string; place: string } & Record<string, unknown>>;
  queries?: Array<{ plugin: string; name: string; params: Record<string, string>; sensitive?: boolean }>;
}

/** Every `{ query: name }` in a descriptor, in the order the page reads them. */
function queriesIn(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) queriesIn(item, out);
  } else if (node && typeof node === 'object') {
    const q = (node as { query?: unknown }).query;
    if (typeof q === 'string') out.add(q);
    for (const value of Object.values(node)) queriesIn(value, out);
  }
  return out;
}

/**
 * Pages as a model needs them: where each is and what it reads, with the
 * parameters buddi.page_query takes. The layout is the dashboard's business.
 */
export function summarizePages(route: PagesRoute): unknown {
  const params = new Map((route.queries ?? []).map((q) => [`${q.plugin}/${q.name}`, q.params]));
  const sensitive = new Set((route.queries ?? []).filter((q) => q.sensitive === true).map((q) => `${q.plugin}/${q.name}`));
  return {
    pages: route.pages.map((p) => ({
      plugin: p.plugin,
      id: p.id,
      title: p.title,
      place: p.place,
      queries: [...queriesIn([p.data, p.body], new Set())].map((name) => ({
        name,
        params: params.get(`${p.plugin}/${name}`) ?? {},
        ...(sensitive.has(`${p.plugin}/${name}`) ? { sensitive: true } : {}),
      })),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

export const TOOLS: McpTool[] = [
  /* ---------------- reads ---------------- */
  {
    name: 'buddi.overview',
    description:
      'The state of this buddi at a glance: version, whether the service is running, every agent with its account, model and status, open approvals, open proposals, and what is waiting on the owner.',
    inputSchema: object({
      includeSensitive: {
        type: 'boolean',
        description: 'Include the Home blocks a plugin marks sensitive (balances and the like). Off by default: each is then only named.',
      },
    }),
    async run(args, rt) {
      const g = rt.gateway;
      const includeSensitive = args.includeSensitive === true;
      const [session, service, overview, agents, approvals, proposals, attention] = await Promise.all([
        g.get<{ version?: unknown; recovery?: unknown }>('/api/session'),
        g.get<unknown>('/api/service').catch(() => null),
        g.get<Record<string, unknown>>('/api/overview'),
        g.get<AgentsRoute>('/api/agents'),
        g.get<{ pending: ApprovalView[] }>('/api/approvals?limit=1'),
        g.get<{ open: Array<Record<string, unknown>> }>('/api/proposals'),
        g.get<unknown>('/api/chat/attention').catch(() => null),
      ]);
      const { bindingOf } = accountsOf(agents);
      return {
        version: session.version ?? null,
        recovery: session.recovery ?? false,
        service,
        paused: overview.paused ?? false,
        agents: agents.agents.map((a) => ({
          id: a.id,
          handle: a.handle,
          name: a.name,
          isDefault: a.id === agents.default?.defaultAgentId,
          available: a.available ?? null,
          ...(a.unavailableReason ? { unavailableReason: a.unavailableReason } : {}),
          engine: bindingOf(a.id) ?? { model: a.model ?? null, provider: a.provider ?? a.providerKind ?? null },
        })),
        approvals: approvals.pending.map((a) => ({ id: a.id, tool: a.tool, preview: a.preview })),
        proposals: proposals.open.map((p) => ({ id: p.id, kind: p.kind, agent: p.agent, title: p.title })),
        needsYou: attention,
        overview: includeSensitive ? overview : withoutSensitive(overview),
      };
    },
  },
  {
    name: 'buddi.agents_list',
    description: 'Every agent: id, handle, name, description, roles, whether it is the default, and the account and model it runs on.',
    inputSchema: object({}),
    async run(_args, rt) {
      const route = await rt.gateway.get<AgentsRoute>('/api/agents');
      const { bindingOf } = accountsOf(route);
      return {
        default: route.default?.defaultAgentId ?? null,
        agents: route.agents.map((a) => ({ ...a, account: bindingOf(a.id) })),
      };
    },
  },
  {
    name: 'buddi.agent_read',
    description:
      "One agent, whole: its file (front matter and persona), its tool grant resolved with every tool's tier, its skills (learned ones with version and provenance), its account binding and its delegates.",
    inputSchema: object({ agent: str('The agent, by id or @handle.') }, ['agent']),
    async run(args, rt) {
      const agent = agentRef(need(args, 'agent'));
      const [profile, skills, file, agents] = await Promise.all([
        rt.gateway.get<Record<string, unknown> & { id: string }>(`/api/agents/${enc(agent)}/profile`),
        rt.gateway.get<unknown>(`/api/agents/${enc(agent)}/skills`).catch(() => null),
        rt.gateway.get<unknown>(`/api/agents/${enc(agent)}/file`),
        rt.gateway.get<AgentsRoute>('/api/agents'),
      ]);
      return { profile, file, skills, account: accountsOf(agents).bindingOf(profile.id) };
    },
  },
  {
    name: 'buddi.tools_list',
    description:
      'Every installed tool with its plugin, tier and description. With `agent`: which of them it is granted, which are core, which cannot be granted from here, and which its plugin suggests — the tool picker\'s data.',
    inputSchema: object({ agent: str('Optional: the agent, by id or @handle.') }),
    async run(args, rt) {
      const wanted = opt(args, 'agent');
      let agent = wanted ? agentRef(wanted) : undefined;
      if (!agent) {
        // The picker lists every installed tool whichever agent it is read for.
        const route = await rt.gateway.get<AgentsRoute>('/api/agents');
        agent = route.default?.defaultAgentId ?? route.agents[0]?.id;
        if (!agent) return { tools: [] };
        const picker = await rt.gateway.get<PickerRoute>(`/api/agents/${enc(agent)}/tools`);
        return {
          tools: picker.groups.flatMap((g) =>
            g.tools.map((t) => ({ name: t.name, plugin: g.plugin, tier: t.tier, description: t.description, grantable: t.grantable })),
          ),
        };
      }
      const picker = await rt.gateway.get<PickerRoute>(`/api/agents/${enc(agent)}/tools`);
      const granted = new Set(picker.granted);
      return {
        agent: picker.id,
        granted: picker.granted,
        suggested: picker.suggested ?? null,
        tools: picker.groups.flatMap((g) =>
          g.tools.map((t) => ({
            name: t.name,
            plugin: g.plugin,
            tier: t.tier,
            description: t.description,
            granted: granted.has(t.name),
            core: t.core,
            grantable: t.grantable,
          })),
        ),
      };
    },
  },
  {
    name: 'buddi.accounts_list',
    description: 'The named model accounts by label, kind, auth, default model, state and the agents on each. Never a key or a token.',
    inputSchema: object({}),
    async run(_args, rt) {
      const view = await rt.gateway.get<{
        accounts: Array<Record<string, unknown> & { id: string; label: string }>;
        bindings: Array<{ agentId: string; accountId: string; model: string }>;
      }>('/api/provider-accounts');
      return {
        accounts: view.accounts.map((a) => ({
          id: a.id,
          label: a.label,
          kind: a.kind,
          auth: a.auth,
          defaultModel: a.defaultModel,
          enabled: a.enabled,
          configured: a.configured,
          assignedAgents: a.assignedAgents,
          models: [...new Set([a.defaultModel, ...view.bindings.filter((b) => b.accountId === a.id).map((b) => b.model)].filter(Boolean))],
          test: a.test ?? null,
        })),
        bindings: view.bindings,
      };
    },
  },
  {
    name: 'buddi.pages_list',
    description: "Every plugin page the dashboard shows, with the queries each page reads — the names buddi.page_query takes.",
    inputSchema: object({}),
    async run(_args, rt) {
      return summarizePages(await rt.gateway.get<PagesRoute>('/api/pages'));
    },
  },
  {
    name: 'buddi.page_query',
    description:
      'Run one plugin page query, exactly as the dashboard page does, with its parameters. A query the plugin marks sensitive (balances and the like) is only named unless includeSensitive is set.',
    inputSchema: object(
      {
        plugin: str('The plugin, e.g. finance.'),
        query: str('The query name, from buddi.pages_list.'),
        params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'The query parameters.' },
        includeSensitive: {
          type: 'boolean',
          description: 'Return the data of a query the plugin marks sensitive. Off by default: it is then only named.',
        },
      },
      ['plugin', 'query'],
    ),
    async run(args, rt) {
      const plugin = need(args, 'plugin');
      const query = need(args, 'query');
      const params = new URLSearchParams();
      const given = args.params;
      if (given !== undefined && (typeof given !== 'object' || given === null || Array.isArray(given))) {
        throw new ToolRefusal('`params` must be an object.');
      }
      for (const [k, v] of Object.entries((given as Record<string, unknown> | undefined) ?? {})) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      /*
       * The same rule buddi.overview follows for Home: a sensitive read is
       * named, not run, unless the caller asked. Checked before the query is
       * asked, so the data never reaches this process either.
       */
      if (args.includeSensitive !== true) {
        const route = await rt.gateway.get<PagesRoute>('/api/pages');
        if ((route.queries ?? []).some((q) => q.plugin === plugin && q.name === query && q.sensitive === true)) {
          return { plugin, query, sensitive: true, omitted: SENSITIVE_OMITTED };
        }
      }
      const qs = params.toString();
      return rt.gateway.get(`/api/pages/${enc(plugin)}/${enc(query)}${qs ? `?${qs}` : ''}`);
    },
  },
  {
    name: 'buddi.proposals_list',
    description: 'What agents have proposed to learn (skills, rules, preferences): open ones, and recently kept, discarded or expired ones.',
    inputSchema: object({ state: { type: 'string', enum: ['open', 'kept', 'discarded', 'expired'], description: 'Only proposals in this state.' } }),
    async run(args, rt) {
      const state = opt(args, 'state');
      const route = await rt.gateway.get<{ open: Array<{ state?: string }>; closed: Array<{ state?: string }> }>('/api/proposals');
      if (!state) return route;
      return { proposals: [...route.open, ...route.closed].filter((p) => (p.state ?? 'open') === state) };
    },
  },
  {
    name: 'buddi.activity',
    description: 'The event log, newest first: runs, approvals, effects, messages. `since` is an event id (from a previous call) or an ISO time; `kind` narrows to one event kind.',
    inputSchema: object({ since: str('An event id or an ISO time.'), kind: str('One event kind, e.g. action.created.') }),
    async run(args, rt) {
      const since = opt(args, 'since');
      const kind = opt(args, 'kind');
      const params = new URLSearchParams({ limit: '100' });
      if (kind) params.set('kind', kind);
      if (since && /^\d+$/.test(since)) params.set('since', since);
      const page = await rt.gateway.get<{ events: Array<{ createdAt?: string; at?: string }>; latest?: unknown }>(`/api/events?${params}`);
      if (since && !/^\d+$/.test(since)) {
        const from = Date.parse(since);
        if (Number.isNaN(from)) throw new ToolRefusal('`since` is an event id or an ISO time.');
        return { ...page, events: page.events.filter((e) => Date.parse(e.createdAt ?? e.at ?? '') >= from) };
      }
      return page;
    },
  },
  {
    name: 'buddi.memory_list',
    description: 'What buddi remembers: preferences and notes, all of them or those one agent sees.',
    inputSchema: object({ agent: str('Optional: only what this agent sees.') }),
    async run(args, rt) {
      const agent = opt(args, 'agent');
      return rt.gateway.get(`/api/memory${agent ? `?agent=${enc(agentRef(agent))}` : ''}`);
    },
  },

  /* ---------------- writes: each an approval ---------------- */
  {
    name: 'buddi.agent_update',
    description:
      "Change an agent's name, handle, description, tool grant or roles — the Setup tab's save. It becomes an approval card on the dashboard and Telegram; the call waits for the owner (up to 10 minutes, then returns { pending }). `tools` replaces the whole grant. Tools that create, change or remove agents are refused here as in the tool picker.",
    write: true,
    inputSchema: object(
      {
        agent: str('The agent, by id or @handle.'),
        name: str('A new display name.'),
        handle: str('A new handle, without the @.'),
        description: str('A new one-line description.'),
        tools: strings('The new grant, replacing the current one entirely.'),
        roles: strings('The new roles, replacing the current ones.'),
      },
      ['agent'],
    ),
    async run(args, rt) {
      const input: Record<string, unknown> = { agent: agentRef(need(args, 'agent')) };
      for (const key of ['name', 'handle', 'description'] as const) {
        const value = opt(args, key);
        if (value !== undefined) input[key] = value;
      }
      for (const key of ['tools', 'roles'] as const) {
        const value = args[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ToolRefusal(`\`${key}\` must be a list of strings.`);
        input[key] = value;
      }
      return request(rt, 'agent_update', input);
    },
  },
  {
    name: 'buddi.agent_engine',
    description: 'Move an agent to a named account and model (the account selector). An approval; the call waits for the owner.',
    write: true,
    inputSchema: object(
      { agent: str('The agent, by id or @handle.'), account: str('The account, by label or id (buddi.accounts_list).'), model: str('The model to run.') },
      ['agent', 'account', 'model'],
    ),
    async run(args, rt) {
      return request(rt, 'agent_engine', { agent: agentRef(need(args, 'agent')), account: need(args, 'account'), model: need(args, 'model') });
    },
  },
  {
    name: 'buddi.default_agent',
    description: 'Make an agent the default: the one every chat that names no agent lands on. An approval; the call waits for the owner.',
    write: true,
    inputSchema: object({ agent: str('The agent, by id or @handle.') }, ['agent']),
    async run(args, rt) {
      return request(rt, 'default_agent', { agent: agentRef(need(args, 'agent')) });
    },
  },
  {
    name: 'buddi.page_act',
    description: "A plugin page's write, through the plugin's own tool (buddi.pages_list names them). An approval; the call waits for the owner.",
    write: true,
    inputSchema: object(
      { plugin: str('The plugin.'), tool: str('The page tool, e.g. finance.set_budget.'), input: { type: 'object', description: "The tool's input." } },
      ['plugin', 'tool'],
    ),
    async run(args, rt) {
      const input = args.input ?? {};
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ToolRefusal('`input` must be an object.');
      return request(rt, 'page_act', { plugin: need(args, 'plugin'), tool: need(args, 'tool'), input });
    },
  },
  {
    name: 'buddi.proposal_decide',
    description: 'Keep or discard a proposal (buddi.proposals_list). `edited` keeps an edited text; `reason` says why it was discarded. An approval; the call waits for the owner.',
    write: true,
    inputSchema: object(
      {
        id: str('The proposal id.'),
        decision: { type: 'string', enum: ['keep', 'discard'] },
        edited: str('Optional, with keep: the text to keep instead.'),
        reason: str('Optional, with discard: why.'),
      },
      ['id', 'decision'],
    ),
    async run(args, rt) {
      const decision = need(args, 'decision');
      if (decision !== 'keep' && decision !== 'discard') throw new ToolRefusal('`decision` is keep or discard.');
      const edited = opt(args, 'edited');
      const reason = opt(args, 'reason');
      return request(rt, 'proposal_decide', {
        id: need(args, 'id'),
        decision,
        ...(edited !== undefined ? { edited } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    },
  },
  {
    name: 'buddi.memory_edit',
    description:
      "The Memory page's corrections: set_preference { key, value, scope? }, forget_preference { key, scope? }, edit_note { id, content?, scope?, kind? }, forget_note { id }. scope is shared or an agent id. An approval; the call waits for the owner.",
    write: true,
    inputSchema: object(
      {
        op: { type: 'string', enum: ['set_preference', 'forget_preference', 'edit_note', 'forget_note'] },
        key: str('The preference key, lower_snake_case.'),
        value: str('The preference value.'),
        id: str('The note id.'),
        content: str('The note text.'),
        scope: str('shared, or an agent id.'),
        kind: { type: 'string', enum: ['fact', 'observation', 'todo'] },
      },
      ['op'],
    ),
    async run(args, rt) {
      const op = need(args, 'op');
      const input: Record<string, unknown> = { op };
      for (const key of ['key', 'value', 'id', 'content', 'scope', 'kind'] as const) {
        const value = opt(args, key);
        if (value !== undefined) input[key] = value;
      }
      return request(rt, 'memory_edit', input);
    },
  },

  /* ---------------- conversation ---------------- */
  {
    name: 'buddi.ask',
    description:
      "Ask one of the owner's agents something, as the dashboard chat would: the turn runs with the agent's memory, tools and approvals, and the conversation shows on the dashboard, attributed to this client. Returns the answer and the conversation id; pass `conversation` to continue it. If the agent proposes something gated, the call waits for the owner like any write.",
    write: true,
    inputSchema: object(
      { agent: str('The agent, by id or @handle.'), message: str('What to ask.'), conversation: str('Optional: continue this conversation.') },
      ['agent', 'message'],
    ),
    async run(args, rt) {
      return ask(rt, agentRef(need(args, 'agent')), need(args, 'message'), opt(args, 'conversation'));
    },
  },
];

/* ------------------------------------------------------------------ *
 * buddi.ask
 * ------------------------------------------------------------------ */

interface Transcript {
  conversationId: string;
  agentId: string;
  messages: Array<{ id: string; role: string; blocks: Array<{ type: string; text?: string }> }>;
  runs: Array<{ runId: string | null; startedAt: string | null; finishedAt: string | null; stopped: string | null; actionId: string | null }>;
}

const textOf = (message: Transcript['messages'][number]): string =>
  message.blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');

async function ask(rt: ToolRuntime, agent: string, message: string, conversation: string | undefined): Promise<unknown> {
  const before = conversation
    ? await rt.gateway.get<Transcript>(`/api/chat/conversations/${enc(conversation)}`)
    : null;
  let sent: { status: number; body: { conversationId: string; runId: string } };
  try {
    sent = await rt.gateway.post(`/api/chat/${enc(agent)}/messages`, {
      text: message,
      client: rt.client(),
      ...(conversation ? { conversationId: conversation } : {}),
    });
  } catch (err) {
    if (err instanceof GatewayError && err.status < 500) throw new ToolRefusal(err.message);
    throw err;
  }
  const { conversationId, runId } = sent.body;
  // A rolled-over conversation is a fresh one: everything in it is new.
  const seen = before && before.conversationId === conversationId ? before.messages.length : 0;
  const deadline = rt.now() + rt.waitMs;
  await rt.progress(`@${agent} is working (conversation ${conversationId}).`);
  let waitingOn: string | null = null;
  // After an approval the resumed run can read as finished a beat before its
  // last message is persisted; an empty answer at that instant is a race, not
  // the answer. A few more polls, then it is taken as it is.
  let emptyPolls = 0;
  const EMPTY_GRACE_POLLS = 20;

  for (;;) {
    const transcript = await rt.gateway.get<Transcript>(`/api/chat/conversations/${enc(conversationId)}`);
    const mine = transcript.runs.findIndex((r) => r.runId === runId);
    const runs = mine === -1 ? [] : transcript.runs.slice(mine);
    const last = runs[runs.length - 1];
    const answer = transcript.messages
      .slice(seen)
      .filter((m) => m.role === 'assistant')
      .map(textOf)
      .filter((t) => t.trim() !== '')
      .join('\n\n');

    if (last && last.finishedAt !== null && runs.every((r) => r.finishedAt !== null)) {
      if (last.stopped === 'awaiting-approval' && last.actionId) {
        const { action } = await rt.gateway.get<{ action: ApprovalView }>(`/api/approvals/${enc(last.actionId)}`);
        if (action.state === 'pending' || action.state === 'approved' || action.state === 'executing' || !SETTLED.has(action.state)) {
          if (waitingOn !== last.actionId) {
            waitingOn = last.actionId;
            await rt.progress(`@${agent} is waiting for your approval (action ${last.actionId}): ${action.preview.split('\n')[0]}`);
          }
        } else if (action.state === 'expired') {
          return { conversationId, agent, answer, stopped: 'approval expired', actionId: last.actionId };
        }
        // Decided: the dashboard resumes the run, and a new run appears.
      } else if (answer === '' && waitingOn !== null && emptyPolls < EMPTY_GRACE_POLLS && rt.now() < deadline) {
        emptyPolls += 1;
      } else {
        return { conversationId, agent, answer, ...(last.stopped && last.stopped !== 'end_turn' ? { stopped: last.stopped } : {}) };
      }
    }
    if (rt.now() >= deadline) {
      return {
        pending: waitingOn,
        conversationId,
        agent,
        answer,
        note: waitingOn
          ? 'Still waiting for the owner to decide. The card stays open; the conversation continues on the dashboard.'
          : 'Still working after ten minutes. The conversation continues on the dashboard.',
      };
    }
    if (rt.signal?.aborted) throw new ToolRefusal('Cancelled. The turn goes on; it is on the dashboard.');
    await rt.sleep(rt.pollMs);
  }
}
