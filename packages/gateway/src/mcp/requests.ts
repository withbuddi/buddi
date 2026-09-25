/**
 * Writes that arrive through `buddi mcp`, as approvals (docs/mcp.md §2).
 *
 * An MCP client is a model, not the owner: whatever it reads can steer it. So
 * none of its writes applies directly. Each one is one of the gated,
 * owner-only tools below, invoked as the owner through the registry — which
 * records the ordinary action, with the exact change as its envelope and a
 * preview that opens "Requested through MCP (<client>)" — and waits for the
 * owner on the dashboard or on Telegram like every other approval.
 *
 * What an approved action runs is the function the dashboard's own route
 * calls: `updateAgentFromOwner`, the account assignment, the default-agent
 * record, the plugin page tool, keeping or discarding a proposal, the memory
 * edits. `describe` validates with the same rules first, so a refusal (a
 * hand-only tool, a taken handle) comes back at once, in the route's words,
 * and no card is ever raised for something that could not be applied.
 *
 * The tools are `ownerOnly`: no model's tool list contains them and no grant
 * can reach them. They exist only for `POST /api/mcp/request`.
 */
import {
  OWNER_AGENT_ID,
  getAction,
  getProposal,
  proposalTitle,
  type ActionRecord,
  type AgentCatalog,
  type PluginManifest,
  type CoreToolContext,
  type ToolDefinition,
  type ToolRegistry,
} from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';
import { describeOwnerAgentEdit, updateAgentFromOwner } from '../agents/platform.js';

export const MCP_PLUGIN = 'mcp';

/** The kinds `POST /api/mcp/request` accepts, one tool each. */
export const MCP_REQUEST_KINDS = [
  'agent_update',
  'agent_engine',
  'default_agent',
  'page_act',
  'proposal_decide',
  'memory_edit',
] as const;
export type McpRequestKind = (typeof MCP_REQUEST_KINDS)[number];

/** What an approved MCP write reaches. Bound by the web server that owns these. */
export interface McpBinding {
  pool: Pool;
  catalog: AgentCatalog;
  /** Named accounts, as the Providers page lists them. Absent: no accounts here. */
  accounts?: () => {
    accounts: Array<{ id: string; label: string; kind: string; enabled: boolean }>;
    bindings: Array<{ agentId: string; accountId: string; model: string }>;
  };
  /** `POST /api/agents/:id/account`. */
  assignAccount?: (agentId: string, change: { accountId: string; model: string }) => Promise<unknown>;
  /** `POST /api/agents/default`: the result, or the route's refusal as a throw. */
  setDefaultAgent: (agentId: string) => Promise<unknown>;
  /** Which agent is the default now. */
  defaultAgent: () => string | null;
  /** `POST /api/proposals/:id/keep|discard`, the result or a throw. */
  keepProposal: (id: string, text: string | undefined) => Promise<unknown>;
  discardProposal: (id: string, reason: string | undefined) => Promise<unknown>;
  /** The memory page's four edits. */
  memory: {
    setPreference: (input: { key: string; value: string; scope: string }) => Promise<unknown>;
    forgetPreference: (input: { key: string; scope: string }) => Promise<boolean>;
    updateNote: (input: { id: string; content?: string; scope?: string; kind?: string }) => Promise<unknown>;
    forgetNote: (id: string) => Promise<boolean>;
  };
}

const bindings = new WeakMap<ToolRegistry, McpBinding>();

/** Wire a registry's MCP request tools once the web server's routes exist. */
export function bindMcpRequests(registry: ToolRegistry, binding: McpBinding): void {
  bindings.set(registry, binding);
}

function bound(registry: ToolRegistry): McpBinding {
  const binding = bindings.get(registry);
  if (!binding) throw new Error('this process serves no dashboard, so an MCP request cannot be applied here');
  return binding;
}

/** The attribution every MCP write carries, on the card and in Activity. */
export function throughMcp(client: string): string {
  return `requested through MCP (${client})`;
}

const client = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w .@/:+-]+$/, 'a client name is letters, digits and simple punctuation');

/* ------------------------------------------------------------------ *
 * The inputs, one per kind
 * ------------------------------------------------------------------ */

const agentUpdateInput = z
  .object({
    client,
    agent: z.string().min(1),
    name: z.string().min(1).max(60).optional(),
    handle: z.string().min(1).optional(),
    description: z.string().min(1).max(300).optional(),
    tools: z.array(z.string().min(1)).optional(),
    roles: z.array(z.string().min(1)).optional(),
  })
  .strict();

const agentEngineInput = z
  .object({ client, agent: z.string().min(1), account: z.string().min(1), model: z.string().trim().min(1).max(150) })
  .strict();

const defaultAgentInput = z.object({ client, agent: z.string().min(1) }).strict();

const pageActInput = z
  .object({
    client,
    plugin: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    tool: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  })
  .strict();

const proposalDecideInput = z
  .object({
    client,
    id: z.string().min(1),
    decision: z.enum(['keep', 'discard']),
    edited: z.string().min(1).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

const MEMORY_KEY = /^[a-z0-9_]{1,120}$/;
const memoryEditInput = z.discriminatedUnion('op', [
  z.object({ client, op: z.literal('set_preference'), key: z.string().regex(MEMORY_KEY, 'a preference key is lower_snake_case, up to 120 characters'), value: z.string().trim().min(1).max(2000), scope: z.string().trim().min(1).optional() }).strict(),
  z.object({ client, op: z.literal('forget_preference'), key: z.string().trim().min(1), scope: z.string().trim().min(1).optional() }).strict(),
  z.object({ client, op: z.literal('edit_note'), id: z.string().uuid(), content: z.string().trim().min(1).max(2000).optional(), scope: z.string().trim().min(1).optional(), kind: z.enum(['fact', 'observation', 'todo']).optional() }).strict(),
  z.object({ client, op: z.literal('forget_note'), id: z.string().uuid() }).strict(),
]);

type AgentUpdateInput = z.infer<typeof agentUpdateInput>;
type AgentEngineInput = z.infer<typeof agentEngineInput>;
type DefaultAgentInput = z.infer<typeof defaultAgentInput>;
type PageActInput = z.infer<typeof pageActInput>;
type ProposalDecideInput = z.infer<typeof proposalDecideInput>;
type MemoryEditInput = z.infer<typeof memoryEditInput>;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function preview(input: { client: string }, lines: string[]): string {
  return [`Requested through MCP (${input.client}).`, '', ...lines].join('\n');
}

function agentOf(catalog: AgentCatalog, idOrHandle: string): { id: string; handle: string; name: string } {
  const wanted = idOrHandle.trim().replace(/^@/, '');
  const agent = catalog.get(wanted) ?? catalog.byHandle(wanted);
  if (!agent) {
    throw new Error(`there is no agent "${idOrHandle}" here (installed: ${catalog.list().map((a) => a.id).join(', ')})`);
  }
  return { id: agent.id, handle: agent.handle, name: agent.name };
}

function checkScope(catalog: AgentCatalog, scope: string): void {
  if (scope !== 'shared' && !catalog.list().some((agent) => agent.id === scope)) {
    throw new Error('The scope must be shared or an agent id.');
  }
}

function ownerCtx(ctx: CoreToolContext): CoreToolContext {
  return { ...ctx, agentId: OWNER_AGENT_ID };
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

export function createMcpManifest(registry: ToolRegistry): PluginManifest {
  const agentUpdate: ToolDefinition<AgentUpdateInput, unknown> = {
    name: 'mcp.agent_update',
    description: 'An agent file edit requested through MCP: the Setup tab\'s save, as an approval.',
    tier: 'gated',
    ownerOnly: true,
    input: agentUpdateInput,
    describe(input) {
      const { client: who, agent, ...fields } = input;
      const { envelope, preview: text } = describeOwnerAgentEdit(registry, { id: agent.trim().replace(/^@/, ''), ...fields }, `MCP (${who})`);
      return { envelope: { requestedThrough: throughMcp(who), kind: 'agent_update', change: envelope }, preview: preview(input, [text]) };
    },
    async execute(input) {
      const { client: _who, agent, ...fields } = input;
      return updateAgentFromOwner(registry, { id: agent.trim().replace(/^@/, ''), ...fields });
    },
  };

  const agentEngine: ToolDefinition<AgentEngineInput, unknown> = {
    name: 'mcp.agent_engine',
    description: 'Moving an agent to another named account and model, requested through MCP.',
    tier: 'gated',
    ownerOnly: true,
    input: agentEngineInput,
    describe(input) {
      const binding = bound(registry);
      const agent = agentOf(binding.catalog, input.agent);
      const view = binding.accounts?.();
      if (!view || !binding.assignAccount) throw new Error('this installation has no named accounts to move an agent to');
      const wanted = input.account.trim().toLowerCase();
      const account = view.accounts.find((a) => a.id === input.account.trim()) ??
        view.accounts.find((a) => a.label.trim().toLowerCase() === wanted);
      if (!account) {
        throw new Error(`there is no account "${input.account}" (accounts: ${view.accounts.map((a) => `"${a.label}"`).join(', ') || 'none'})`);
      }
      if (!account.enabled) throw new Error('Enable this account before assigning it.');
      const before = view.bindings.find((b) => b.agentId === agent.id) ?? null;
      const from = before ? `${view.accounts.find((a) => a.id === before.accountId)?.label ?? before.accountId} with ${before.model}` : 'its file\'s engine';
      return {
        envelope: {
          requestedThrough: throughMcp(input.client),
          kind: 'agent_engine',
          change: { agent: agent.id, accountId: account.id, account: account.label, model: input.model, before },
        },
        preview: preview(input, [`Run @${agent.handle} (${agent.id}) on "${account.label}" with ${input.model}.`, `Before: ${from}.`]),
      };
    },
    async execute(input) {
      const binding = bound(registry);
      const agent = agentOf(binding.catalog, input.agent);
      const view = binding.accounts!();
      const wanted = input.account.trim().toLowerCase();
      const account = view.accounts.find((a) => a.id === input.account.trim()) ??
        view.accounts.find((a) => a.label.trim().toLowerCase() === wanted)!;
      return binding.assignAccount!(agent.id, { accountId: account.id, model: input.model });
    },
  };

  const defaultAgent: ToolDefinition<DefaultAgentInput, unknown> = {
    name: 'mcp.default_agent',
    description: 'Making an agent the default, requested through MCP.',
    tier: 'gated',
    ownerOnly: true,
    input: defaultAgentInput,
    describe(input) {
      const binding = bound(registry);
      const agent = agentOf(binding.catalog, input.agent);
      const from = binding.defaultAgent();
      return {
        envelope: { requestedThrough: throughMcp(input.client), kind: 'default_agent', change: { agent: agent.id, from } },
        preview: preview(input, [
          `Make @${agent.handle} (${agent.id}) the default agent: every chat that names no agent lands on it.`,
          `Default now: ${from ?? 'none recorded'}.`,
        ]),
      };
    },
    async execute(input) {
      const binding = bound(registry);
      return binding.setDefaultAgent(agentOf(binding.catalog, input.agent).id);
    },
  };

  /*
   * A plugin page's write. The plugin's own tool describes its effect, and
   * that description is inside this action's envelope — so the executor's
   * re-description before dispatch covers the plugin's effect too, and what
   * runs is the plugin tool with exactly that envelope as its approved effect.
   * The inner tool is reached through `lookup`, the executor's accessor, only
   * from `execute`, which only the executor calls, under this approval.
   */
  const innerEffect = async (input: PageActInput, ctx: CoreToolContext) => {
    if (registry.pluginOf(input.tool) !== input.plugin || !registry.pageTools(input.plugin).includes(input.tool)) {
      throw new Error(`${input.plugin} has no page that writes through ${input.tool}.`);
    }
    const tool = registry.lookup(input.tool);
    if (!tool) throw new Error(`unknown tool: ${input.tool}`);
    const parsed = (tool.input as z.ZodTypeAny).safeParse(input.input ?? {});
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    }
    const described = tool.describe
      ? await tool.describe(parsed.data, ownerCtx(ctx))
      : { envelope: parsed.data, preview: `${tool.name} ${JSON.stringify(parsed.data ?? null)}` };
    return { tool, args: parsed.data, envelope: described.envelope, preview: described.preview };
  };

  const pageAct: ToolDefinition<PageActInput, unknown> = {
    name: 'mcp.page_act',
    description: 'A plugin page write, requested through MCP.',
    tier: 'gated',
    ownerOnly: true,
    input: pageActInput,
    async describe(input, ctx: CoreToolContext) {
      const inner = await innerEffect(input, ctx);
      return {
        envelope: {
          requestedThrough: throughMcp(input.client),
          kind: 'page_act',
          change: { plugin: input.plugin, tool: input.tool, args: inner.args, effect: inner.envelope },
        },
        preview: preview(input, [`${input.plugin} page: ${inner.preview}`]),
      };
    },
    async execute(input, ctx: CoreToolContext) {
      const inner = await innerEffect(input, ctx);
      const run = { ...ownerCtx(ctx), approvedEffect: { envelope: inner.envelope } };
      if (inner.tool.claim) await inner.tool.claim(inner.args, run);
      return inner.tool.execute(inner.args, run);
    },
  };

  const proposalDecide: ToolDefinition<ProposalDecideInput, unknown> = {
    name: 'mcp.proposal_decide',
    description: 'Keeping or discarding a proposal, requested through MCP.',
    tier: 'gated',
    ownerOnly: true,
    input: proposalDecideInput,
    async describe(input) {
      const binding = bound(registry);
      const proposal = await getProposal(binding.pool, input.id);
      if (!proposal || proposal.state !== 'open') throw new Error('That proposal is no longer open.');
      if (input.decision === 'discard' && input.edited !== undefined) throw new Error('`edited` goes with keep, not discard.');
      if (input.decision === 'keep' && input.reason !== undefined) throw new Error('`reason` goes with discard, not keep.');
      const title = proposalTitle(proposal);
      return {
        envelope: {
          requestedThrough: throughMcp(input.client),
          kind: 'proposal_decide',
          change: {
            id: proposal.id,
            kind: proposal.kind,
            agent: proposal.agent,
            title,
            decision: input.decision,
            ...(input.edited !== undefined ? { edited: input.edited } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          },
        },
        preview: preview(input, [
          `${input.decision === 'keep' ? 'Keep' : 'Discard'} ${proposal.agent}'s proposal: ${title}`,
          ...(input.edited !== undefined ? ['', 'Kept as edited:', input.edited] : []),
          ...(input.reason !== undefined ? ['', `Reason: ${input.reason}`] : []),
        ]),
      };
    },
    async execute(input) {
      const binding = bound(registry);
      return input.decision === 'keep'
        ? binding.keepProposal(input.id, input.edited)
        : binding.discardProposal(input.id, input.reason);
    },
  };

  const memoryEdit: ToolDefinition<MemoryEditInput, unknown> = {
    name: 'mcp.memory_edit',
    description: 'A Memory page correction, requested through MCP.',
    tier: 'gated',
    ownerOnly: true,
    input: memoryEditInput,
    describe(input) {
      const binding = bound(registry);
      const { client: who, ...change } = input;
      let line: string;
      switch (change.op) {
        case 'set_preference':
          checkScope(binding.catalog, change.scope ?? 'shared');
          line = `Remember the preference ${change.key} = "${change.value}" (${change.scope ?? 'shared'}).`;
          break;
        case 'forget_preference':
          line = `Forget the preference ${change.key} (${change.scope ?? 'shared'}).`;
          break;
        case 'edit_note':
          if (change.scope !== undefined) checkScope(binding.catalog, change.scope);
          if (change.content === undefined && change.scope === undefined && change.kind === undefined) {
            throw new Error('Say what changes: content, scope or kind.');
          }
          line = `Edit the note ${change.id}:${change.content !== undefined ? ` content → "${change.content}"` : ''}${change.scope !== undefined ? ` scope → ${change.scope}` : ''}${change.kind !== undefined ? ` kind → ${change.kind}` : ''}.`;
          break;
        case 'forget_note':
          line = `Forget the note ${change.id}.`;
          break;
      }
      return { envelope: { requestedThrough: throughMcp(who), kind: 'memory_edit', change }, preview: preview(input, [line]) };
    },
    async execute(input) {
      const { memory } = bound(registry);
      switch (input.op) {
        case 'set_preference':
          return memory.setPreference({ key: input.key, value: input.value, scope: input.scope ?? 'shared' });
        case 'forget_preference': {
          if (!(await memory.forgetPreference({ key: input.key, scope: input.scope ?? 'shared' }))) throw new Error('No such preference.');
          return { forgotten: true };
        }
        case 'edit_note': {
          const updated = await memory.updateNote({
            id: input.id,
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
          });
          if (!updated) throw new Error('No such note.');
          return updated;
        }
        case 'forget_note': {
          if (!(await memory.forgetNote(input.id))) throw new Error('No such note.');
          return { forgotten: true };
        }
      }
    },
  };

  return {
    name: MCP_PLUGIN,
    version: '0.1.0',
    // No tables: the only record of an MCP write is the action ledger.
    schema: 'core',
    migrationsDir: '',
    tools: [agentUpdate, agentEngine, defaultAgent, pageAct, proposalDecide, memoryEdit],
  };
}

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

export interface McpRequestDeps {
  registry: ToolRegistry;
  ctx: CoreToolContext;
  now: () => Date;
  pool: Pool;
  /** Post the new card to the owner's Telegram chat, as an unattended run's would be. */
  askApproval?: ((action: ActionRecord) => Promise<void>) | undefined;
  log?: (line: string) => void;
}

/**
 * `POST /api/mcp/request { kind, input, client }`.
 *
 * 202 `{ actionId, preview }` when the card is raised; 400 with the refusal's
 * own sentence when the change could not be applied at all.
 */
export async function requestThroughMcp(
  deps: McpRequestDeps,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const kind = body.kind;
  if (typeof kind !== 'string' || !(MCP_REQUEST_KINDS as readonly string[]).includes(kind)) {
    return { status: 400, body: { error: `\`kind\` must be one of ${MCP_REQUEST_KINDS.join(', ')}` } };
  }
  if (typeof body.client !== 'string' || body.client.trim() === '') {
    return { status: 400, body: { error: '`client` names the MCP client asking' } };
  }
  const input = body.input;
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    return { status: 400, body: { error: '`input` must be an object' } };
  }
  const tool = `mcp.${kind}`;
  const result = await deps.registry.invoke(
    tool,
    { ...(input as Record<string, unknown> | undefined), client: body.client },
    { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now },
  );
  if (result.ok) {
    // Every MCP tool is gated; an answer without an approval is a defect.
    return { status: 500, body: { error: `${tool} ran without an approval` } };
  }
  if (result.reason === 'approval-required') {
    const action = await getAction(deps.pool, result.actionId);
    if (action && deps.askApproval) {
      await deps.askApproval(action).catch((err: unknown) => {
        deps.log?.(`mcp: posting approval ${action.id} to Telegram failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return { status: 202, body: { actionId: result.actionId, preview: result.preview } };
  }
  // The refusal the owner's own route would have given, without the
  // registry's wrapper around it.
  const message = result.message.replace(/^mcp\.[a-z_]+ could not describe this effect: /, '');
  return { status: result.reason === 'unknown-tool' ? 404 : 400, body: { error: message } };
}
