/**
 * Tool registry — the only thing core knows about tools.
 *
 * Fail-closed rules (ARCHITECTURE.md, "Trust model"):
 *  - Unknown tool          -> refuse ('unknown-tool')
 *  - Invalid arguments     -> refuse ('invalid-args'), zod decides
 *  - Tier 'gated'          -> never executes here. The call becomes an immutable
 *                             action plus a pending approval, and the model is
 *                             told 'approval-required' with the action id. The
 *                             only path that ever runs it is `executeApproved`.
 *  - Tier 'draft'/'session'-> refuse ('tier-not-executable'); the machinery
 *                             those tiers need (drafts, bounded session grants)
 *                             does not exist yet.
 *  - Tool threw            -> 'tool-error'; defects never surface as success.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createAction } from './actions/store.js';
import type { ExecutableTool } from './actions/execute.js';
import type { EffectDescription, PluginManifest, Tier, ToolContext, ToolDefinition } from './tools.js';

/** Tiers this build executes directly, with no human in the loop. */
export const EXECUTABLE_TIERS: readonly Tier[] = ['auto'];

/** Tiers that become an action and wait for the owner. */
export const GATED_TIERS: readonly Tier[] = ['gated'];

export type ToolSpec = {
  name: string;
  description: string;
  tier: Tier;
  /** JSON Schema derived from the tool's zod input schema. */
  inputSchema: Record<string, unknown>;
};

export type InvokeResult<O = unknown> =
  | { ok: true; output: O }
  | {
      /**
       * The call was recorded and is waiting for the owner. Not an error and
       * not a refusal: the model is told which action it is waiting on, and the
       * run suspends until a decision arrives.
       */
      ok: false;
      reason: 'approval-required';
      actionId: string;
      preview: string;
      message: string;
    }
  | {
      ok: false;
      reason: 'unknown-tool' | 'invalid-args' | 'tier-not-executable' | 'tool-error';
      message: string;
    };

type Entry = { tool: ToolDefinition<any, any>; plugin: string; version: string };

export class ToolRegistry {
  readonly #tools = new Map<string, Entry>();
  readonly #manifests = new Map<string, PluginManifest>();

  register(manifest: PluginManifest): void {
    if (this.#manifests.has(manifest.name)) {
      throw new Error(`plugin already registered: ${manifest.name}`);
    }
    for (const tool of manifest.tools) {
      const existing = this.#tools.get(tool.name);
      if (existing) {
        throw new Error(
          `tool name collision: ${tool.name} (${existing.plugin} and ${manifest.name})`,
        );
      }
    }
    this.#manifests.set(manifest.name, manifest);
    for (const tool of manifest.tools) {
      this.#tools.set(tool.name, {
        tool,
        plugin: manifest.name,
        version: manifest.version,
      });
    }
  }

  manifests(): PluginManifest[] {
    return [...this.#manifests.values()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Tool specs for the model, in registration order. */
  list(): ToolSpec[] {
    return [...this.#tools.values()].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      tier: tool.tier,
      inputSchema: zodToJsonSchema(tool.input, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    }));
  }

  /**
   * The registered tool, for the **Executor only** (`executeApproved`).
   *
   * It hands back `execute` with no tier check, which is exactly why nothing
   * else may call it: the tier check is `invoke`, and the only legitimate
   * bypass is an approval row saying the owner said yes to this precise action.
   */
  lookup(name: string): ExecutableTool | undefined {
    const entry = this.#tools.get(name);
    if (!entry) return undefined;
    const { tool, version } = entry;
    return {
      name: tool.name,
      version,
      input: tool.input,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      execute: (input: unknown, ctx: ToolContext) => tool.execute(input, ctx),
    };
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<InvokeResult> {
    const entry = this.#tools.get(name);
    if (!entry) {
      return { ok: false, reason: 'unknown-tool', message: `unknown tool: ${name}` };
    }
    const { tool, version } = entry;

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-args',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
    }

    if (GATED_TIERS.includes(tool.tier)) {
      return this.#requestApproval(tool, version, parsed.data, ctx);
    }

    if (!EXECUTABLE_TIERS.includes(tool.tier)) {
      return {
        ok: false,
        reason: 'tier-not-executable',
        message: `tool ${name} is tier '${tool.tier}'; only ${EXECUTABLE_TIERS.join(
          ', ',
        )} executes in this build`,
      };
    }

    try {
      const output = await tool.execute(parsed.data, ctx);
      return { ok: true, output };
    } catch (err) {
      return {
        ok: false,
        reason: 'tool-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * A gated call: describe the effect, record the immutable action, ask.
   *
   * Order matters and is the whole point — the action object exists *before*
   * anyone is asked, so the preview the owner sees and the thing that can later
   * execute are the same recorded object, hash included.
   */
  async #requestApproval(
    tool: ToolDefinition<any, any>,
    version: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<InvokeResult> {
    let described: EffectDescription;
    try {
      described = tool.describe
        ? await tool.describe(args, ctx)
        : // No `describe`: the canonical arguments *are* the envelope and the
          // preview is their JSON. Honest, complete, and plainly a fallback.
          { envelope: args, preview: `${tool.name} ${JSON.stringify(args ?? null)}` };
    } catch (err) {
      return {
        ok: false,
        reason: 'tool-error',
        message: `${tool.name} could not describe this effect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    try {
      const action = await createAction(ctx.db, {
        tool: tool.name,
        toolVersion: version,
        agentId: ctx.agentId ?? 'unknown',
        conversationId: ctx.conversationId ?? null,
        jobId: ctx.jobId ?? null,
        canonicalArgs: args,
        envelope: described.envelope,
        preview: described.preview,
        now: ctx.now(),
      });
      return {
        ok: false,
        reason: 'approval-required',
        actionId: action.id,
        preview: action.preview,
        message: `awaiting owner approval (action ${action.id})`,
      };
    } catch (err) {
      // Recording the action failed, so there is nothing to approve and
      // certainly nothing to execute. Fail closed, loudly.
      return {
        ok: false,
        reason: 'tool-error',
        message: `could not record the approval request for ${tool.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}
