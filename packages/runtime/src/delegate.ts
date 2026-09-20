/**
 * `agent.delegate` — one agent asking another to answer a question (roadmap
 * step 5, "delegation via the queue", synchronous first cut).
 *
 * The tool runs a *nested* agent run: a new conversation for the target agent,
 * persisted exactly like any other, with the caller's task as the user message.
 * The nested run's reply comes back as text; the caller's model then uses it.
 * Nothing about the nested run is privileged — the target gets its own file's
 * tools, its own persona and the same registry, so delegation can never widen a
 * grant: an agent cannot reach a tool through a colleague that it could not
 * reach itself, because the colleague's grant is its own file's grant.
 *
 * Authorization is in code and fails closed (ARCHITECTURE.md, "Trust model"):
 *
 *  - the caller must be known (`ctx.agentId`) — an anonymous run delegates nothing;
 *  - the target must appear in the caller's allowlist, which the host reads from
 *    a file next to the agent; no allowlist means no delegation, ever;
 *  - the target must exist in the catalog — an unknown id is refused, never
 *    coerced to the default agent;
 *  - depth is capped: a delegated run carries `delegationDepth`, and the tool
 *    refuses at depth >= 1. A delegate cannot re-delegate, so a cycle cannot
 *    exist and a turn cannot fan out into a tree of runs.
 *  - the nested turn budget is capped (8) whatever the target's file says.
 *
 * One thing *is* inherited: the caller's surface profile. The delegate's
 * answer is quoted onto the caller's screen, so it must be composed for that
 * screen — a colleague writing a markdown table for a Telegram reply is a
 * broken message, not a broken colleague.
 *
 * Refusals are thrown: `ToolRegistry.invoke` turns them into an error-flagged
 * tool_result, so the calling model sees *that* it was refused and why.
 */
import { z } from 'zod';
import {
  listArtifacts,
  type AgentDefinition,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
} from '@buddi/core';
import type { RuntimeProvider } from './anthropic.js';
import { createConversation, runAgent as defaultRunAgent, type Queryable } from './loop.js';

/** The tool name. Namespaced like every other tool; the plugin family is `agent`. */
export const DELEGATE_TOOL = 'agent.delegate';

/** Turn budget for a nested run, whatever the target agent's file asks for. */
export const MAX_NESTED_TURNS = 8;

/** Depth at which delegation is refused: a delegate never delegates again. */
export const MAX_DELEGATION_DEPTH = 1;

/** What delegation needs from an agent in the catalog — `CatalogAgent` satisfies it. */
export interface DelegateAgent {
  id: string;
  /** How the owner names it: `@credo`. Returned so the caller can quote it. */
  handle: string;
  name: string;
  definition(now: Date, timezone?: string): AgentDefinition;
}

/**
 * The catalog slice delegation uses. `get` (not `resolve`) on purpose: an
 * unknown id must come back as "no such agent", never as the default one.
 */
export interface DelegateCatalog {
  get(id: string): DelegateAgent | undefined;
  list(): ReadonlyArray<{ id: string }>;
}

/** The loop entry point, injectable so tests do not need the real one. */
export type RunAgentFn = typeof defaultRunAgent;

export interface DelegateDeps {
  /**
   * Resolved lazily: the tool registry is built *before* the catalog is loaded
   * (the catalog resolves its agent files against the registry), so the tool
   * cannot hold the catalog at construction time. Throwing here is a refusal.
   */
  catalog: () => DelegateCatalog;
  /** The registry the nested run executes against — the same one, always. */
  registry: ToolRegistry;
  /**
   * Also lazy: the provider is resolved after the registry exists. It takes the
   * *target* agent, because provider choice is pinned per agent — a colleague
   * on another provider must be run on that provider, never on the caller's.
   */
  provider: (agent: DelegateAgent) => RuntimeProvider;
  /** Defaults to the caller's `ctx.db`; injected in tests. */
  pool?: Queryable;
  /** Defaults to the caller's own context (owner, clock, db). */
  ctxBase?: ToolContext;
  runAgent?: RunAgentFn;
  /** The caller's allowlist. Unknown caller or missing file: `[]`. */
  allowlistFor(agentId: string): string[];
  maxNestedTurns?: number;
  /** A one-off instruction passed to the nested run, when the host has one. */
  systemSuffix?: string;
  memoryPreamble?: (agentId: string) => Promise<string>;
}

export const delegateInput = z.object({
  agent: z.string().min(1).describe('Catalog id of the colleague to ask, e.g. credit-coach'),
  task: z
    .string()
    .min(1)
    .describe('The concrete question to answer, written as you would ask a colleague'),
  context: z
    .string()
    .optional()
    .describe('Facts the colleague needs and cannot look up itself'),
});

export type DelegateInput = z.infer<typeof delegateInput>;

export interface DelegateOutput {
  agent: string;
  /** The target's handle, without the `@`: what the answer is attributed to. */
  handle: string;
  name: string;
  conversationId: string;
  text: string;
}

/** Insert one row into the event log. Same SQL shape as the loop's. */
async function appendEvent(
  pool: Queryable,
  kind: string,
  payload: unknown,
  conversationId?: string,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)`,
    [kind, conversationId ?? null, JSON.stringify(payload ?? null)],
  );
}

/** The nested run's user message: the task, and the caller's context under it. */
export function delegationMessage(input: DelegateInput, from: string): string {
  const context = (input.context ?? '').trim();
  const header = `You are being asked a question by ${from}, another of the owner's agents. Answer it directly, with the numbers you can look up yourself. Your answer is read by ${from}, not by the owner.`;
  const body = context === '' ? input.task : `${input.task}\n\nContext from ${from}:\n${context}`;
  return `${header}\n\n${body}`;
}

export function createDelegateTool(deps: DelegateDeps): ToolDefinition<DelegateInput, DelegateOutput> {
  const maxTurns = deps.maxNestedTurns ?? MAX_NESTED_TURNS;
  const run = deps.runAgent ?? defaultRunAgent;

  return {
    name: DELEGATE_TOOL,
    description:
      'Ask another of the owner\'s agents a question and get its answer back as text. ' +
      'The colleague answers in its own fresh conversation with its own tools, and any files or images it made come back as `artifacts` you can attach or describe; it cannot ' +
      'see this one. Use it when a question belongs to a specialist you are allowed to ask. ' +
      'Quote the answer back to the owner and attribute it by the handle the result ' +
      'carries, written with an @ — "@credo says: ...".',
    tier: 'auto',
    input: delegateInput,
    async execute(input, ctx): Promise<DelegateOutput> {
      const from = ctx.agentId;
      if (!from) {
        throw new Error(
          'delegation refused: this run has no agent identity, so no allowlist applies',
        );
      }

      // A room has its own way to bring a colleague in, with a budget and a
      // shared transcript; delegation would step around both.
      if (ctx.group) {
        throw new Error(
          `delegation refused: this is a group run ("${ctx.group.name}"); ask a member through group.ask, or answer for the room`,
        );
      }

      const depth = ctx.delegationDepth ?? 0;
      if (depth >= MAX_DELEGATION_DEPTH) {
        throw new Error(
          `delegation refused: "${from}" is itself a delegated run (depth ${depth}); ` +
            'a delegate may not delegate again. Answer with what you have.',
        );
      }

      const allowed = deps.allowlistFor(from);
      if (!allowed.includes(input.agent)) {
        throw new Error(
          `delegation refused: "${from}" may not delegate to "${input.agent}" ` +
            `(allowed: ${allowed.join(', ') || 'none'})`,
        );
      }

      const catalog = deps.catalog();
      const target = catalog.get(input.agent);
      if (!target) {
        throw new Error(
          `delegation refused: unknown agent "${input.agent}" ` +
            `(installed: ${catalog.list().map((a) => a.id).join(', ') || 'none'})`,
        );
      }

      const pool = deps.pool ?? (ctx.db as unknown as Queryable);
      const base = deps.ctxBase ?? ctx;
      const now = base.now ?? ctx.now;

      const conversationId = await createConversation(pool, target.id);
      await appendEvent(
        pool,
        'delegation.started',
        { from, to: target.id, conversationId },
        ctx.conversationId ?? conversationId,
      );

      const definition = target.definition(now(), base.timezone ?? ctx.timezone);
      let result;
      try {
        result = await run({
          agent: { ...definition, maxTurns: Math.min(definition.maxTurns, maxTurns) },
          provider: deps.provider(target),
          registry: deps.registry,
          // The nested run is one level deeper, and it is the target's run: the
          // loop stamps `agentId`/`conversationId` itself.
          ctx: { ...base, delegationDepth: depth + 1, ...(ctx.signal ? { signal: ctx.signal } : {}) },
          pool,
          conversationId,
          userMessage: delegationMessage(input, from),
          // The delegate answers onto the caller's screen: its words are quoted
          // back verbatim into the same Telegram bubble or the same dashboard
          // panel. So it inherits the caller's surface profile rather than
          // being composed with none — a delegate that wrote a markdown table
          // for Telegram would break the reply that carries it.
          ...(ctx.surface ? { surface: ctx.surface } : {}),
          systemSuffix: deps.systemSuffix,
          memoryPreamble: deps.memoryPreamble,
        });
      } catch (err) {
        await appendEvent(
          pool,
          'delegation.finished',
          {
            from,
            to: target.id,
            conversationId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          ctx.conversationId ?? conversationId,
        );
        throw err;
      }

      await appendEvent(
        pool,
        'delegation.finished',
        {
          from,
          to: target.id,
          conversationId,
          ok: true,
          turns: result.turns,
          stopped: result.stopped,
        },
        ctx.conversationId ?? conversationId,
      );

      // Whatever the colleague produced travels back with its words: a poster
      // is the answer, not a sentence about a poster. Ids only; the caller
      // attaches or describes them with the artifact tools it holds.
      let artifacts: Array<{ id: string; filename: string | null; mime: string; kind: string }> = [];
      try {
        artifacts = (await listArtifacts(pool as never, { conversationId, limit: 20 })).map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, kind: a.kind }));
      } catch {
        /* The reply stands on its own; a listing that fails costs the attachments, not the answer. */
      }
      return {
        agent: target.id,
        handle: target.handle,
        name: target.name,
        conversationId,
        text: result.text,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    },
  };
}
